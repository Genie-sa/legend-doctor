import type { MemoCaptureScan, ValueChange } from "./model.js";
import {
  findAncestor,
  identifiersNamed,
  isRuntimeFunctionLike,
  lineOf,
  nodeWithin,
} from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { declaresObservableProp } from "../../practices/observable-prop-types.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { renderIterationCall } from "../observable-tracking/render-owners.js";
import { staticPropertyName } from "../child-contract/declared-prop-types.js";
import ts from "typescript";

const REACT_MODULE = "react";
const LEGEND_REACT_MODULE = "@legendapp/state/react";
const SUBSCRIPTION_HOOKS: ReadonlySet<string> = new Set(["useValue", "use$", "useSelector"]);
const OWNED_OBSERVABLE_HOOKS: ReadonlySet<string> = new Set([
  "useComputed",
  "useLocalObservable",
  "useObservable",
]);
const STATE_HOOKS: ReadonlySet<string> = new Set(["useReducer", "useState"]);
const DEPENDENCY_HOOKS: ReadonlySet<string> = new Set(["useCallback", "useMemo"]);
const NAMESPACE_IMPORTS: ReadonlySet<string> = new Set(["*", "default"]);
const COMPONENT_TYPES: ReadonlySet<string> = new Set([
  "FC",
  "FunctionComponent",
  "VFC",
  "VoidFunctionComponent",
]);
const IN_PROGRESS = Symbol("in-progress");

/** Classifies what a captured identifier names; null means it keeps its value across the owner's renders. */
export type CaptureClassifier = (identifier: ts.Identifier) => ValueChange | null;

type CacheEntry = ValueChange | null | typeof IN_PROGRESS;

interface ClassifierContext {
  readonly cache: Map<ts.Node, Map<string, CacheEntry>>;
  readonly scan: MemoCaptureScan;
}

/** One name a declaration binds; destructured names share their declaration. */
interface NamedDeclaration {
  readonly declaration: ts.Node;
  readonly name: string;
}

interface ImportedCallee {
  readonly module: string;
  readonly name: string;
}

interface ChangeOrigin {
  readonly binding: string;
  readonly node: ts.Node;
}

/**
 * Builds a classifier over one file. A binding declared outside every function, imported, or global
 * keeps its value; refs, owned observables, declared observable props, state setters, and memos
 * without changing dependencies keep their identity. Legend subscriptions, React state whose setter
 * is used, and external stores re-render their owner when they change. Everything else a render
 * declares may change on a parent render.
 */
export function captureClassifier(scan: MemoCaptureScan): CaptureClassifier {
  const context: ClassifierContext = { cache: new Map(), scan };
  return (identifier) => classify(identifier, context);
}

/** Calls `visitor` for every identifier in `node` that reads a value, skipping types and names. */
export function visitValueReferences(
  node: ts.Node,
  visitor: (identifier: ts.Identifier) => void,
): void {
  if (ts.isTypeNode(node)) {
    return;
  }
  if (ts.isIdentifier(node)) {
    if (isValueReference(node)) {
      visitor(node);
    }
    return;
  }
  node.forEachChild((child) => visitValueReferences(child, visitor));
}

function classify(identifier: ts.Identifier, context: ClassifierContext): ValueChange | null {
  const binding = lexicalBinding(identifier);
  if (!binding || binding.kind === "import" || binding.kind === "ambient") {
    return null;
  }
  const key = { declaration: binding.declaration, name: identifier.text };
  if (binding.kind === "function") {
    return memoized(key, context, () => functionChange(binding.declaration, context));
  }
  return readsDeclaredObservableProp(identifier, binding.declaration, context)
    ? null
    : memoized(key, context, () => valueChange(key, context));
}

function memoized(
  { declaration, name }: NamedDeclaration,
  context: ClassifierContext,
  compute: () => ValueChange | null,
): ValueChange | null {
  const names = context.cache.get(declaration) ?? new Map<string, CacheEntry>();
  context.cache.set(declaration, names);
  const cached = names.get(name);
  if (cached !== undefined) {
    return cached === IN_PROGRESS ? null : cached;
  }
  names.set(name, IN_PROGRESS);
  const change = compute();
  names.set(name, change);
  return change;
}

function functionChange(
  declaration: RuntimeFunctionLike,
  context: ClassifierContext,
): ValueChange | null {
  if (!isRenderScoped(declaration)) {
    return null;
  }
  const memo = dependencyHookCall(declaration.parent);
  return memo ? dependencyChange(memo, context) : freeReferenceChange(declaration, context);
}

function valueChange(named: NamedDeclaration, context: ClassifierContext): ValueChange | null {
  const { declaration, name } = named;
  if (context.scan.observableBindings.has(name) || !isRenderScoped(declaration)) {
    return null;
  }
  if (ts.isParameter(declaration)) {
    return parameterChange(declaration, name, context);
  }
  if (!ts.isVariableDeclaration(declaration)) {
    return renderScoped("a variable", { binding: name, node: declaration }, context);
  }
  return variableChange(declaration, name, context);
}

function variableChange(
  declaration: ts.VariableDeclaration,
  name: string,
  context: ClassifierContext,
): ValueChange | null {
  const list = declaration.parent;
  if (
    !declaration.initializer ||
    !ts.isVariableDeclarationList(list) ||
    !(list.flags & ts.NodeFlags.Const)
  ) {
    return renderScoped("a reassignable variable", { binding: name, node: declaration }, context);
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  return ts.isCallExpression(initializer)
    ? callResultChange(initializer, { declaration, name }, context)
    : freeReferenceChange(initializer, context);
}

/** An iteration callback's item follows the iterated value; a declared observable prop never changes. */
function parameterChange(
  parameter: ts.ParameterDeclaration,
  name: string,
  context: ClassifierContext,
): ValueChange | null {
  const owner = parameter.parent;
  const origin = { binding: name, node: parameter };
  const iteration = iterationCallee(owner);
  if (iteration) {
    const receiver = rootIdentifier(iteration.expression);
    return receiver
      ? classify(receiver, context)
      : renderScoped("an iterated item", origin, context);
  }
  return declaresObservableParameter(parameter, name, context)
    ? null
    : renderScoped(`a parameter of \`${functionName(owner)}\``, origin, context);
}

/** The `items.map` callee when `owner` is a render iteration callback. */
function iterationCallee(owner: ts.Node): ts.PropertyAccessExpression | null {
  const iteration = isRuntimeFunctionLike(owner) ? renderIterationCall(owner) : null;
  const callee = iteration ? unwrapTransparentExpression(iteration.expression) : null;
  return callee && ts.isPropertyAccessExpression(callee) ? callee : null;
}

function declaresObservableParameter(
  parameter: ts.ParameterDeclaration,
  name: string,
  context: ClassifierContext,
): boolean {
  const propName = destructuredPropName(parameter.name, name);
  const propsType = parameter.type ?? componentPropsType(parameter.parent);
  return (
    propName !== null &&
    propsType !== null &&
    declaresObservableProp(propsType, propName, context.scan.imports.observableTypes)
  );
}

/** `props.value$` on a props parameter whose declared type makes `value$` an observable. */
function readsDeclaredObservableProp(
  identifier: ts.Identifier,
  declaration: ts.Node,
  context: ClassifierContext,
): boolean {
  const { parent } = identifier;
  if (
    !ts.isParameter(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isPropertyAccessExpression(parent) ||
    parent.expression !== identifier
  ) {
    return false;
  }
  const propsType = declaration.type ?? componentPropsType(declaration.parent);
  return (
    propsType !== null &&
    declaresObservableProp(propsType, parent.name.text, context.scan.imports.observableTypes)
  );
}

function callResultChange(
  call: ts.CallExpression,
  named: NamedDeclaration,
  context: ClassifierContext,
): ValueChange | null {
  const callee = importedCallee(call);
  const origin = { binding: named.name, node: call };
  if (callee?.module === REACT_MODULE) {
    return reactHookChange(call, named, context);
  }
  if (callee?.module === LEGEND_REACT_MODULE && SUBSCRIPTION_HOOKS.has(callee.name)) {
    return subscribed(callee.name, origin, context);
  }
  if (callee?.module === LEGEND_REACT_MODULE && OWNED_OBSERVABLE_HOOKS.has(callee.name)) {
    return null;
  }
  const source = `the result of \`${call.expression.getText(context.scan.sourceFile)}()\``;
  return renderScoped(source, origin, context);
}

function reactHookChange(
  call: ts.CallExpression,
  named: NamedDeclaration,
  context: ClassifierContext,
): ValueChange | null {
  const hook = importedCallee(call)?.name ?? "";
  if (hook === "useRef") {
    return null;
  }
  if (STATE_HOOKS.has(hook)) {
    return stateChange(call, named, context);
  }
  if (DEPENDENCY_HOOKS.has(hook)) {
    return dependencyChange(call, context);
  }
  const origin = { binding: named.name, node: call };
  return hook === "useSyncExternalStore"
    ? subscribed(hook, origin, context)
    : renderScoped(`the result of \`${hook}()\``, origin, context);
}

/** The first element of a state tuple changes only when its setter is used; the setter never changes. */
function stateChange(
  call: ts.CallExpression,
  { declaration, name }: NamedDeclaration,
  context: ClassifierContext,
): ValueChange | null {
  const hook = importedCallee(call)?.name ?? "useState";
  const origin = { binding: name, node: call };
  const pattern = ts.isVariableDeclaration(declaration) ? declaration.name : null;
  if (!pattern || !ts.isArrayBindingPattern(pattern)) {
    return renderScoped(`the result of \`${hook}()\``, origin, context);
  }
  const [value, setter] = pattern.elements.map((element) =>
    ts.isBindingElement(element) && ts.isIdentifier(element.name) ? element.name : null,
  );
  const owner = findAncestor(declaration, isRuntimeFunctionLike);
  const setterUsed =
    setter !== null &&
    setter !== undefined &&
    owner !== null &&
    identifiersNamed(owner, setter.text).some((reference) => reference !== setter);
  return value?.text === name && setterUsed ? subscribed(hook, origin, context) : null;
}

/** A memoized value or callback changes exactly when a dependency does; without a list, on every render. */
function dependencyChange(call: ts.CallExpression, context: ClassifierContext): ValueChange | null {
  const dependencies = call.arguments[1] ? unwrapTransparentExpression(call.arguments[1]) : null;
  if (dependencies && ts.isArrayLiteralExpression(dependencies)) {
    return strongest(dependencies.elements.map((element) => freeReferenceChange(element, context)));
  }
  const [callback] = call.arguments;
  return callback ? freeReferenceChange(callback, context) : null;
}

/** The strongest change among the identifiers `node` reads from outside itself. */
function freeReferenceChange(node: ts.Node, context: ClassifierContext): ValueChange | null {
  const changes: (ValueChange | null)[] = [];
  visitValueReferences(node, (identifier) => {
    const binding = lexicalBinding(identifier);
    const local =
      binding !== null &&
      (binding.kind === "function" || binding.kind === "value") &&
      nodeWithin(binding.declaration, node);
    if (!local) {
      changes.push(classify(identifier, context));
    }
  });
  return strongest(changes);
}

function subscribed(
  hook: string,
  { binding, node }: ChangeOrigin,
  context: ClassifierContext,
): ValueChange {
  return { binding, hook, kind: "subscribed", line: lineOf(node, context.scan.sourceFile) };
}

function renderScoped(
  source: string,
  { binding, node }: ChangeOrigin,
  context: ClassifierContext,
): ValueChange {
  return { binding, kind: "render-scoped", line: lineOf(node, context.scan.sourceFile), source };
}

function isValueReference(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return (
    !isNonValueIdentifier(identifier) &&
    !isDeclarationName(identifier) &&
    !(ts.isJsxClosingElement(parent) && parent.tagName === identifier)
  );
}

function strongest(changes: readonly (ValueChange | null)[]): ValueChange | null {
  return (
    changes.find((change) => change?.kind === "subscribed") ??
    changes.find((change) => change !== null) ??
    null
  );
}

function isRenderScoped(declaration: ts.Node): boolean {
  return findAncestor(declaration, isRuntimeFunctionLike) !== null;
}

/** The prop a top-level destructured parameter element binds to `name`. */
function destructuredPropName(pattern: ts.BindingName, name: string): string | null {
  if (!ts.isObjectBindingPattern(pattern)) {
    return null;
  }
  const element = pattern.elements.find(
    (candidate) =>
      !candidate.dotDotDotToken && ts.isIdentifier(candidate.name) && candidate.name.text === name,
  );
  if (!element) {
    return null;
  }
  return element.propertyName ? staticPropertyName(element.propertyName) : name;
}

/** The props type argument of a `const Component: FC<Props> = (props) => ...` annotation. */
function componentPropsType(owner: ts.Node): ts.TypeNode | null {
  let current = owner;
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const declaration = current.parent;
  const annotation =
    ts.isVariableDeclaration(declaration) && declaration.initializer === current
      ? declaration.type
      : undefined;
  if (!annotation || !ts.isTypeReferenceNode(annotation)) {
    return null;
  }
  const typeName = ts.isQualifiedName(annotation.typeName)
    ? annotation.typeName.right.text
    : annotation.typeName.text;
  const [props] = annotation.typeArguments ?? [];
  return COMPONENT_TYPES.has(typeName) && props ? props : null;
}

function dependencyHookCall(node: ts.Node): ts.CallExpression | null {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.parent;
  }
  if (!ts.isCallExpression(current)) {
    return null;
  }
  const callee = importedCallee(current);
  return callee?.module === REACT_MODULE && DEPENDENCY_HOOKS.has(callee.name) ? current : null;
}

function importedCallee(call: ts.CallExpression): ImportedCallee | null {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const binding = lexicalBinding(callee);
    return binding?.kind === "import"
      ? { module: binding.moduleSpecifier, name: binding.importedName }
      : null;
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return null;
  }
  const binding = lexicalBinding(callee.expression);
  return binding?.kind === "import" && NAMESPACE_IMPORTS.has(binding.importedName)
    ? { module: binding.moduleSpecifier, name: callee.name.text }
    : null;
}

function functionName(node: ts.Node): string {
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isCallExpression(current.parent)) {
    current = current.parent;
  }
  const { parent } = current;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? parent.name.text
    : "its function";
}
