import {
  NUMBER_RECEIVER,
  OBJECT_RECEIVER,
  STRING_RECEIVER,
  arrayOf,
  classReceiver,
  globalCollectionReceiver,
  propertyType,
  sameReceiver,
  typeReceiver,
} from "./receiver-types.js";
import {
  hookCallName,
  outermostTransparentParent,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { Receiver } from "./receiver-types.js";
import { isConstDeclaration } from "../../core/binding-references.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

/** The argument a built-in invokes, and how many of its leading parameters receive elements. */
interface InvokedCallback {
  readonly argument: number;
  readonly elementParameters: number;
}

/** `receiver` keeps the receiver's kind, and `element` is one of its elements. */
type MethodResult = Receiver | "element" | "receiver" | null;

interface ReadMethod {
  readonly callback?: InvokedCallback;
  readonly result: MethodResult;
}

interface ResolvedRead {
  readonly method: ReadMethod;
  readonly result: Receiver | null;
}

/** Bounds alias and call-chain hops, so a cyclic `const` pair cannot recurse forever. */
const MAX_RECEIVER_HOPS = 8;

const ELEMENT_CALLBACK: InvokedCallback = { argument: 0, elementParameters: 1 };
const COMPARATOR_CALLBACK: InvokedCallback = { argument: 0, elementParameters: 2 };
const REPLACER_CALLBACK: InvokedCallback = { argument: 1, elementParameters: 0 };
const UNKNOWN_ARRAY = arrayOf(null);

const ARRAY_READ_METHODS: ReadonlyMap<string, ReadMethod> = new Map<string, ReadMethod>([
  ["at", { result: "element" }],
  ["concat", { result: UNKNOWN_ARRAY }],
  ["entries", { result: null }],
  ["every", { callback: ELEMENT_CALLBACK, result: null }],
  ["filter", { callback: ELEMENT_CALLBACK, result: "receiver" }],
  ["find", { callback: ELEMENT_CALLBACK, result: "element" }],
  ["findIndex", { callback: ELEMENT_CALLBACK, result: NUMBER_RECEIVER }],
  ["findLast", { callback: ELEMENT_CALLBACK, result: "element" }],
  ["flat", { result: UNKNOWN_ARRAY }],
  ["flatMap", { callback: ELEMENT_CALLBACK, result: UNKNOWN_ARRAY }],
  ["includes", { result: null }],
  ["indexOf", { result: NUMBER_RECEIVER }],
  ["join", { result: STRING_RECEIVER }],
  ["keys", { result: null }],
  ["lastIndexOf", { result: NUMBER_RECEIVER }],
  ["map", { callback: ELEMENT_CALLBACK, result: UNKNOWN_ARRAY }],
  ["slice", { result: "receiver" }],
  ["some", { callback: ELEMENT_CALLBACK, result: null }],
  ["toSorted", { callback: COMPARATOR_CALLBACK, result: "receiver" }],
  ["toString", { result: STRING_RECEIVER }],
  ["values", { result: null }],
]);

const STRING_READ_METHODS: ReadonlyMap<string, ReadMethod> = new Map<string, ReadMethod>([
  ["at", { result: STRING_RECEIVER }],
  ["charAt", { result: STRING_RECEIVER }],
  ["concat", { result: STRING_RECEIVER }],
  ["endsWith", { result: null }],
  ["includes", { result: null }],
  ["indexOf", { result: NUMBER_RECEIVER }],
  ["lastIndexOf", { result: NUMBER_RECEIVER }],
  ["localeCompare", { result: NUMBER_RECEIVER }],
  ["padEnd", { result: STRING_RECEIVER }],
  ["padStart", { result: STRING_RECEIVER }],
  ["replace", { callback: REPLACER_CALLBACK, result: STRING_RECEIVER }],
  ["replaceAll", { callback: REPLACER_CALLBACK, result: STRING_RECEIVER }],
  ["slice", { result: STRING_RECEIVER }],
  ["split", { result: arrayOf(STRING_RECEIVER) }],
  ["startsWith", { result: null }],
  ["substring", { result: STRING_RECEIVER }],
  ["toLocaleLowerCase", { result: STRING_RECEIVER }],
  ["toLocaleUpperCase", { result: STRING_RECEIVER }],
  ["toLowerCase", { result: STRING_RECEIVER }],
  ["toString", { result: STRING_RECEIVER }],
  ["toUpperCase", { result: STRING_RECEIVER }],
  ["trim", { result: STRING_RECEIVER }],
]);

const NUMBER_READ_METHODS: ReadonlyMap<string, ReadMethod> = new Map<string, ReadMethod>([
  ["toFixed", { result: STRING_RECEIVER }],
  ["toString", { result: STRING_RECEIVER }],
]);

const SET_READ_METHODS: ReadonlyMap<string, ReadMethod> = new Map<string, ReadMethod>([
  ["entries", { result: null }],
  ["has", { result: null }],
  ["keys", { result: null }],
  ["values", { result: null }],
]);

const MAP_READ_METHODS: ReadonlyMap<string, ReadMethod> = new Map<string, ReadMethod>([
  ...SET_READ_METHODS,
  ["get", { result: null }],
]);

const RECEIVER_READ_METHODS = {
  array: ARRAY_READ_METHODS,
  map: MAP_READ_METHODS,
  number: NUMBER_READ_METHODS,
  object: new Map<string, ReadMethod>(),
  set: SET_READ_METHODS,
  string: STRING_READ_METHODS,
} as const satisfies Record<Receiver["kind"], ReadonlyMap<string, ReadMethod>>;

const READ_METHOD_NAMES: ReadonlySet<string> = new Set(
  Object.values(RECEIVER_READ_METHODS).flatMap((methods) => [...methods.keys()]),
);

const GLOBAL_CONVERSIONS: ReadonlyMap<string, ReadMethod> = new Map<string, ReadMethod>([
  ["Boolean", { result: null }],
  ["Number", { result: NUMBER_RECEIVER }],
  ["String", { result: STRING_RECEIVER }],
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
 * A global conversion, a deterministic `Math` function, or a read-only built-in method on a
 * receiver whose type is proven from literals, written types, `useState` declarations, or earlier
 * read-only calls. Every callback the built-in invokes must itself be proven pure.
 */
export function isBuiltinReadCall(call: ts.CallExpression, proof: BuiltinCallbackProof): boolean {
  const read = builtinRead(call, MAX_RECEIVER_HOPS);
  return read !== null && invokesPureCallback(call, read.method, proof);
}

/** A read-only built-in method of a receiver whose kind the caller proved by other means. */
export function isReceiverReadCall(
  call: ts.CallExpression,
  receiver: Receiver,
  proof: BuiltinCallbackProof,
): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  const method = ts.isPropertyAccessExpression(callee)
    ? RECEIVER_READ_METHODS[receiver.kind].get(callee.name.text)
    : undefined;
  return method !== undefined && invokesPureCallback(call, method, proof);
}

function invokesPureCallback(
  call: ts.CallExpression,
  { callback }: ReadMethod,
  proof: BuiltinCallbackProof,
): boolean {
  const argument = callback === undefined ? undefined : call.arguments[callback.argument];
  return argument === undefined || isPureCallbackArgument(argument, proof);
}

/**
 * Whether the receiver's proven kind reads through this method without mutating anything; null
 * when the receiver's type is not proven, so the method may belong to any built-in.
 */
export function receiverReadsMethod(callee: ts.PropertyAccessExpression): boolean | null {
  const receiver = receiverKind(callee.expression, MAX_RECEIVER_HOPS);
  return receiver ? RECEIVER_READ_METHODS[receiver.kind].has(callee.name.text) : null;
}

/** A method name that some built-in receiver reads through without mutating anything. */
export function isBuiltinReadMethodName(name: string): boolean {
  return READ_METHOD_NAMES.has(name);
}

/** A string argument is a value, never a callback the built-in invokes. */
function isPureCallbackArgument(argument: ts.Expression, proof: BuiltinCallbackProof): boolean {
  const callback = unwrapTransparentExpression(argument);
  if (ts.isStringLiteralLike(callback) || ts.isTemplateExpression(callback)) {
    return true;
  }
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

function builtinRead(call: ts.CallExpression, hops: number): ResolvedRead | null {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const conversion = GLOBAL_CONVERSIONS.get(callee.text);
    return conversion && lexicalBinding(callee) === null ? resolvedRead(conversion, null) : null;
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  return isMathCall(callee)
    ? { method: { result: NUMBER_RECEIVER }, result: NUMBER_RECEIVER }
    : prototypeRead(callee, hops);
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

function prototypeRead(callee: ts.PropertyAccessExpression, hops: number): ResolvedRead | null {
  const receiver = receiverKind(callee.expression, hops);
  const method = receiver ? RECEIVER_READ_METHODS[receiver.kind].get(callee.name.text) : undefined;
  return method ? resolvedRead(method, receiver) : null;
}

function resolvedRead(method: ReadMethod, receiver: Receiver | null): ResolvedRead {
  const { result } = method;
  if (result === "receiver") {
    return { method, result: receiver };
  }
  if (result === "element") {
    return { method, result: arrayElement(receiver) };
  }
  return { method, result };
}

function arrayElement(receiver: Receiver | null): Receiver | null {
  return receiver?.kind === "array" ? receiver.element : null;
}

function receiverKind(expression: ts.Expression, hops: number): Receiver | null {
  const value = unwrapTransparentExpression(expression);
  return literalKind(value, hops) ?? (hops > 0 ? derivedReceiverKind(value, hops - 1) : null);
}

function literalKind(value: ts.Expression, hops: number): Receiver | null {
  if (ts.isArrayLiteralExpression(value)) {
    return arrayOf(elementsKind(value.elements, hops));
  }
  if (ts.isNewExpression(value)) {
    return constructedKind(value);
  }
  if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) {
    return STRING_RECEIVER;
  }
  if (ts.isNumericLiteral(value)) {
    return NUMBER_RECEIVER;
  }
  return ts.isObjectLiteralExpression(value) ||
    ts.isArrowFunction(value) ||
    ts.isFunctionExpression(value) ||
    ts.isClassExpression(value)
    ? OBJECT_RECEIVER
    : null;
}

function elementsKind(elements: ts.NodeArray<ts.Expression>, hops: number): Receiver | null {
  const [first, ...rest] = elements.map((element) =>
    ts.isSpreadElement(element) || ts.isOmittedExpression(element)
      ? null
      : receiverKind(element, hops),
  );
  return first !== undefined && rest.every((kind) => sameReceiver(first, kind)) ? first : null;
}

function constructedKind(construction: ts.NewExpression): Receiver | null {
  const constructor = unwrapTransparentExpression(construction.expression);
  if (!ts.isIdentifier(constructor)) {
    return null;
  }
  const binding = lexicalBinding(constructor);
  if (binding === null) {
    return globalCollectionReceiver(constructor.text);
  }
  return binding.kind === "value" && ts.isClassDeclaration(binding.declaration)
    ? classReceiver(binding.declaration)
    : null;
}

function derivedReceiverKind(value: ts.Expression, hops: number): Receiver | null {
  if (ts.isCallExpression(value)) {
    return builtinRead(value, hops)?.result ?? null;
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
  return sameReceiver(kind, receiverKind(right, hops)) ? kind : null;
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
  return element ? destructuredKind(declaration, element, hops) : null;
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
    return typeReceiver(declaration.type);
  }
  if (ts.isParameter(declaration)) {
    return callbackElementKind(declaration, hops);
  }
  return isConstDeclaration(declaration) && declaration.initializer
    ? receiverKind(declaration.initializer, hops)
    : null;
}

/** An untyped parameter of a callback a built-in array read invokes with its elements. */
function callbackElementKind(parameter: ts.ParameterDeclaration, hops: number): Receiver | null {
  const callback = parameter.parent;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    return null;
  }
  const argument = outermostTransparentParent(callback);
  const call = argument.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
    return null;
  }
  const invoked = ARRAY_READ_METHODS.get(call.expression.name.text)?.callback;
  return invoked &&
    call.arguments[invoked.argument] === argument &&
    callback.parameters.indexOf(parameter) < invoked.elementParameters
    ? arrayElement(receiverKind(call.expression.expression, hops))
    : null;
}

/** The value of `const [value] = useState(...)`, or a field of a parameter with a written type. */
function destructuredKind(
  declaration: ts.ParameterDeclaration | ts.VariableDeclaration,
  element: ts.BindingElement,
  hops: number,
): Receiver | null {
  const pattern = element.parent;
  if (ts.isArrayBindingPattern(pattern)) {
    const state = declaration.initializer;
    return pattern.elements[0] === element &&
      ts.isVariableDeclaration(declaration) &&
      state &&
      ts.isCallExpression(state) &&
      hookCallName(state) === "useState"
      ? stateKind(state, hops)
      : null;
  }
  const field = element.propertyName?.getText() ?? element.name.getText();
  const type =
    ts.isParameter(declaration) && declaration.type ? propertyType(declaration.type, field) : null;
  return type ? typeReceiver(type) : null;
}

function stateKind(call: ts.CallExpression, hops: number): Receiver | null {
  const [type] = call.typeArguments ?? [];
  if (type) {
    return typeReceiver(type);
  }
  const [initial] = call.arguments;
  return initial && !ts.isFunctionLike(initial) ? receiverKind(initial, hops) : null;
}
