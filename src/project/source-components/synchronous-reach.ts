import {
  SYNCHRONOUS_CALLBACK_METHODS,
  executionUnit,
  functionEntryKey,
} from "../../core/execution-units.js";
import { calleeName, visit } from "../../core/ast.js";
import { staticPropertyPath, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { ExecutionUnit } from "../../core/execution-units.js";
import type { FunctionReferences } from "./function-references.js";
import type { LexicalBinding } from "../../core/lexical-bindings.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { functionReferences } from "./function-references.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

/** Globals that always run a handed callback later, as its own stretch. */
const DEFERRING_FUNCTIONS: ReadonlySet<string> = new Set([
  "queueMicrotask",
  "requestAnimationFrame",
  "requestIdleCallback",
  "setImmediate",
  "setInterval",
  "setTimeout",
]);

/**
 * Methods Legend gives every observable, plus the array and collection methods it proxies. Any other
 * member called on an observable is a function the application stored in it.
 */
const OBSERVABLE_METHODS: ReadonlySet<string> = new Set([
  "add",
  "assign",
  "at",
  "clear",
  "concat",
  "copyWithin",
  "delete",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "get",
  "has",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "peek",
  "pop",
  "push",
  "reduce",
  "reduceRight",
  "reverse",
  "set",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "toggle",
  "toSorted",
  "unshift",
  "values",
]);

/** Methods that register or schedule a handed callback instead of calling it. */
const DEFERRING_METHODS: ReadonlySet<string> = new Set([
  "addEventListener",
  "catch",
  "finally",
  "onChange",
  "runAfterInteractions",
  "then",
]);

const REACT_STATE_HOOKS: ReadonlySet<string> = new Set(["useReducer", "useState"]);

const PRIMITIVE_TYPE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.VoidKeyword,
]);

/** What an imported name runs when called. */
export type ImportedCallee =
  | { readonly kind: "function"; readonly declaration: RuntimeFunctionLike }
  /** Code outside the project, which reaches application code only through what it is handed. */
  | { readonly kind: "external" }
  /** A project binding whose code is not in view. */
  | { readonly kind: "unknown" };

export interface ReachResolver {
  readonly importedCallee: (
    sourceFile: ts.SourceFile,
    binding: Extract<LexicalBinding, { kind: "import" }>,
  ) => ImportedCallee;
  /** Whether a receiver path names a Legend observable, whose methods run no application code. */
  readonly isObservablePath: (sourceFile: ts.SourceFile, path: readonly string[]) => boolean;
}

/** A value passed to a project function, as far as calling that parameter is concerned. */
export type HandedValue =
  /** A function literal exists only as this argument; a named function may also run elsewhere. */
  | { readonly kind: "function"; readonly entry: string; readonly literal: boolean }
  /** One of the calling function's own parameters, forwarded unchanged. */
  | { readonly kind: "parameter"; readonly index: number }
  /** A binding that may hold a function whose code is not in view. */
  | { readonly kind: "unknown" }
  | { readonly kind: "data" };

/** A call of a project function, whose parameters it may call before returning. */
export interface Handoff {
  readonly callee: string;
  readonly values: readonly HandedValue[];
}

/**
 * The synchronous call graph of one file, at execution-unit granularity. A unit runs every entry
 * it has an edge to before its stretch ends; an opaque unit calls application code that is not in
 * view, so it may write anything. Calling a parameter runs whatever each caller hands over, so it
 * is resolved per call site through the handoffs.
 */
export interface FileReach extends FunctionReferences {
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly opaque: ReadonlySet<string>;
  readonly parameterCalls: ReadonlyMap<string, ReadonlySet<number>>;
  readonly handoffs: ReadonlyMap<string, readonly Handoff[]>;
  readonly units: ReadonlyMap<string, ExecutionUnit>;
}

interface CallReach {
  readonly entries: readonly string[];
  readonly handoff: Handoff | null;
  readonly opaque: boolean;
  readonly parameters: readonly number[];
}

const INERT: CallReach = { entries: [], handoff: null, opaque: false, parameters: [] };
const OPAQUE: CallReach = { ...INERT, opaque: true };

interface ReachBuilder {
  readonly edges: Map<string, Set<string>>;
  readonly handoffs: Map<string, Handoff[]>;
  readonly opaque: Set<string>;
  readonly parameterCalls: Map<string, Set<number>>;
  readonly units: Map<string, ExecutionUnit>;
}

interface CallContext {
  readonly call: ts.CallExpression;
  readonly resolver: ReachResolver;
  readonly unit: ExecutionUnit;
}

export function fileReach(sourceFile: ts.SourceFile, resolver: ReachResolver): FileReach {
  const reach: ReachBuilder = {
    edges: new Map(),
    handoffs: new Map(),
    opaque: new Set(),
    parameterCalls: new Map(),
    units: new Map(),
  };
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const unit = executionUnit(node);
    if (!unit.atModuleLoad) {
      recordCall(reach, unit, callReach({ call: node, resolver, unit }));
    }
  });
  return { ...reach, ...functionReferences(sourceFile, resolver) };
}

function recordCall(reach: ReachBuilder, unit: ExecutionUnit, call: CallReach): void {
  reach.units.set(unit.key, unit);
  if (call.opaque) {
    reach.opaque.add(unit.key);
  }
  addAll(reach.edges, unit.key, call.entries);
  addAll(reach.parameterCalls, unit.key, call.parameters);
  if (call.handoff) {
    reach.handoffs.set(unit.key, [...(reach.handoffs.get(unit.key) ?? []), call.handoff]);
  }
}

function addAll<Value>(sets: Map<string, Set<Value>>, key: string, values: readonly Value[]): void {
  const set = sets.get(key) ?? new Set<Value>();
  for (const value of values) {
    set.add(value);
  }
  sets.set(key, set);
}

function callReach(context: CallContext): CallReach {
  const callee = unwrapTransparentExpression(context.call.expression);
  if (ts.isIdentifier(callee)) {
    return identifierCallReach(context, callee);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return methodCallReach(context, callee);
  }
  return callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword
    ? INERT
    : OPAQUE;
}

function identifierCallReach(context: CallContext, callee: ts.Identifier): CallReach {
  const binding = lexicalBinding(callee);
  if (binding?.kind === "function") {
    return projectCallReach(context, binding.declaration);
  }
  if (binding?.kind === "import") {
    return importedCallReach(context, binding);
  }
  if (binding?.kind === "value") {
    return valueCallReach(context.unit, binding.declaration, callee.text);
  }
  return DEFERRING_FUNCTIONS.has(callee.text) ? INERT : handedFunctions(context);
}

function projectCallReach(context: CallContext, declaration: RuntimeFunctionLike): CallReach {
  const callee = functionEntryKey(declaration);
  return {
    ...INERT,
    entries: [callee],
    handoff: {
      callee,
      values: context.call.arguments.map((argument) => handedValue(context, argument)),
    },
  };
}

function importedCallReach(
  context: CallContext,
  binding: Extract<LexicalBinding, { kind: "import" }>,
): CallReach {
  const imported = context.resolver.importedCallee(context.call.getSourceFile(), binding);
  if (imported.kind === "function") {
    return projectCallReach(context, imported.declaration);
  }
  return imported.kind === "external" ? handedFunctions(context) : OPAQUE;
}

function valueCallReach(unit: ExecutionUnit, declaration: ts.Node, name: string): CallReach {
  const index = ownParameterIndex(unit, declaration);
  if (index !== null) {
    return { ...INERT, parameters: [index] };
  }
  return isReactStateSetter(declaration, name) ? INERT : OPAQUE;
}

function methodCallReach(context: CallContext, callee: ts.PropertyAccessExpression): CallReach {
  const method = callee.name.text;
  if (DEFERRING_METHODS.has(method)) {
    return INERT;
  }
  if (isObservableReceiver(context, callee.expression)) {
    return OBSERVABLE_METHODS.has(method) ? handedFunctions(context) : OPAQUE;
  }
  return receiverMethodReach(context, receiverRoot(callee.expression));
}

function receiverMethodReach(context: CallContext, root: ts.Node | null): CallReach {
  if (root?.kind === ts.SyntaxKind.ThisKeyword) {
    return OPAQUE;
  }
  const binding = root && ts.isIdentifier(root) ? lexicalBinding(root) : null;
  if (binding?.kind === "import") {
    return importIs(context, binding, "external") ? handedFunctions(context) : OPAQUE;
  }
  return binding?.kind === "function" ? OPAQUE : handedFunctions(context);
}

function isObservableReceiver(context: CallContext, receiver: ts.Expression): boolean {
  const path = staticPropertyPath(receiver);
  return path !== null && context.resolver.isObservablePath(context.call.getSourceFile(), path);
}

function receiverRoot(expression: ts.Expression): ts.Node | null {
  let current = unwrapTransparentExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapTransparentExpression(current.expression);
  }
  return ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword ? current : null;
}

/**
 * Code whose body is not in view but cannot name application observables still runs every
 * function it is handed, possibly before returning, so those functions join the caller's stretch.
 * Callbacks of synchronous iteration methods already share the caller's unit.
 */
function handedFunctions(context: CallContext): CallReach {
  const inlined = SYNCHRONOUS_CALLBACK_METHODS.has(calleeName(context.call.expression) ?? "");
  const handed = context.call.arguments.map((argument) => handedValue(context, argument));
  return {
    entries: handed.flatMap((value) =>
      value.kind === "function" && !(inlined && value.literal) ? [value.entry] : [],
    ),
    handoff: null,
    opaque: context.call.arguments.some((argument) => isUnknownImport(context, argument)),
    parameters: handed.flatMap((value) => (value.kind === "parameter" ? [value.index] : [])),
  };
}

function handedValue(context: CallContext, argument: ts.Expression): HandedValue {
  const value = unwrapTransparentExpression(argument);
  if (isFunctionLiteral(value)) {
    return { entry: functionEntryKey(value), kind: "function", literal: true };
  }
  return ts.isIdentifier(value) ? handedBinding(context, lexicalBinding(value)) : { kind: "data" };
}

function handedBinding(context: CallContext, binding: LexicalBinding | null): HandedValue {
  if (binding?.kind === "value") {
    if (hasPrimitiveType(binding.declaration)) {
      return { kind: "data" };
    }
    const index = ownParameterIndex(context.unit, binding.declaration);
    return index === null ? { kind: "unknown" } : { index, kind: "parameter" };
  }
  if (binding?.kind === "function") {
    return { entry: functionEntryKey(binding.declaration), kind: "function", literal: false };
  }
  return binding?.kind === "import" ? handedImport(context, binding) : { kind: "data" };
}

/** A binding declared with a type no function satisfies holds data, whatever value it receives. */
function hasPrimitiveType(declaration: ts.Node): boolean {
  const type =
    ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)
      ? declaration.type
      : undefined;
  return type !== undefined && isPrimitiveType(type);
}

function isPrimitiveType(type: ts.TypeNode): boolean {
  if (ts.isUnionTypeNode(type)) {
    return type.types.every((member) => isPrimitiveType(member));
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return isPrimitiveType(type.type);
  }
  return (
    ts.isLiteralTypeNode(type) ||
    ts.isTemplateLiteralTypeNode(type) ||
    PRIMITIVE_TYPE_KINDS.has(type.kind)
  );
}

function handedImport(
  context: CallContext,
  binding: Extract<LexicalBinding, { kind: "import" }>,
): HandedValue {
  const imported = context.resolver.importedCallee(context.call.getSourceFile(), binding);
  if (imported.kind === "function") {
    return { entry: functionEntryKey(imported.declaration), kind: "function", literal: false };
  }
  return imported.kind === "unknown" ? { kind: "unknown" } : { kind: "data" };
}

function isUnknownImport(context: CallContext, argument: ts.Expression): boolean {
  const value = unwrapTransparentExpression(argument);
  const binding = ts.isIdentifier(value) ? lexicalBinding(value) : null;
  return binding?.kind === "import" && importIs(context, binding, "unknown");
}

function importIs(
  context: CallContext,
  binding: Extract<LexicalBinding, { kind: "import" }>,
  kind: ImportedCallee["kind"],
): boolean {
  return context.resolver.importedCallee(context.call.getSourceFile(), binding).kind === kind;
}

function isFunctionLiteral(value: ts.Node): value is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value);
}

/** The position of a plainly named parameter of the function that starts this stretch. */
function ownParameterIndex(unit: ExecutionUnit, declaration: ts.Node): number | null {
  if (!ts.isParameter(declaration) || !ts.isIdentifier(declaration.name) || unit.resumed) {
    return null;
  }
  const owner = declaration.parent;
  return functionEntryKey(owner) === unit.entry ? owner.parameters.indexOf(declaration) : null;
}

/** React state setters schedule a render; they never run application code synchronously. */
function isReactStateSetter(declaration: ts.Node, name: string): boolean {
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isArrayBindingPattern(declaration.name) ||
    !declaration.initializer
  ) {
    return false;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  const [, setter] = declaration.name.elements;
  return (
    ts.isCallExpression(initializer) &&
    REACT_STATE_HOOKS.has(calleeName(initializer.expression) ?? "") &&
    setter !== undefined &&
    ts.isBindingElement(setter) &&
    ts.isIdentifier(setter.name) &&
    setter.name.text === name
  );
}
