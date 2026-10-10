import { hookCallName, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { isConstDeclaration } from "../../core/binding-references.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

type Receiver = "array" | "string";

interface ReadMethod {
  readonly callbackIndex?: number;
  readonly result: Receiver | null;
}

/** Bounds alias and call-chain hops, so a cyclic `const` pair cannot recurse forever. */
const MAX_RECEIVER_HOPS = 8;

const ARRAY_READ_METHODS: ReadonlyMap<string, ReadMethod> = new Map([
  ["at", { result: null }],
  ["concat", { result: "array" }],
  ["every", { callbackIndex: 0, result: null }],
  ["filter", { callbackIndex: 0, result: "array" }],
  ["find", { callbackIndex: 0, result: null }],
  ["findIndex", { callbackIndex: 0, result: null }],
  ["findLast", { callbackIndex: 0, result: null }],
  ["flat", { result: "array" }],
  ["flatMap", { callbackIndex: 0, result: "array" }],
  ["includes", { result: null }],
  ["indexOf", { result: null }],
  ["join", { result: "string" }],
  ["lastIndexOf", { result: null }],
  ["map", { callbackIndex: 0, result: "array" }],
  ["slice", { result: "array" }],
  ["some", { callbackIndex: 0, result: null }],
  ["toSorted", { callbackIndex: 0, result: "array" }],
]);

const STRING_READ_METHODS: ReadonlyMap<string, ReadMethod> = new Map([
  ["at", { result: "string" }],
  ["charAt", { result: "string" }],
  ["concat", { result: "string" }],
  ["endsWith", { result: null }],
  ["includes", { result: null }],
  ["indexOf", { result: null }],
  ["lastIndexOf", { result: null }],
  ["localeCompare", { result: null }],
  ["padEnd", { result: "string" }],
  ["padStart", { result: "string" }],
  ["slice", { result: "string" }],
  ["split", { result: "array" }],
  ["startsWith", { result: null }],
  ["substring", { result: "string" }],
  ["toLocaleLowerCase", { result: "string" }],
  ["toLocaleUpperCase", { result: "string" }],
  ["toLowerCase", { result: "string" }],
  ["toUpperCase", { result: "string" }],
  ["trim", { result: "string" }],
]);

const RECEIVER_READ_METHODS = {
  array: ARRAY_READ_METHODS,
  string: STRING_READ_METHODS,
} as const satisfies Record<Receiver, ReadonlyMap<string, ReadMethod>>;

const GLOBAL_CONVERSIONS: ReadonlyMap<string, ReadMethod> = new Map([
  ["Boolean", { result: null }],
  ["Number", { result: null }],
  ["String", { result: "string" }],
]);

/** Deterministic `Math` functions; `Math.random` is deliberately absent. */
const MATH_FUNCTIONS: ReadonlySet<string> = new Set([
  "abs",
  "ceil",
  "exp",
  "floor",
  "max",
  "min",
  "round",
  "trunc",
]);

export interface BuiltinCallbackProof {
  readonly isPureCallback: (callback: ts.ArrowFunction | ts.FunctionExpression) => boolean;
  readonly isPureCallee: (callee: ts.Identifier) => boolean;
}

/**
 * A global conversion, a deterministic `Math` function, or a read-only array or string method on
 * a receiver whose type is proven from literals, written types, `useState` declarations, or
 * earlier read-only calls. Every callback the built-in invokes must itself be proven pure.
 */
export function isBuiltinReadCall(call: ts.CallExpression, proof: BuiltinCallbackProof): boolean {
  const method = builtinReadMethod(call, MAX_RECEIVER_HOPS);
  if (!method) {
    return false;
  }
  const callback =
    method.callbackIndex === undefined ? undefined : call.arguments[method.callbackIndex];
  return callback === undefined || isPureCallbackArgument(callback, proof);
}

function isPureCallbackArgument(argument: ts.Expression, proof: BuiltinCallbackProof): boolean {
  const callback = unwrapTransparentExpression(argument);
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    return (
      callback.asteriskToken === undefined &&
      !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
      proof.isPureCallback(callback)
    );
  }
  return (
    ts.isIdentifier(callback) &&
    ((GLOBAL_CONVERSIONS.has(callback.text) && lexicalBinding(callback) === null) ||
      proof.isPureCallee(callback))
  );
}

function builtinReadMethod(call: ts.CallExpression, hops: number): ReadMethod | null {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const conversion = GLOBAL_CONVERSIONS.get(callee.text);
    return conversion && lexicalBinding(callee) === null ? conversion : null;
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  return isMathCall(callee) ? { result: null } : prototypeRead(callee, hops);
}

function isMathCall(callee: ts.PropertyAccessExpression): boolean {
  const namespace = unwrapTransparentExpression(callee.expression);
  return (
    ts.isIdentifier(namespace) &&
    namespace.text === "Math" &&
    MATH_FUNCTIONS.has(callee.name.text) &&
    lexicalBinding(namespace) === null
  );
}

function prototypeRead(callee: ts.PropertyAccessExpression, hops: number): ReadMethod | null {
  const receiver = receiverKind(callee.expression, hops);
  return receiver ? (RECEIVER_READ_METHODS[receiver].get(callee.name.text) ?? null) : null;
}

function receiverKind(expression: ts.Expression, hops: number): Receiver | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrayLiteralExpression(value)) {
    return "array";
  }
  if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) {
    return "string";
  }
  return hops > 0 ? derivedReceiverKind(value, hops - 1) : null;
}

function derivedReceiverKind(value: ts.Expression, hops: number): Receiver | null {
  if (ts.isCallExpression(value)) {
    return builtinReadMethod(value, hops)?.result ?? null;
  }
  if (ts.isIdentifier(value)) {
    return identifierKind(value, hops);
  }
  if (ts.isConditionalExpression(value)) {
    return sharedKind(value.whenTrue, value.whenFalse, hops);
  }
  return ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ? sharedKind(value.left, value.right, hops)
    : null;
}

function sharedKind(left: ts.Expression, right: ts.Expression, hops: number): Receiver | null {
  const kind = receiverKind(left, hops);
  return kind === receiverKind(right, hops) ? kind : null;
}

function identifierKind(identifier: ts.Identifier, hops: number): Receiver | null {
  const binding = lexicalBinding(identifier);
  const declaration = binding?.kind === "value" ? binding.declaration : null;
  if (!declaration || (!ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration))) {
    return null;
  }
  if (ts.isIdentifier(declaration.name)) {
    return declaredKind(declaration, hops);
  }
  const element = namedBindingElement(declaration.name, identifier.text);
  return element ? destructuredKind(declaration, element) : null;
}

function namedBindingElement(pattern: ts.BindingPattern, name: string): ts.BindingElement | null {
  for (const element of pattern.elements) {
    if (
      ts.isBindingElement(element) &&
      ts.isIdentifier(element.name) &&
      element.name.text === name &&
      !element.dotDotDotToken
    ) {
      return element;
    }
  }
  return null;
}

function declaredKind(
  declaration: ts.ParameterDeclaration | ts.VariableDeclaration,
  hops: number,
): Receiver | null {
  if (declaration.type) {
    return typeKind(declaration.type);
  }
  return ts.isVariableDeclaration(declaration) &&
    isConstDeclaration(declaration) &&
    declaration.initializer
    ? receiverKind(declaration.initializer, hops)
    : null;
}

/** The value of `const [value] = useState(...)`, or a field of a parameter typed by a literal. */
function destructuredKind(
  declaration: ts.ParameterDeclaration | ts.VariableDeclaration,
  element: ts.BindingElement,
): Receiver | null {
  const pattern = element.parent;
  if (ts.isArrayBindingPattern(pattern)) {
    const state = declaration.initializer;
    return pattern.elements[0] === element &&
      ts.isVariableDeclaration(declaration) &&
      state &&
      ts.isCallExpression(state) &&
      hookCallName(state) === "useState"
      ? stateKind(state)
      : null;
  }
  const field = element.propertyName?.getText() ?? element.name.getText();
  const member =
    ts.isParameter(declaration) && declaration.type && ts.isTypeLiteralNode(declaration.type)
      ? declaration.type.members.find(
          (candidate): candidate is ts.PropertySignature =>
            ts.isPropertySignature(candidate) && candidate.name.getText() === field,
        )
      : undefined;
  return member?.type ? typeKind(member.type) : null;
}

function stateKind(call: ts.CallExpression): Receiver | null {
  const [type] = call.typeArguments ?? [];
  if (type) {
    return typeKind(type);
  }
  const [initial] = call.arguments;
  return initial && !ts.isFunctionLike(initial) ? receiverKind(initial, 0) : null;
}

function typeKind(type: ts.TypeNode): Receiver | null {
  if (
    ts.isParenthesizedTypeNode(type) ||
    (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword)
  ) {
    return typeKind(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return unionKind(type);
  }
  if (
    ts.isArrayTypeNode(type) ||
    ts.isTupleTypeNode(type) ||
    (ts.isTypeReferenceNode(type) && ["Array", "ReadonlyArray"].includes(type.typeName.getText()))
  ) {
    return "array";
  }
  return type.kind === ts.SyntaxKind.StringKeyword ||
    ts.isTemplateLiteralTypeNode(type) ||
    (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal))
    ? "string"
    : null;
}

/** A union whose members share one kind once `null` and `undefined` are set aside. */
function unionKind(type: ts.UnionTypeNode): Receiver | null {
  const kinds = new Set(
    type.types.filter((member) => !isNullishType(member)).map((member) => typeKind(member)),
  );
  const [kind] = kinds;
  return kinds.size === 1 && kind !== undefined ? kind : null;
}

function isNullishType(type: ts.TypeNode): boolean {
  return (
    type.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}
