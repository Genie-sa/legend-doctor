import {
  bindingDeclarationCount,
  hookCallName,
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { collectHookImports, isImportedHookCall } from "../imports.js";
import {
  findAncestor,
  findAncestorUntil,
  identifiersNamed,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "../ast.js";
import {
  isHookDependencyReference,
  isSynchronousRenderCallback,
  uniqueVariableDeclaration,
} from "./state-proofs.js";

import type { HookImports } from "../imports.js";
import ts from "typescript";

export interface ChildComponentSource {
  readonly body: ts.ConciseBody;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly file: string;
  readonly invocation?: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  readonly invocationOwner?: ChildComponentSource;
  readonly owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  readonly reactWrapped?: boolean;
}

export interface CallbackContractSourceResolver {
  contextReaderHooks: (
    file: string,
    contextName: string,
  ) => ReadonlyMap<string, ReadonlySet<string>>;
  deferredCallbackHooks: (file: string) => ReadonlyMap<string, ReadonlySet<number>>;
  frameworkEventComponent: (file: string, name: string) => boolean;
  hookCallbackIsDeferred: (file: string, name: string, argumentIndex: number) => boolean;
  resolveComponent: (file: string, name: string) => ChildComponentSource | null;
  resolveHook: (file: string, name: string) => ChildComponentSource | null;
  sourceFile: (file: string) => ts.SourceFile | null;
}

export interface ChildContractResolver {
  componentArrayItemCallbackIsDeferred: (
    componentName: string,
    propName: string,
    callbackProperty: string,
  ) => boolean;
  callbackRegistrationIsDeferred: (
    ownerBinding: string,
    method: string,
    argumentIndex: number,
  ) => boolean;
  callbackPropertyIsDeferred: (
    hookName: string,
    argumentIndex: number,
    property: string,
  ) => boolean;
  hookStateHasKeyedRowConsumer: (
    hookName: string,
    stateProperty: string,
    setterProperty: string,
  ) => boolean;
  componentPropCallbackIsDeferred: (
    componentName: string,
    propName: string,
    callbackProperty: string,
  ) => boolean;
  componentCallbackPropIsDeferred: (componentName: string, propName: string) => boolean;
  componentCallbackPropIsDeferredAtInvocation: (
    componentName: string,
    propName: string,
    invocation: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ) => boolean;
  componentCallbackPropRunsOnlyInReactEffect: (componentName: string, propName: string) => boolean;
  frameworkEventComponent: (componentName: string) => boolean;
  pureProjectionBindings: () => ReadonlySet<string>;
  resolveComponent: (name: string) => ChildComponentSource | null;
}

const MAX_TRACKED_NAMES = 8;
const TRACKED_ARRAY_ITERATION_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);

/**
 * Proves that a child component consumes one prop as a pure render value:
 * every read lands in JSX output of host elements or in bounded pure
 * projections of such reads, and no read escapes into hooks, callbacks,
 * writes, forwarding, or other calls. Only then can the owner keep the
 * observable and the call site subscribe without changing behavior.
 */
export function propIsLeafRenderConsumer(source: ChildComponentSource, propName: string): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body) {
    return false;
  }
  if (bindingDeclarationCount(source.owner, bound.text) !== 1) {
    return false;
  }

  let renderReads = 0;
  let safe = true;
  const tracked = new Set([bound.text]);
  visit(source.owner.body, (node) => {
    if (!safe || !ts.isIdentifier(node) || !tracked.has(node.text)) {
      return;
    }
    const verdict = leafRenderVerdict(node, source, tracked);
    if (verdict === "render-read") {
      renderReads += 1;
    } else if (verdict === "unsafe") {
      safe = false;
    }
  });
  return safe && renderReads > 0;
}

type LeafRenderVerdict = "ignored" | "render-read" | "unsafe";

function leafRenderVerdict(
  node: ts.Identifier,
  source: ChildComponentSource,
  tracked: Set<string>,
): LeafRenderVerdict {
  if (isNonValueIdentifier(node) || isBindingName(node)) {
    return "ignored";
  }
  if (findAncestor(node, isRuntimeFunctionLike) !== source.owner || referenceIsWritten(node)) {
    return "unsafe";
  }
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, source.owner);
  if (attribute) {
    return isCustomJsxTag(attribute) ? "unsafe" : "render-read";
  }
  if (findAncestorUntil(node, isJsxNode, source.owner)) {
    return "render-read";
  }
  return tracksPureProjection(node, source.owner, tracked) ? "ignored" : "unsafe";
}

/**
 * Proves that one directly bound child prop has a primitive declared type and
 * is consumed by the child. Primitive values make a parent-driven render and
 * a child-owned subscription observably equivalent; object identity and React
 * wrapper comparators remain outside this contract.
 */
export function propIsPrimitiveValueConsumer(
  source: ChildComponentSource,
  propName: string,
): boolean {
  if (source.reactWrapped) {
    return false;
  }
  const bound = boundPropIdentifier(source.owner, propName);
  const type = declaredPropType(source, propName);
  if (
    !bound ||
    !type ||
    !primitiveValueType(type) ||
    bindingDeclarationCount(source.owner, bound.text) !== 1
  ) {
    return false;
  }

  let reads = 0;
  visit(source.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node !== bound &&
      node.text === bound.text &&
      !isNonValueIdentifier(node) &&
      !isBindingName(node)
    ) {
      reads += 1;
    }
  });
  return reads > 0;
}

function unwrapParenthesizedType(type: ts.TypeNode): ts.TypeNode {
  let current = type;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

function soleTypeDeclaration(
  source: ChildComponentSource,
  typeName: string,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  const declarations = source.owner
    .getSourceFile()
    .statements.filter(
      (statement): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === typeName,
    );
  const [declaration] = declarations;
  return declarations.length === 1 && declaration ? declaration : null;
}

function declaredTypeMembers(
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
): ts.NodeArray<ts.TypeElement> | null {
  if (ts.isInterfaceDeclaration(declaration)) {
    return declaration.heritageClauses?.length ? null : declaration.members;
  }
  const alias = unwrapParenthesizedType(declaration.type);
  return ts.isTypeLiteralNode(alias) ? alias.members : null;
}

function propsTypeMembers(
  source: ChildComponentSource,
  propsType: ts.TypeNode,
): ts.NodeArray<ts.TypeElement> | null {
  if (ts.isTypeLiteralNode(propsType)) {
    return propsType.members;
  }
  if (!ts.isTypeReferenceNode(propsType) || !ts.isIdentifier(propsType.typeName)) {
    return null;
  }
  const declaration = soleTypeDeclaration(source, propsType.typeName.text);
  return declaration === null ? null : declaredTypeMembers(declaration);
}

function declaredPropType(source: ChildComponentSource, propName: string): ts.TypeNode | null {
  const [parameter] = source.owner.parameters;
  if (!parameter?.type || source.owner.parameters.length !== 1) {
    return null;
  }
  const members = propsTypeMembers(source, unwrapParenthesizedType(parameter.type));
  if (!members) {
    return null;
  }

  const properties = members.filter(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && staticPropertyName(member.name) === propName,
  );
  const [property] = properties;
  return properties.length === 1 && property ? (property.type ?? null) : null;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function primitiveValueType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return primitiveValueType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.length > 0 && type.types.every(primitiveValueType);
  }
  if (ts.isLiteralTypeNode(type)) {
    return (
      ts.isStringLiteral(type.literal) ||
      ts.isNumericLiteral(type.literal) ||
      type.literal.kind === ts.SyntaxKind.TrueKeyword ||
      type.literal.kind === ts.SyntaxKind.FalseKeyword ||
      type.literal.kind === ts.SyntaxKind.NullKeyword
    );
  }
  return (
    type.kind === ts.SyntaxKind.BooleanKeyword ||
    type.kind === ts.SyntaxKind.StringKeyword ||
    type.kind === ts.SyntaxKind.NumberKeyword ||
    type.kind === ts.SyntaxKind.BigIntKeyword ||
    type.kind === ts.SyntaxKind.UndefinedKeyword
  );
}

/**
 * Proves that callbacks stored on items of one array prop are invoked only
 * behind deferred nested functions. The prop itself may be inspected and
 * mapped during render, but its callback field may not execute in render,
 * memoization, state initialization, or a React lifecycle callback.
 */
interface ArrayItemCallbackScan {
  readonly callbackProp: string;
  readonly itemNames: ReadonlySet<string>;
  readonly resolver: CallbackContractSourceResolver | undefined;
  readonly source: ChildComponentSource;
}

type ArrayItemVerdict = "counted" | "counted-unsafe" | "ignored" | "unsafe";

export function propDefersArrayItemCallback(
  source: ChildComponentSource,
  propName: string,
  callbackProp: string,
  resolver: CallbackContractSourceResolver | undefined,
): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body || bindingDeclarationCount(source.owner, bound.text) !== 1) {
    return false;
  }
  const arrayNames = trackedArrayNames(source, bound.text);
  if (!arrayBindingsStayWithinTrackedConsumers(source, arrayNames)) {
    return false;
  }
  const itemNames = arrayItemNames(source, arrayNames);
  if (itemNames.size === 0) {
    return false;
  }
  return arrayItemCallbackReferencesAreDeferred({ callbackProp, itemNames, resolver, source });
}

function trackedArrayNames(source: ChildComponentSource, boundName: string): ReadonlySet<string> {
  const arrayNames = new Set([boundName]);
  let addedAlias = true;
  const collectAlias = (node: ts.Node): void => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      arrayNames.has(node.name.text) ||
      !ts.isVariableDeclarationList(node.parent) ||
      (node.parent.flags & ts.NodeFlags.Const) === 0 ||
      bindingDeclarationCount(source.owner, node.name.text) !== 1 ||
      !isFilteredArrayAlias(node.initializer, arrayNames)
    ) {
      return;
    }
    arrayNames.add(node.name.text);
    addedAlias = true;
  };
  while (addedAlias && arrayNames.size < MAX_TRACKED_NAMES) {
    addedAlias = false;
    visit(source.owner.body, collectAlias);
  }
  return arrayNames;
}

function arrayItemNames(
  source: ChildComponentSource,
  arrayNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const itemNames = new Set<string>();
  visit(source.owner.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      [...arrayNames].some((name) => isArrayItemLookup(node.initializer!, name))
    ) {
      itemNames.add(node.name.text);
    }
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node.parameters[0] &&
      ts.isIdentifier(node.parameters[0].name) &&
      isArrayIterationCallback(node, arrayNames)
    ) {
      itemNames.add(node.parameters[0].name.text);
    }
  });
  return itemNames;
}

function arrayItemCallbackReferencesAreDeferred(scan: ArrayItemCallbackScan): boolean {
  const { itemNames, source } = scan;
  let references = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      !itemNames.has(node.text) ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const verdict = arrayItemReferenceVerdict(node, scan);
    if (verdict === "counted" || verdict === "counted-unsafe") {
      references += 1;
    }
    if (verdict === "counted-unsafe" || verdict === "unsafe") {
      safe = false;
    }
  });
  return safe && references > 0;
}

function arrayItemReferenceVerdict(
  node: ts.Identifier,
  scan: ArrayItemCallbackScan,
): ArrayItemVerdict {
  const { callbackProp } = scan;
  const member = node.parent;
  if (
    ts.isSpreadAssignment(member) &&
    member.expression === node &&
    spreadCallbackIsOverridden(member, callbackProp)
  ) {
    return "ignored";
  }
  if (!ts.isPropertyAccessExpression(member) || member.expression !== node) {
    return enclosingCallbackIsDeferred(node, scan) ? "ignored" : "unsafe";
  }
  if (member.name.text !== callbackProp) {
    return "ignored";
  }
  return arrayItemCallbackUseIsDeferred(member, scan) ? "counted" : "counted-unsafe";
}

function enclosingCallbackIsDeferred(node: ts.Node, scan: ArrayItemCallbackScan): boolean {
  const { resolver, source } = scan;
  const callback = nearestNestedFunction(node, source.owner);
  return (
    callback !== null &&
    callback !== source.owner &&
    (ts.isArrowFunction(callback) ||
      ts.isFunctionDeclaration(callback) ||
      ts.isFunctionExpression(callback)) &&
    callbackInvocationIsDeferred({
      callback,
      deferredCallbackHooks: source.deferredCallbackHooks,
      depth: 0,
      owner: source.owner,
      resolver,
      seenCallbacks: new Set(),
      source: resolver ? source : undefined,
      visited: new Set(),
    })
  );
}

function arrayItemCallbackUseIsDeferred(
  member: ts.PropertyAccessExpression,
  scan: ArrayItemCallbackScan,
): boolean {
  const { resolver, source } = scan;
  if (ts.isCallExpression(member.parent) && member.parent.expression === member) {
    return enclosingCallbackIsDeferred(member, scan);
  }
  if (callbackReferenceIsObservationOnly(member)) {
    return true;
  }
  const attribute = findAncestorUntil(member, ts.isJsxAttribute, source.owner);
  if (!resolver || !attribute || !jsxAttributeDirectlyCarries(attribute, member)) {
    return false;
  }
  return jsxAttributeForwardsArrayItemCallback(attribute, source, resolver);
}

function jsxAttributeForwardsArrayItemCallback(
  attribute: ts.JsxAttribute,
  source: ChildComponentSource,
  resolver: CallbackContractSourceResolver,
): boolean {
  const prop = attribute.name.getText();
  const target = jsxOwnerTarget(attribute);
  if (!/^on[A-Z]/u.test(prop) || !target) {
    return false;
  }
  if (
    jsxOwnerIsDeferredEventTarget(attribute, source) ||
    resolver.frameworkEventComponent(source.file, target)
  ) {
    return true;
  }
  const child = resolver.resolveComponent(source.file, target);
  return (
    child !== null &&
    sourceInputCallbackIsDeferred({
      argumentIndex: 0,
      path: [prop],
      source: atJsxInvocation(child, attribute, source),
      trace: rootTrace(resolver),
    })
  );
}

function spreadCallbackIsOverridden(spread: ts.SpreadAssignment, callbackProp: string): boolean {
  const object = spread.parent;
  if (!ts.isObjectLiteralExpression(object)) {
    return false;
  }
  const following = object.properties.slice(object.properties.indexOf(spread) + 1);
  return (
    !following.some((property) => ts.isSpreadAssignment(property)) &&
    following.some(
      (property) =>
        !ts.isSpreadAssignment(property) && propertyName(property.name) === callbackProp,
    )
  );
}

function arrayBindingsStayWithinTrackedConsumers(
  source: ChildComponentSource,
  arrayNames: ReadonlySet<string>,
): boolean {
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      !arrayNames.has(node.text) ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    safe = arrayReferenceStaysTracked(node);
  });
  return safe;
}

function arrayReferenceStaysTracked(node: ts.Identifier): boolean {
  const value = climbTransparentExpression(node);
  const member = value.parent;
  if (!ts.isPropertyAccessExpression(member) || member.expression !== value) {
    return false;
  }
  if (member.name.text === "length") {
    return true;
  }
  return (
    ts.isCallExpression(member.parent) &&
    member.parent.expression === member &&
    (member.name.text === "at" || TRACKED_ARRAY_ITERATION_METHODS.has(member.name.text))
  );
}

/**
 * Proves that one callback field of an object prop can only execute after
 * render. The path may cross local/imported component wrappers, JSX spreads,
 * object destructuring, and source-resolved custom hooks. Every path must end
 * in a host-style event prop or a callback whose own registration is proven
 * deferred.
 */
export function propObjectCallbackIsDeferred(
  source: ChildComponentSource,
  propName: string,
  callbackProperty: string,
  resolver: CallbackContractSourceResolver,
): boolean {
  return sourceInputCallbackIsDeferred({
    argumentIndex: 0,
    path: [propName, callbackProperty],
    source,
    trace: rootTrace(resolver),
  });
}

export function propCallbackIsDeferred(
  source: ChildComponentSource,
  propName: string,
  resolver: CallbackContractSourceResolver,
): boolean {
  return sourceInputCallbackIsDeferred({
    argumentIndex: 0,
    path: [propName],
    source,
    trace: rootTrace(resolver),
  });
}

/**
 * Proves that a callback prop is referenced only by a React effect: direct
 * invocations and presence checks run in the effect body, while other reads
 * may only preserve the dependency list. This is intentionally narrower than
 * the general deferred-callback contract because an unknown deferred consumer
 * could establish its own Legend tracking context.
 */
export function propCallbackRunsOnlyInReactEffect(
  source: ChildComponentSource,
  propName: string,
): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body) {
    return false;
  }
  if (bindingDeclarationCount(source.owner, bound.text) !== 1) {
    return false;
  }

  const imports = collectHookImports(source.owner.getSourceFile());
  let invocations = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== bound.text ||
      node === bound ||
      isNonValueIdentifier(node) ||
      isBindingName(node)
    ) {
      return;
    }
    const usage = reactEffectCallbackUsage(node, source.owner, imports);
    if (usage === "invoke") {
      invocations += 1;
    }
    if (usage === null) {
      safe = false;
    }
  });
  return safe && invocations > 0;
}

function reactEffectCallbackUsage(
  reference: ts.Identifier,
  owner: ChildComponentSource["owner"],
  imports: HookImports,
): "dependency" | "invoke" | "observe" | null {
  let current: ts.Node = reference;
  while (current.parent && current.parent !== owner) {
    const { parent } = current;
    if (ts.isCallExpression(parent) && isReactEffectCall(parent, imports)) {
      return effectCallReferenceUsage(parent, reference, owner);
    }
    current = parent;
  }
  return null;
}

function effectCallReferenceUsage(
  call: ts.CallExpression,
  reference: ts.Identifier,
  owner: ChildComponentSource["owner"],
): "dependency" | "invoke" | "observe" | null {
  const [effect, dependencies] = call.arguments;
  if (
    dependencies &&
    ts.isArrayLiteralExpression(dependencies) &&
    dependencies.elements.some((element) => unwrapTransparentExpression(element) === reference)
  ) {
    return "dependency";
  }
  if (
    !effect ||
    (!ts.isArrowFunction(effect) && !ts.isFunctionExpression(effect)) ||
    !nodeWithin(reference, effect.body) ||
    nearestNestedFunction(reference, owner) !== effect
  ) {
    return null;
  }
  if (callbackReferenceIsObservationOnly(reference)) {
    return "observe";
  }
  const expression = climbTransparentExpression(reference);
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression
    ? "invoke"
    : null;
}

function isReactEffectCall(call: ts.CallExpression, imports: HookImports): boolean {
  return (
    isImportedHookCall(call, imports.useEffect, imports.reactNamespaces, "useEffect") ||
    isImportedHookCall(call, imports.useLayoutEffect, imports.reactNamespaces, "useLayoutEffect") ||
    isImportedHookCall(
      call,
      imports.useInsertionEffect,
      imports.reactNamespaces,
      "useInsertionEffect",
    )
  );
}

interface TrackedCallbackPath {
  name: string;
  path: readonly string[];
}

interface CallbackReturnTarget {
  call: ts.CallExpression;
  source: ChildComponentSource;
}

const MAX_CALLBACK_PATH_DEPTH = 32;
const CALLBACK_IDENTITY_HOOKS = new Set([
  "useCallback",
  "useEffect",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
]);
const reactNamespacesBySourceFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function reactNamespacesFor(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = reactNamespacesBySourceFile.get(sourceFile);
  if (cached) {
    return cached;
  }
  const namespaces = collectHookImports(sourceFile).reactNamespaces;
  reactNamespacesBySourceFile.set(sourceFile, namespaces);
  return namespaces;
}

interface CallbackTrace {
  readonly depth: number;
  readonly resolver: CallbackContractSourceResolver;
  readonly returnTarget: CallbackReturnTarget | null;
  readonly visited: ReadonlySet<string>;
}

interface SourceInputProbe {
  readonly argumentIndex: number;
  readonly path: readonly string[];
  readonly source: ChildComponentSource;
  readonly trace: CallbackTrace;
}

interface CallbackReferenceProbe {
  readonly path: readonly string[];
  readonly reference: ts.Identifier;
  readonly source: ChildComponentSource;
  readonly trace: CallbackTrace;
}

interface CallbackExpressionProbe {
  readonly expression: ts.Expression;
  readonly path: readonly string[];
  readonly source: ChildComponentSource;
  readonly trace: CallbackTrace;
}

function rootTrace(resolver: CallbackContractSourceResolver): CallbackTrace {
  return { depth: 0, resolver, returnTarget: null, visited: new Set() };
}

function deeperTrace(
  trace: CallbackTrace,
  returnTarget: CallbackReturnTarget | null,
): CallbackTrace {
  return { depth: trace.depth + 1, resolver: trace.resolver, returnTarget, visited: trace.visited };
}

function sourceInputCallbackIsDeferred(probe: SourceInputProbe): boolean {
  const { argumentIndex, path, source, trace } = probe;
  if (trace.depth > MAX_CALLBACK_PATH_DEPTH || !source.owner.body) {
    return false;
  }
  const parameter = source.owner.parameters[argumentIndex];
  const tracked = parameter ? bindCallbackPath(parameter.name, path) : null;
  return tracked !== null && trackedCallbackPathIsDeferred(source, tracked, trace);
}

function bindingElementNamed(
  elements: ts.NodeArray<ts.BindingElement>,
  property: string,
): ts.Identifier | null {
  for (const element of elements) {
    if (
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      bindingElementPropertyName(element) === property
    ) {
      return element.name;
    }
  }
  return null;
}

function restBindingElement(elements: ts.NodeArray<ts.BindingElement>): ts.Identifier | null {
  for (const element of elements) {
    if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
      return element.name;
    }
  }
  return null;
}

function bindObjectPatternPath(
  binding: ts.ObjectBindingPattern,
  path: readonly string[],
): TrackedCallbackPath | null {
  const [head, ...tail] = path;
  if (!head) {
    return null;
  }
  const matched = bindingElementNamed(binding.elements, head);
  if (matched) {
    return { name: matched.text, path: tail };
  }
  const rest = restBindingElement(binding.elements);
  return rest ? { name: rest.text, path } : null;
}

function bindCallbackPath(
  binding: ts.BindingName,
  path: readonly string[],
): TrackedCallbackPath | null {
  if (ts.isIdentifier(binding)) {
    return { name: binding.text, path };
  }
  return ts.isObjectBindingPattern(binding) ? bindObjectPatternPath(binding, path) : null;
}

function trackedPathKey(source: ChildComponentSource, tracked: TrackedCallbackPath): string {
  const invocationKey = source.invocation
    ? `${source.invocation.getSourceFile().fileName}:${source.invocation.pos}`
    : "";
  return `${source.file}\0${source.owner.pos}\0${invocationKey}\0${tracked.name}\0${tracked.path.join(".")}`;
}

function trackedReferencesAreDeferred(
  source: ChildComponentSource,
  tracked: TrackedCallbackPath,
  trace: CallbackTrace,
): boolean {
  let references = 0;
  let safe = true;
  for (const node of identifiersNamed(source.owner.body, tracked.name)) {
    if (!safe) {
      break;
    }
    if (isBindingName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    references += 1;
    safe = callbackPathReferenceIsDeferred({ path: tracked.path, reference: node, source, trace });
  }
  return safe && references > 0;
}

function trackedCallbackPathIsDeferred(
  source: ChildComponentSource,
  tracked: TrackedCallbackPath,
  trace: CallbackTrace,
): boolean {
  if (
    trace.depth > MAX_CALLBACK_PATH_DEPTH ||
    bindingDeclarationCount(source.owner, tracked.name) !== 1
  ) {
    return false;
  }
  const key = trackedPathKey(source, tracked);
  if (trace.visited.has(key)) {
    return false;
  }
  const nextTrace: CallbackTrace = {
    depth: trace.depth,
    resolver: trace.resolver,
    returnTarget: trace.returnTarget,
    visited: new Set(trace.visited).add(key),
  };
  return trackedReferencesAreDeferred(source, tracked, nextTrace);
}

function nestedPathVerdict(options: {
  readonly expression: ts.Expression;
  readonly head: string;
  readonly path: readonly string[];
  readonly source: ChildComponentSource;
  readonly trace: CallbackTrace;
}): boolean | null {
  const { expression, head, path, source, trace } = options;
  const access = staticPropertyAccessFrom(expression);
  if (access) {
    return (
      access.name !== head ||
      callbackPathExpressionIsDeferred({
        expression: access.expression,
        path: path.slice(1),
        source,
        trace,
      })
    );
  }
  const destructured = destructuredCallbackPath(source.owner, expression, path);
  if (destructured) {
    return trackedCallbackPathIsDeferred(
      source,
      destructured,
      deeperTrace(trace, trace.returnTarget),
    );
  }
  return null;
}

function callbackPathReferenceIsDeferred(probe: CallbackReferenceProbe): boolean {
  const { path, reference, source, trace } = probe;
  const expression = climbTransparentExpression(reference);
  const [head] = path;
  const nested =
    head === undefined ? null : nestedPathVerdict({ expression, head, path, source, trace });
  if (nested !== null) {
    return nested;
  }
  return callbackPathExpressionIsDeferred({ expression, path, source, trace });
}

function constAliasStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const alias = directConstAlias(value, source.owner);
  return alias
    ? trackedCallbackPathIsDeferred(
        source,
        { name: alias.text, path },
        deeperTrace(trace, trace.returnTarget),
      )
    : null;
}

function returnTargetStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const { returnTarget } = trace;
  if (!returnTarget) {
    return null;
  }
  const returnedPath = returnedCallbackPath(value, path, source.owner);
  if (returnedPath === "ignored") {
    return true;
  }
  return returnedPath &&
    callResultCallbackIsDeferred(returnTarget, returnedPath, deeperTrace(trace, null))
    ? true
    : null;
}

function jsxAttributeIsDeferredEvent(
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  const target = jsxOwnerTarget(attribute);
  return (
    jsxOwnerIsDeferredEventTarget(attribute, source) ||
    (target !== null && trace.resolver.frameworkEventComponent(source.file, target))
  );
}

function childInputIsDeferred(options: {
  readonly attribute: ts.JsxAttribute | ts.JsxSpreadAttribute;
  readonly path: readonly string[];
  readonly probe: CallbackExpressionProbe;
}): boolean {
  const { attribute, path, probe } = options;
  const { source, trace } = probe;
  const target = jsxOwnerTarget(attribute);
  const child = target ? trace.resolver.resolveComponent(source.file, target) : null;
  return (
    child !== null &&
    sourceInputCallbackIsDeferred({
      argumentIndex: 0,
      path,
      source: atJsxInvocation(child, attribute, source),
      trace: deeperTrace(trace, null),
    })
  );
}

function jsxAttributeStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const attribute = findAncestorUntil(value, ts.isJsxAttribute, source.owner);
  if (
    !attribute?.initializer ||
    !nodeWithin(value, attribute.initializer) ||
    !jsxAttributeCarriesCallbackIdentity(attribute, value)
  ) {
    return null;
  }
  const prop = attribute.name.getText();
  if (
    path.length === 0 &&
    /^on[A-Z]/u.test(prop) &&
    jsxAttributeIsDeferredEvent(attribute, source, trace)
  ) {
    return true;
  }
  return childInputIsDeferred({ attribute, path: [prop, ...path], probe });
}

function jsxSpreadStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const spread = findAncestorUntil(value, ts.isJsxSpreadAttribute, source.owner);
  if (
    !spread ||
    !nodeWithin(value, spread.expression) ||
    unwrapTransparentExpression(spread.expression) !== unwrapTransparentExpression(value)
  ) {
    return null;
  }
  if (
    jsxOwnerTarget(spread) !== null &&
    path.length === 1 &&
    /^on[A-Z]/u.test(path[0] ?? "") &&
    jsxAttributeIsDeferredEvent(spread, source, trace)
  ) {
    return true;
  }
  return childInputIsDeferred({ attribute: spread, path, probe });
}

function hookDependencyStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, source } = probe;
  return ts.isIdentifier(value) &&
    isHookDependencyReference(
      value,
      CALLBACK_IDENTITY_HOOKS,
      reactNamespacesFor(source.owner.getSourceFile()),
    )
    ? true
    : null;
}

function observationOnlyStage(probe: CallbackExpressionProbe): boolean | null {
  return probe.path.length === 0 && callbackReferenceIsObservationOnly(probe.expression)
    ? true
    : null;
}

function arrayPublicationStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  if (path.length > 0) {
    return null;
  }
  return deferredArrayItemCallbackPublication(source, value, trace.resolver);
}

function contextPublicationStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  if (path.length > 0) {
    return null;
  }
  const publication = memoizedContextPublication(value, source.owner);
  if (!publication) {
    return null;
  }
  return contextPropertyConsumersAreDeferred({
    contextName: publication.contextName,
    property: publication.property,
    providerFile: source.file,
    trace: deeperTrace(trace, null),
  })
    ? true
    : null;
}

function nestedCallbackStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  if (path.length > 0) {
    return null;
  }
  const callback = nearestNestedFunction(value, source.owner);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) &&
      !ts.isFunctionDeclaration(callback) &&
      !ts.isFunctionExpression(callback))
  ) {
    return null;
  }
  const deferred =
    callbackIsDeferredByJsx(callback, source, deeperTrace(trace, null)) ||
    callbackInvocationIsDeferred({
      callback,
      deferredCallbackHooks: source.deferredCallbackHooks,
      depth: trace.depth + 1,
      owner: source.owner,
      resolver: trace.resolver,
      seenCallbacks: new Set(),
      source,
      visited: trace.visited,
    });
  return deferred ? true : null;
}

function forwardedObjectStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const objectForward = forwardedObjectCall(value, source.owner);
  if (!objectForward) {
    return null;
  }
  const hook = trace.resolver.resolveHook(source.file, objectForward.hookName);
  return (
    hook !== null &&
    sourceInputCallbackIsDeferred({
      argumentIndex: objectForward.argumentIndex,
      path: [objectForward.property, ...path],
      source: hook,
      trace: deeperTrace(trace, { call: objectForward.call, source }),
    })
  );
}

function directCallStage(probe: CallbackExpressionProbe): boolean | null {
  const { expression: value, path, source, trace } = probe;
  const directCall = directCallArgument(value, source.owner);
  if (!directCall) {
    return null;
  }
  if (
    path.length === 0 &&
    trace.resolver.hookCallbackIsDeferred(
      source.file,
      directCall.hookName,
      directCall.argumentIndex,
    )
  ) {
    return true;
  }
  const hook = trace.resolver.resolveHook(source.file, directCall.hookName);
  return (
    hook !== null &&
    sourceInputCallbackIsDeferred({
      argumentIndex: directCall.argumentIndex,
      path,
      source: hook,
      trace: deeperTrace(trace, { call: directCall.call, source }),
    })
  );
}

const CALLBACK_EXPRESSION_STAGES: readonly ((probe: CallbackExpressionProbe) => boolean | null)[] =
  [
    constAliasStage,
    returnTargetStage,
    jsxAttributeStage,
    jsxSpreadStage,
    hookDependencyStage,
    observationOnlyStage,
    arrayPublicationStage,
    contextPublicationStage,
    nestedCallbackStage,
    forwardedObjectStage,
    directCallStage,
  ];

function callbackPathExpressionIsDeferred(probe: CallbackExpressionProbe): boolean {
  const resolved: CallbackExpressionProbe = {
    expression: climbTransparentExpression(probe.expression),
    path: probe.path,
    source: probe.source,
    trace: probe.trace,
  };
  for (const stage of CALLBACK_EXPRESSION_STAGES) {
    const verdict = stage(resolved);
    if (verdict !== null) {
      return verdict;
    }
  }
  return false;
}

interface ArrayPublicationScan {
  readonly binding: ts.Identifier;
  readonly callbackProperty: string;
  readonly resolver: CallbackContractSourceResolver;
  readonly source: ChildComponentSource;
}

function arrayItemCallbackPublication(
  callback: ts.Expression,
): { readonly array: ts.ArrayLiteralExpression; readonly callbackProperty: string } | null {
  const property = callback.parent;
  if (
    !ts.isPropertyAssignment(property) ||
    unwrapTransparentExpression(property.initializer) !== callback
  ) {
    return null;
  }
  const callbackProperty = propertyName(property.name);
  const object = property.parent;
  const carriedObject = ts.isObjectLiteralExpression(object)
    ? climbTransparentExpression(object)
    : null;
  const array = carriedObject?.parent;
  if (
    !callbackProperty ||
    !ts.isObjectLiteralExpression(object) ||
    !array ||
    !ts.isArrayLiteralExpression(array) ||
    !array.elements.includes(carriedObject) ||
    object.properties.some(ts.isSpreadAssignment) ||
    object.properties.filter(
      (member) =>
        (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
        propertyName(member.name) === callbackProperty,
    ).length !== 1
  ) {
    return null;
  }
  return { array, callbackProperty };
}

function constArrayBinding(
  array: ts.ArrayLiteralExpression,
  owner: ChildComponentSource["owner"],
): ts.Identifier | null {
  const carriedArray = climbTransparentExpression(array);
  const declaration = carriedArray.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== carriedArray ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  return declaration.name;
}

function arrayPublicationIsDeferred(node: ts.Identifier, scan: ArrayPublicationScan): boolean {
  const { callbackProperty, resolver, source } = scan;
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, source.owner);
  if (!attribute || !jsxAttributeDirectlyCarries(attribute, node)) {
    return false;
  }
  const target = jsxOwnerTarget(attribute);
  const child = target ? resolver.resolveComponent(source.file, target) : null;
  return (
    child !== null &&
    propDefersArrayItemCallback(
      atJsxInvocation(child, attribute, source),
      attribute.name.getText(),
      callbackProperty,
      resolver,
    )
  );
}

function arrayBindingPublicationsAreDeferred(scan: ArrayPublicationScan): boolean {
  const { binding, source } = scan;
  let publications = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding.text ||
      node === binding ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (arrayPublicationIsDeferred(node, scan)) {
      publications += 1;
    } else {
      safe = false;
    }
  });
  return safe && publications > 0;
}

function deferredArrayItemCallbackPublication(
  source: ChildComponentSource,
  callback: ts.Expression,
  resolver: CallbackContractSourceResolver,
): boolean | null {
  const publication = arrayItemCallbackPublication(callback);
  if (!publication) {
    return null;
  }
  const binding = constArrayBinding(publication.array, source.owner);
  if (!binding) {
    return false;
  }
  return arrayBindingPublicationsAreDeferred({
    binding,
    callbackProperty: publication.callbackProperty,
    resolver,
    source,
  });
}

function staticPropertyAccessFrom(
  expression: ts.Expression,
): { expression: ts.Expression; name: string } | null {
  const { parent } = expression;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) {
    return { expression: parent, name: parent.name.text };
  }
  if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === expression &&
    parent.argumentExpression &&
    ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    return { expression: parent, name: parent.argumentExpression.text };
  }
  return null;
}

const EQUALITY_OPERATOR_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function referenceIsBooleanTest(expression: ts.Expression, parent: ts.Node): boolean {
  if (
    (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
    parent.expression === expression
  ) {
    return true;
  }
  if (ts.isConditionalExpression(parent) && parent.condition === expression) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operand === expression &&
    parent.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return true;
  }
  if (ts.isTypeOfExpression(parent) && parent.expression === expression) {
    return true;
  }
  return ts.isTypeQueryNode(parent) && parent.exprName === expression;
}

function callbackReferenceIsObservationOnly(expression: ts.Expression): boolean {
  const { parent } = expression;
  if (referenceIsBooleanTest(expression, parent)) {
    return true;
  }
  if (!ts.isBinaryExpression(parent)) {
    return false;
  }
  if (EQUALITY_OPERATOR_KINDS.has(parent.operatorToken.kind)) {
    return true;
  }
  return (
    (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    expressionFeedsBooleanControl(parent)
  );
}

function expressionFeedsBooleanControl(expression: ts.Expression): boolean {
  let current = expression;
  while (
    ts.isBinaryExpression(current.parent) &&
    (current.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    current = current.parent;
  }
  const { parent } = current;
  return (
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      parent.expression === current) ||
    (ts.isConditionalExpression(parent) && parent.condition === current) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.ExclamationToken &&
      parent.operand === current)
  );
}

function valueIsDirectlyReturned(
  value: ts.Expression,
  owner: ChildComponentSource["owner"],
): boolean {
  const directReturn = findAncestorUntil(value, ts.isReturnStatement, owner);
  return (
    directReturn?.expression !== undefined &&
    findAncestor(directReturn, isRuntimeFunctionLike) === owner &&
    unwrapTransparentExpression(directReturn.expression) === unwrapTransparentExpression(value)
  );
}

function objectIsReturned(
  object: ts.ObjectLiteralExpression,
  owner: ChildComponentSource["owner"],
): boolean {
  const objectReturn = findAncestorUntil(object, ts.isReturnStatement, owner);
  return (
    objectReturn?.expression !== undefined &&
    findAncestor(objectReturn, isRuntimeFunctionLike) === owner &&
    unwrapTransparentExpression(objectReturn.expression) === object
  );
}

interface ReturnedMember {
  readonly index: number;
  readonly member: ts.ObjectLiteralElementLike;
  readonly object: ts.ObjectLiteralExpression;
  readonly path: readonly string[];
}

function spreadMemberPath(returned: ReturnedMember): readonly string[] | "ignored" {
  const { index, object, path } = returned;
  const [head] = path;
  if (!head) {
    return path;
  }
  const overridden = object.properties
    .slice(index + 1)
    .some(
      (candidate) =>
        (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
        propertyName(candidate.name) === head,
    );
  return overridden ? "ignored" : path;
}

function returnedMemberPath(returned: ReturnedMember): readonly string[] | "ignored" | null {
  const { member, path } = returned;
  if (ts.isSpreadAssignment(member)) {
    return spreadMemberPath(returned);
  }
  if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
    return null;
  }
  const property = propertyName(member.name);
  return property ? [property, ...path] : null;
}

function returnedCallbackPath(
  value: ts.Expression,
  path: readonly string[],
  owner: ChildComponentSource["owner"],
): readonly string[] | "ignored" | null {
  if (valueIsDirectlyReturned(value, owner)) {
    return path;
  }
  const object = findAncestorUntil(value, ts.isObjectLiteralExpression, owner);
  if (!object || !objectIsReturned(object, owner)) {
    return null;
  }
  const index = object.properties.findIndex((member) => nodeWithin(value, member));
  const member = index === -1 ? null : object.properties[index];
  if (!member) {
    return null;
  }
  return returnedMemberPath({ index, member, object, path });
}

function callResultCallbackIsDeferred(
  target: CallbackReturnTarget,
  path: readonly string[],
  trace: CallbackTrace,
): boolean {
  const expression = climbTransparentExpression(target.call);
  const alias = directConstAlias(expression, target.source.owner);
  return (
    alias !== null &&
    trackedCallbackPathIsDeferred(target.source, { name: alias.text, path }, trace)
  );
}

function destructuredCallbackPath(
  owner: ChildComponentSource["owner"],
  expression: ts.Expression,
  path: readonly string[],
): TrackedCallbackPath | null {
  const [head, ...tail] = path;
  if (!head) {
    return null;
  }
  const declaration = findAncestorUntil(expression, ts.isVariableDeclaration, owner);
  if (
    !declaration?.initializer ||
    !ts.isObjectBindingPattern(declaration.name) ||
    !expressionCarriesValue(declaration.initializer, expression)
  ) {
    return null;
  }
  const matches = declaration.name.elements.filter(
    (element) =>
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      bindingElementPropertyName(element) === head,
  );
  const match = matches.length === 1 ? matches[0] : null;
  return match && ts.isIdentifier(match.name) ? { name: match.name.text, path: tail } : null;
}

function expressionCarriesValue(expression: ts.Expression, value: ts.Expression): boolean {
  const unwrapped = unwrapTransparentExpression(expression);
  if (unwrapped === value) {
    return true;
  }
  if (
    !ts.isBinaryExpression(unwrapped) ||
    unwrapped.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
  ) {
    return false;
  }
  const left = unwrapTransparentExpression(unwrapped.left);
  const right = unwrapTransparentExpression(unwrapped.right);
  return (
    (left === value && isEmptyObjectLiteral(right)) ||
    (right === value && isEmptyObjectLiteral(left))
  );
}

function isEmptyObjectLiteral(expression: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(expression) && expression.properties.length === 0;
}

function directConstAlias(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): ts.Identifier | null {
  const declaration = expression.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== expression ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  return declaration.name;
}

function forwardedObjectCallTarget(
  member: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  object: ts.Node,
  call: ts.CallExpression,
): { argumentIndex: number; call: ts.CallExpression; hookName: string; property: string } | null {
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(object, argument));
  const hookName = hookCallName(call);
  const property = propertyName(member.name);
  return argumentIndex !== -1 && hookName && property
    ? { argumentIndex, call, hookName, property }
    : null;
}

function forwardedObjectCall(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): { argumentIndex: number; call: ts.CallExpression; hookName: string; property: string } | null {
  const member = expression.parent;
  if (
    !ts.isShorthandPropertyAssignment(member) &&
    !(ts.isPropertyAssignment(member) && nodeWithin(expression, member.initializer))
  ) {
    return null;
  }
  const object = member.parent;
  const call = ts.isObjectLiteralExpression(object)
    ? findAncestorUntil(object, ts.isCallExpression, owner)
    : null;
  if (!call) {
    return null;
  }
  return forwardedObjectCallTarget(member, object, call);
}

function directCallArgument(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): { argumentIndex: number; call: ts.CallExpression; hookName: string } | null {
  const call = findAncestorUntil(expression, ts.isCallExpression, owner);
  if (!call || nodeWithin(expression, call.expression)) {
    return null;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(expression, argument));
  const hookName = hookCallName(call);
  return argumentIndex !== -1 && hookName ? { argumentIndex, call, hookName } : null;
}

function climbTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function jsxAttributeDirectlyCarries(
  attribute: ts.JsxAttribute,
  expression: ts.Expression,
): boolean {
  const { initializer } = attribute;
  return (
    initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    unwrapTransparentExpression(initializer.expression) === unwrapTransparentExpression(expression)
  );
}

function jsxOwnerTarget(attribute: ts.JsxAttribute | ts.JsxSpreadAttribute): string | null {
  const opening = jsxOwnerOpening(attribute);
  return opening ? jsxTagName(opening.tagName) : null;
}

function jsxOwnerOpening(
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const attributes = attribute.parent;
  const opening = ts.isJsxAttributes(attributes) ? attributes.parent : null;
  return opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))
    ? opening
    : null;
}

function jsxOwnerIsIntrinsic(attribute: ts.JsxAttribute | ts.JsxSpreadAttribute): boolean {
  const opening = jsxOwnerOpening(attribute);
  return (
    opening !== null && ts.isIdentifier(opening.tagName) && /^[a-z]/u.test(opening.tagName.text)
  );
}

function atJsxInvocation(
  source: ChildComponentSource,
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
  invocationOwner: ChildComponentSource | undefined,
): ChildComponentSource {
  const invocation = jsxOwnerOpening(attribute);
  if (!invocation) {
    return source;
  }
  if (!invocationOwner) {
    return { ...source, invocation };
  }
  return { ...source, invocation, invocationOwner };
}

function conditionalTagDeclaration(
  source: ChildComponentSource,
  tagName: string,
): ts.ConditionalExpression | null {
  const declaration = uniqueVariableDeclaration(source.body, tagName);
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(source.owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  return ts.isConditionalExpression(initializer) ? initializer : null;
}

function selectedTagIsIntrinsic(selected: ts.Expression | null): boolean {
  if (!selected) {
    return false;
  }
  const target = unwrapTransparentExpression(selected);
  return ts.isStringLiteralLike(target) && /^[a-z]/u.test(target.text);
}

function conditionalTagResolvesToIntrinsic(source: ChildComponentSource, tagName: string): boolean {
  const initializer = conditionalTagDeclaration(source, tagName);
  if (!initializer) {
    return false;
  }
  const condition = unwrapTransparentExpression(initializer.condition);
  if (!ts.isIdentifier(condition)) {
    return false;
  }
  return selectedTagIsIntrinsic(
    selectedConditionalBranch(initializer, booleanPropAtInvocation(source, condition)),
  );
}

function jsxOwnerIsDeferredEventTarget(
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
  source: ChildComponentSource | undefined,
): boolean {
  if (jsxOwnerIsIntrinsic(attribute)) {
    return true;
  }
  const opening = jsxOwnerOpening(attribute);
  if (!source?.invocation || !opening || !ts.isIdentifier(opening.tagName)) {
    return false;
  }
  return conditionalTagResolvesToIntrinsic(source, opening.tagName.text);
}

function selectedConditionalBranch(
  initializer: ts.ConditionalExpression,
  conditionValue: boolean | null,
): ts.Expression | null {
  if (conditionValue === true) {
    return initializer.whenTrue;
  }
  return conditionValue === false ? initializer.whenFalse : null;
}

function bindingIsWritten(
  source: ChildComponentSource,
  binding: ts.Identifier,
  declared: ts.BindingName,
): boolean {
  let written = false;
  visit(source.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === binding.text &&
      node !== declared &&
      !isNonValueIdentifier(node) &&
      referenceIsWithinWriteTarget(node, source.owner)
    ) {
      written = true;
    }
  });
  return written;
}

function boundBooleanProp(
  source: ChildComponentSource,
  element: ts.BindingElement,
  propName: string,
): boolean | null {
  const value = booleanPropValueAtInvocation(source, propName);
  if (value !== "absent") {
    return value;
  }
  return element.initializer
    ? booleanLiteral(unwrapTransparentExpression(element.initializer))
    : null;
}

function booleanPropAtInvocation(
  source: ChildComponentSource,
  binding: ts.Identifier,
): boolean | null {
  const [parameter] = source.owner.parameters;
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const matches = parameter.name.elements.filter(
    (element) =>
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      element.name.text === binding.text,
  );
  const element = matches.length === 1 ? matches[0] : null;
  const propName = element ? bindingElementPropertyName(element) : null;
  if (
    !element ||
    !propName ||
    bindingDeclarationCount(source.owner, binding.text) !== 1 ||
    bindingIsWritten(source, binding, element.name)
  ) {
    return null;
  }
  return boundBooleanProp(source, element, propName);
}

function jsxBooleanAttributeValue(
  attribute: ts.JsxAttribute,
  propName: string,
): boolean | "absent" | null {
  if (attribute.name.getText() !== propName) {
    return "absent";
  }
  if (!attribute.initializer) {
    return true;
  }
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) {
    return null;
  }
  return booleanLiteral(unwrapTransparentExpression(attribute.initializer.expression));
}

function booleanPropValueAtInvocation(
  source: ChildComponentSource,
  propName: string,
): boolean | "absent" | null {
  if (!source.invocation) {
    return null;
  }
  let value: boolean | "absent" = "absent";
  for (const attribute of source.invocation.attributes.properties) {
    const contributed = ts.isJsxAttribute(attribute)
      ? jsxBooleanAttributeValue(attribute, propName)
      : booleanPropFromSpread(source.invocationOwner, attribute.expression, propName);
    if (contributed === null) {
      return null;
    }
    if (contributed !== "absent") {
      value = contributed;
    }
  }
  return value;
}

function spreadRestBinding(
  owner: ChildComponentSource,
  name: string,
): ts.ObjectBindingPattern | null {
  const [parameter] = owner.owner.parameters;
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const rest = parameter.name.elements.filter(
    (element) =>
      element.dotDotDotToken && ts.isIdentifier(element.name) && element.name.text === name,
  );
  if (rest.length !== 1 || bindingDeclarationCount(owner.owner, name) !== 1) {
    return null;
  }
  return parameter.name;
}

function spreadRestOnlyForwards(owner: ChildComponentSource, name: string): boolean {
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const carried = climbTransparentExpression(node);
    if (!ts.isJsxSpreadAttribute(carried.parent) || carried.parent.expression !== carried) {
      safe = false;
    }
  });
  return safe;
}

function booleanPropFromSpread(
  owner: ChildComponentSource | undefined,
  expression: ts.Expression,
  propName: string,
): boolean | "absent" | null {
  const value = unwrapTransparentExpression(expression);
  if (!owner || !ts.isIdentifier(value)) {
    return null;
  }
  const pattern = spreadRestBinding(owner, value.text);
  if (!pattern || !spreadRestOnlyForwards(owner, value.text)) {
    return null;
  }
  const excluded = pattern.elements.some(
    (element) => !element.dotDotDotToken && bindingElementPropertyName(element) === propName,
  );
  return excluded ? "absent" : booleanPropValueAtInvocation(owner, propName);
}

function booleanLiteral(expression: ts.Expression): boolean | null {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  return null;
}

type WriteTargetVerdict = "continue" | "no" | "yes";

function writeTargetVerdict(
  reference: ts.Identifier,
  current: ts.Node,
  parent: ts.Node,
): WriteTargetVerdict {
  if (ts.isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) {
    return nodeWithin(reference, parent.left) ? "yes" : "no";
  }
  if (
    (ts.isPostfixUnaryExpression(parent) && parent.operand === current) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operand === current &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken))
  ) {
    return "yes";
  }
  if (
    (ts.isDeleteExpression(parent) && parent.expression === current) ||
    ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
      nodeWithin(reference, parent.initializer))
  ) {
    return "yes";
  }
  if (ts.isStatement(parent) || ts.isCallExpression(parent) || isRuntimeFunctionLike(parent)) {
    return "no";
  }
  return "continue";
}

function referenceIsWithinWriteTarget(
  reference: ts.Identifier,
  owner: ChildComponentSource["owner"],
): boolean {
  for (
    let current: ts.Node = reference;
    current.parent && current.parent !== owner;
    current = current.parent
  ) {
    const verdict = writeTargetVerdict(reference, current, current.parent);
    if (verdict !== "continue") {
      return verdict === "yes";
    }
  }
  return false;
}

function jsxTagName(name: ts.JsxTagNameExpression): string | null {
  return ts.isIdentifier(name) || ts.isPropertyAccessExpression(name) ? name.getText() : null;
}

function bindingElementPropertyName(element: ts.BindingElement): string | null {
  if (element.propertyName) {
    return propertyName(element.propertyName);
  }
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

interface ContextPublication {
  contextName: string;
  property: string;
}

function memoizedResultBinding(
  object: ts.ObjectLiteralExpression,
  owner: ChildComponentSource["owner"],
): string | null {
  const call = findAncestorUntil(object, ts.isCallExpression, owner);
  if (
    !call ||
    hookCallName(call) !== "useMemo" ||
    bindingDeclarationCount(owner, "useMemo") !== 0 ||
    !call.arguments[0] ||
    !nodeWithin(object, call.arguments[0])
  ) {
    return null;
  }
  const carriedCall = climbTransparentExpression(call);
  const declaration = carriedCall.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== carriedCall ||
    !ts.isIdentifier(declaration.name) ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  return declaration.name.text;
}

function memoizedObjectProperty(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): { readonly bindingName: string; readonly name: string } | null {
  const member = expression.parent;
  if (
    !ts.isShorthandPropertyAssignment(member) &&
    !(
      ts.isPropertyAssignment(member) &&
      unwrapTransparentExpression(member.initializer) === expression
    )
  ) {
    return null;
  }
  const name = propertyName(member.name);
  const object = member.parent;
  if (!name || !ts.isObjectLiteralExpression(object)) {
    return null;
  }
  const bindingName = memoizedResultBinding(object, owner);
  return bindingName ? { bindingName, name } : null;
}

function providedContextName(
  bindingName: string,
  owner: ChildComponentSource["owner"],
): string | null {
  let contextName: string | null = null;
  let references = 0;
  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== bindingName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    const provider = attribute && jsxContextProvider(attribute, node);
    if (!provider || (contextName !== null && contextName !== provider)) {
      safe = false;
      return;
    }
    contextName = provider;
  });
  return safe && references > 0 ? contextName : null;
}

function memoizedContextPublication(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): ContextPublication | null {
  const published = memoizedObjectProperty(expression, owner);
  if (!published) {
    return null;
  }
  const contextName = providedContextName(published.bindingName, owner);
  return contextName ? { contextName, property: published.name } : null;
}

function jsxContextProvider(attribute: ts.JsxAttribute, expression: ts.Expression): string | null {
  if (attribute.name.getText() !== "value" || !jsxAttributeDirectlyCarries(attribute, expression)) {
    return null;
  }
  const attributes = attribute.parent;
  const opening = ts.isJsxAttributes(attributes) ? attributes.parent : null;
  const tag =
    opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))
      ? opening.tagName
      : null;
  return tag &&
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    tag.name.text === "Provider"
    ? tag.expression.text
    : null;
}

interface ContextConsumerProbe {
  readonly contextName: string;
  readonly property: string;
  readonly providerFile: string;
  readonly trace: CallbackTrace;
}

type ContextConsumerVerdict = "consumed-deferred" | "consumed-undeferred" | "ignored" | "unsafe";

interface ContextConsumerOutcome {
  readonly consumed: boolean;
  readonly safe: boolean;
}

function contextReaderOwner(call: ts.CallExpression): {
  readonly body: ts.ConciseBody;
  readonly owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
} | null {
  const owner = findAncestor(call, isRuntimeFunctionLike);
  if (
    !owner ||
    (!ts.isArrowFunction(owner) &&
      !ts.isFunctionDeclaration(owner) &&
      !ts.isFunctionExpression(owner)) ||
    !owner.body
  ) {
    return null;
  }
  return { body: owner.body, owner };
}

function contextReaderConsumer(node: ts.Identifier): {
  readonly body: ts.ConciseBody;
  readonly declaration: ts.VariableDeclaration;
  readonly owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
} | null {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.expression !== node) {
    return null;
  }
  const resolved = contextReaderOwner(call);
  const carriedCall = climbTransparentExpression(call);
  const declaration = carriedCall.parent;
  if (
    !resolved ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== carriedCall
  ) {
    return null;
  }
  return { body: resolved.body, declaration, owner: resolved.owner };
}

function contextReaderVerdict(
  node: ts.Identifier,
  file: string,
  probe: ContextConsumerProbe,
): ContextConsumerVerdict {
  const { property, trace } = probe;
  if (isDeclarationName(node) || isNonValueIdentifier(node) || isModuleBindingReference(node)) {
    return "ignored";
  }
  const consumer = contextReaderConsumer(node);
  if (!consumer) {
    return "unsafe";
  }
  const tracked = bindCallbackPath(consumer.declaration.name, [property]);
  if (!tracked) {
    return objectBindingOmitsProperty(consumer.declaration.name, property) ? "ignored" : "unsafe";
  }
  return trackedCallbackPathIsDeferred(
    {
      body: consumer.body,
      deferredCallbackHooks: trace.resolver.deferredCallbackHooks(file),
      file,
      owner: consumer.owner,
    },
    tracked,
    trace,
  )
    ? "consumed-deferred"
    : "consumed-undeferred";
}

function contextReaderIdentifiers(
  sourceFile: ts.SourceFile,
  hookNames: ReadonlySet<string>,
): readonly ts.Identifier[] {
  return [...hookNames].flatMap((hookName) => [...identifiersNamed(sourceFile, hookName)]);
}

function contextFileConsumersAreDeferred(
  nodes: readonly ts.Identifier[],
  file: string,
  probe: ContextConsumerProbe,
): ContextConsumerOutcome {
  let consumed = false;
  let safe = true;
  for (const node of nodes) {
    if (!safe) {
      break;
    }
    const verdict = contextReaderVerdict(node, file, probe);
    if (verdict === "consumed-deferred" || verdict === "consumed-undeferred") {
      consumed = true;
    }
    safe = verdict !== "unsafe" && verdict !== "consumed-undeferred";
  }
  return { consumed, safe };
}

function contextReadersOutcome(
  readers: ReadonlyMap<string, ReadonlySet<string>>,
  probe: ContextConsumerProbe,
): ContextConsumerOutcome | null {
  let consumed = false;
  let safe = true;
  for (const [file, hookNames] of readers) {
    const sourceFile = probe.trace.resolver.sourceFile(file);
    if (!sourceFile) {
      return null;
    }
    const outcome = contextFileConsumersAreDeferred(
      contextReaderIdentifiers(sourceFile, hookNames),
      file,
      probe,
    );
    consumed ||= outcome.consumed;
    safe &&= outcome.safe;
  }
  return { consumed, safe };
}

function contextPropertyConsumersAreDeferred(probe: ContextConsumerProbe): boolean {
  const { contextName, providerFile, trace } = probe;
  if (trace.depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const readers = trace.resolver.contextReaderHooks(providerFile, contextName);
  if (readers.size === 0) {
    return false;
  }
  const outcome = contextReadersOutcome(readers, probe);
  return outcome !== null && outcome.safe && outcome.consumed;
}

function isModuleBindingReference(node: ts.Identifier): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) {
      return true;
    }
    if (ts.isSourceFile(current) || isRuntimeFunctionLike(current)) {
      return false;
    }
  }
  return false;
}

function objectBindingOmitsProperty(binding: ts.BindingName, property: string): boolean {
  return (
    ts.isObjectBindingPattern(binding) &&
    !binding.elements.some(
      (element) => element.dotDotDotToken || bindingElementPropertyName(element) === property,
    )
  );
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function isArrayItemLookup(expression: ts.Expression, arrayName: string): boolean {
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === arrayName &&
    expression.expression.name.text === "at"
  );
}

function isFilteredArrayAlias(expression: ts.Expression, arrayNames: ReadonlySet<string>): boolean {
  const call = unwrapTransparentExpression(expression);
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    arrayNames.has(call.expression.expression.text) &&
    call.expression.name.text === "filter" &&
    call.arguments[0] !== undefined &&
    (ts.isArrowFunction(call.arguments[0]) || ts.isFunctionExpression(call.arguments[0]))
  );
}

function isArrayIterationCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  arrayNames: ReadonlySet<string>,
): boolean {
  const call = callback.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[0] === callback &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    arrayNames.has(call.expression.expression.text) &&
    TRACKED_ARRAY_ITERATION_METHODS.has(call.expression.name.text)
  );
}

interface CallbackInvocationProbe {
  readonly callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly depth: number;
  readonly owner: ChildComponentSource["owner"];
  readonly resolver: CallbackContractSourceResolver | undefined;
  readonly seenCallbacks: ReadonlySet<number>;
  readonly source: ChildComponentSource | undefined;
  readonly visited: ReadonlySet<string>;
}

function jsxReferenceIsDeferred(node: ts.Identifier, probe: CallbackInvocationProbe): boolean {
  const { depth, owner, resolver, source, visited } = probe;
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !jsxAttributeCarriesCallbackIdentity(attribute, node)
  ) {
    return false;
  }
  const target = jsxOwnerTarget(attribute);
  if (
    jsxOwnerIsDeferredEventTarget(attribute, source) ||
    (source !== undefined &&
      resolver !== undefined &&
      target !== null &&
      resolver.frameworkEventComponent(source.file, target))
  ) {
    return true;
  }
  const child =
    source && resolver && target ? resolver.resolveComponent(source.file, target) : null;
  return (
    child !== null &&
    resolver !== undefined &&
    sourceInputCallbackIsDeferred({
      argumentIndex: 0,
      path: [attribute.name.getText()],
      source: atJsxInvocation(child, attribute, source),
      trace: { depth: depth + 1, resolver, returnTarget: null, visited },
    })
  );
}

function higherOrderReferenceIsDeferred(
  node: ts.Identifier,
  probe: CallbackInvocationProbe,
): boolean {
  const { depth, resolver, source, visited } = probe;
  return (
    source !== undefined &&
    resolver !== undefined &&
    higherOrderCallDefersCallback(node, source, {
      depth: depth + 1,
      resolver,
      returnTarget: null,
      visited,
    })
  );
}

function invokingCallerIsDeferred(
  node: ts.Identifier,
  nextCallbacks: ReadonlySet<number>,
  probe: CallbackInvocationProbe,
): boolean {
  const { deferredCallbackHooks, depth, owner, resolver, source, visited } = probe;
  if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
    return false;
  }
  const caller = nearestNestedFunction(node, owner);
  if (
    !caller ||
    (!ts.isArrowFunction(caller) &&
      !ts.isFunctionDeclaration(caller) &&
      !ts.isFunctionExpression(caller)) ||
    caller === owner
  ) {
    return false;
  }
  return (
    callbackRunsInProvenDeferredHook(caller, deferredCallbackHooks) ||
    callbackInvocationIsDeferred({
      callback: caller,
      deferredCallbackHooks,
      depth: depth + 1,
      owner,
      resolver,
      seenCallbacks: nextCallbacks,
      source,
      visited,
    })
  );
}

function callbackReferenceIsDeferred(
  node: ts.Identifier,
  nextCallbacks: ReadonlySet<number>,
  probe: CallbackInvocationProbe,
): boolean {
  const { deferredCallbackHooks, owner } = probe;
  if (
    isHookDependencyReference(
      node,
      CALLBACK_IDENTITY_HOOKS,
      reactNamespacesFor(owner.getSourceFile()),
    ) ||
    callbackReferenceIsObservationOnly(node)
  ) {
    return true;
  }
  if (jsxReferenceIsDeferred(node, probe)) {
    return true;
  }
  if (identifierRunsInProvenDeferredHook(node, deferredCallbackHooks)) {
    return true;
  }
  if (higherOrderReferenceIsDeferred(node, probe)) {
    return true;
  }
  return invokingCallerIsDeferred(node, nextCallbacks, probe);
}

function callbackReferencesAreDeferred(
  name: string,
  nextCallbacks: ReadonlySet<number>,
  probe: CallbackInvocationProbe,
): boolean {
  let referenced = false;
  let safe = true;
  for (const node of identifiersNamed(probe.owner.body, name)) {
    if (!safe) {
      break;
    }
    if (isBindingName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    referenced = true;
    safe = callbackReferenceIsDeferred(node, nextCallbacks, probe);
  }
  return referenced && safe;
}

function callbackInvocationIsDeferred(probe: CallbackInvocationProbe): boolean {
  const { callback, deferredCallbackHooks, depth, owner, seenCallbacks } = probe;
  if (depth > MAX_CALLBACK_PATH_DEPTH || seenCallbacks.has(callback.pos)) {
    return false;
  }
  if (isSynchronousRenderCallback(callback) || callbackRunsInImmediateReactHook(callback)) {
    return false;
  }
  const name = callbackBindingName(callback, owner);
  if (!name) {
    return (
      !ts.isFunctionDeclaration(callback) &&
      (callbackIsStoredInProperty(callback) ||
        callbackRunsInProvenDeferredHook(callback, deferredCallbackHooks))
    );
  }
  return callbackReferencesAreDeferred(name, new Set(seenCallbacks).add(callback.pos), probe);
}

function jsxAttributeCarriesCallbackIdentity(
  attribute: ts.JsxAttribute,
  callback: ts.Expression,
): boolean {
  let value = climbTransparentExpression(callback);
  if (
    ts.isConditionalExpression(value.parent) &&
    (value.parent.whenTrue === value || value.parent.whenFalse === value)
  ) {
    value = value.parent;
  }
  return jsxAttributeDirectlyCarries(attribute, value);
}

function jsxEventAttributeIsDeferred(
  attribute: ts.JsxAttribute,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  const { resolver } = trace;
  if (jsxOwnerIsDeferredEventTarget(attribute, source)) {
    return true;
  }
  const target = jsxOwnerTarget(attribute);
  if (target && resolver.frameworkEventComponent(source.file, target)) {
    return true;
  }
  const child = target ? resolver.resolveComponent(source.file, target) : null;
  return (
    child !== null &&
    sourceInputCallbackIsDeferred({
      argumentIndex: 0,
      path: [attribute.name.getText()],
      source: atJsxInvocation(child, attribute, source),
      trace: deeperTrace(trace, null),
    })
  );
}

function callbackIsDeferredByJsx(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  if (ts.isFunctionDeclaration(callback) || trace.depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const expression = climbTransparentExpression(callback);
  const attribute = findAncestorUntil(expression, ts.isJsxAttribute, source.owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !jsxAttributeCarriesCallbackIdentity(attribute, expression)
  ) {
    return false;
  }
  return jsxEventAttributeIsDeferred(attribute, source, trace);
}

function higherOrderFactoryDefersArgument(options: {
  readonly argumentIndex: number;
  readonly call: ts.CallExpression;
  readonly resolver: CallbackContractSourceResolver;
  readonly source: ChildComponentSource;
}): boolean {
  const { argumentIndex, call, resolver, source } = options;
  const callee = call.expression;
  if (!ts.isIdentifier(callee) || bindingDeclarationCount(source.owner, callee.text) !== 1) {
    return false;
  }
  const hookBinding = returnedHookFunctionBinding(source.owner, callee.text);
  if (!hookBinding) {
    return false;
  }
  const hook = resolver.resolveHook(source.file, hookBinding.hookName);
  const factory = hook ? returnedLocalFunction(hook, hookBinding.property) : null;
  return factory !== null && higherOrderFunctionDefersParameter(factory, argumentIndex);
}

function higherOrderCallDefersCallback(
  callback: ts.Identifier,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  if (trace.depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const call = findAncestor(callback, ts.isCallExpression);
  if (!call || nodeWithin(callback, call.expression)) {
    return false;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(callback, argument));
  if (argumentIndex === -1 || !callResultIsDeferredEvent(call, source, trace)) {
    return false;
  }
  return higherOrderFactoryDefersArgument({
    argumentIndex,
    call,
    resolver: trace.resolver,
    source,
  });
}

function deferredEventResultExpression(
  call: ts.CallExpression,
  source: ChildComponentSource,
): ts.Expression | null {
  const result = climbTransparentExpression(call);
  const { parent } = result;
  if (
    !ts.isConditionalExpression(parent) ||
    (parent.whenTrue !== result && parent.whenFalse !== result)
  ) {
    return result;
  }
  const other = parent.whenTrue === result ? parent.whenFalse : parent.whenTrue;
  return isNullishExpression(other, source.owner) ? parent : null;
}

function callResultIsDeferredEvent(
  call: ts.CallExpression,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  const result = deferredEventResultExpression(call, source);
  if (!result) {
    return false;
  }
  const attribute = findAncestorUntil(result, ts.isJsxAttribute, source.owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !jsxAttributeDirectlyCarries(attribute, result)
  ) {
    return false;
  }
  return jsxEventAttributeIsDeferred(attribute, source, trace);
}

function isNullishExpression(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) &&
      value.text === "undefined" &&
      bindingDeclarationCount(owner, "undefined") === 0)
  );
}

function returnedHookFunctionBinding(
  owner: ChildComponentSource["owner"],
  localName: string,
): { hookName: string; property: string } | null {
  let binding: { hookName: string; property: string } | null = null;
  visit(owner.body, (node) => {
    if (
      binding ||
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer
    ) {
      return;
    }
    const matches = node.name.elements.filter(
      (element) => ts.isIdentifier(element.name) && element.name.text === localName,
    );
    const match = matches.length === 1 ? matches[0] : null;
    const call = unwrapTransparentExpression(node.initializer);
    const hookName = ts.isCallExpression(call) ? hookCallName(call) : null;
    const property = match ? bindingElementPropertyName(match) : null;
    if (hookName && property) {
      binding = { hookName, property };
    }
  });
  return binding;
}

function returnedObjectPropertyValue(
  expression: ts.Expression,
  property: string,
): ts.Identifier | null {
  const returned = unwrapTransparentExpression(expression);
  if (!ts.isObjectLiteralExpression(returned)) {
    return null;
  }
  const matches = returned.properties.filter(
    (member) =>
      (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
      propertyName(member.name) === property,
  );
  const match = matches.length === 1 ? matches[0] : null;
  const value = objectLiteralPropertyValue(match);
  return value && ts.isIdentifier(value) ? value : null;
}

function soleReturnedPropertyName(source: ChildComponentSource, property: string): string | null {
  const names = new Set<string>();
  let safe = true;
  visit(source.owner.body, (node) => {
    if (!safe || !ts.isReturnStatement(node) || !node.expression) {
      return;
    }
    if (findAncestor(node, isRuntimeFunctionLike) !== source.owner) {
      return;
    }
    const value = returnedObjectPropertyValue(node.expression, property);
    if (!value) {
      safe = false;
      return;
    }
    names.add(value.text);
  });
  const [name] = names;
  return safe && names.size === 1 && name ? name : null;
}

function localFunctionInitializer(
  initializer: ts.Expression,
  owner: ChildComponentSource["owner"],
): ts.ArrowFunction | ts.FunctionExpression | null {
  const value = unwrapTransparentExpression(initializer);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  const [argument] = ts.isCallExpression(value) ? value.arguments : [];
  if (
    !ts.isCallExpression(value) ||
    hookCallName(value) !== "useCallback" ||
    bindingDeclarationCount(owner, "useCallback") !== 0 ||
    !argument ||
    (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument))
  ) {
    return null;
  }
  return argument;
}

function localFunctionNamed(
  source: ChildComponentSource,
  name: string,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  let result: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null = null;
  visit(source.owner.body, (node) => {
    if (result) {
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      result = node;
      return;
    }
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== name ||
      !node.initializer
    ) {
      return;
    }
    result = localFunctionInitializer(node.initializer, source.owner);
  });
  return result;
}

function returnedLocalFunction(
  source: ChildComponentSource,
  property: string,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const name = soleReturnedPropertyName(source, property);
  if (!name || bindingDeclarationCount(source.owner, name) !== 1) {
    return null;
  }
  return localFunctionNamed(source, name);
}

function objectLiteralPropertyValue(
  member: ts.ObjectLiteralElementLike | null | undefined,
): ts.Expression | null {
  if (member && ts.isShorthandPropertyAssignment(member)) {
    return member.name;
  }
  if (member && ts.isPropertyAssignment(member)) {
    return unwrapTransparentExpression(member.initializer);
  }
  return null;
}

function higherOrderFunctionDefersParameter(
  factory: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  argumentIndex: number,
): boolean {
  const parameter = factory.parameters[argumentIndex];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return false;
  }
  const parameterName = parameter.name.text;
  let references = 0;
  let safe = true;
  visit(factory.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== parameterName ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (callbackReferenceIsObservationOnly(node)) {
      return;
    }
    const call = findAncestorUntil(node, ts.isCallExpression, factory);
    const wrapper = nearestNestedFunction(node, factory);
    if (
      !call ||
      nodeWithin(node, call.expression) === false ||
      !wrapper ||
      (!ts.isArrowFunction(wrapper) && !ts.isFunctionExpression(wrapper)) ||
      !functionIsDirectlyReturned(wrapper, factory)
    ) {
      safe = false;
    }
  });
  return safe && references > 0;
}

function functionIsDirectlyReturned(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  if (!owner.body) {
    return false;
  }
  if (!ts.isBlock(owner.body)) {
    return unwrapTransparentExpression(owner.body) === callback;
  }
  const statement = findAncestorUntil(callback, ts.isReturnStatement, owner);
  return (
    statement?.expression !== undefined &&
    unwrapTransparentExpression(statement.expression) === callback
  );
}

function callbackBindingName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: ChildComponentSource["owner"],
): string | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text ?? null;
  }
  if (ts.isVariableDeclaration(callback.parent) && ts.isIdentifier(callback.parent.name)) {
    return callback.parent.name.text;
  }
  const call = memoizedCallbackIdentityCall(callback, owner);
  if (!call) {
    return null;
  }
  const expression = climbTransparentExpression(call);
  const declaration = expression.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === expression &&
    ts.isIdentifier(declaration.name) &&
    bindingDeclarationCount(owner, declaration.name.text) === 1
    ? declaration.name.text
    : null;
}

function memoizedCallbackIdentityCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: ChildComponentSource["owner"],
): ts.CallExpression | null {
  const direct = callback.parent;
  if (
    ts.isCallExpression(direct) &&
    direct.arguments[0] === callback &&
    hookCallName(direct) === "useCallback" &&
    bindingDeclarationCount(owner, "useCallback") === 0
  ) {
    return direct;
  }
  const returned = climbTransparentExpression(callback);
  const factory = returned.parent;
  if (!ts.isArrowFunction(factory) || factory.body !== returned) {
    return null;
  }
  const memo = factory.parent;
  return ts.isCallExpression(memo) &&
    memo.arguments[0] === factory &&
    hookCallName(memo) === "useMemo" &&
    bindingDeclarationCount(owner, "useMemo") === 0
    ? memo
    : null;
}

function identifierRunsInProvenDeferredHook(
  identifier: ts.Identifier,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  const call = findAncestor(identifier, ts.isCallExpression);
  if (!call || nodeWithin(identifier, call.expression)) {
    return false;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(identifier, argument));
  const hookName = hookCallName(call);
  return (
    argumentIndex !== -1 &&
    hookName !== null &&
    deferredCallbackHooks.get(hookName)?.has(argumentIndex) === true
  );
}

function callbackRunsInProvenDeferredHook(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  if (ts.isFunctionDeclaration(callback)) {
    return false;
  }
  const call = callback.parent;
  if (!ts.isCallExpression(call)) {
    return false;
  }
  const argumentIndex = call.arguments.indexOf(callback);
  const hookName = hookCallName(call);
  return (
    argumentIndex !== -1 &&
    hookName !== null &&
    deferredCallbackHooks.get(hookName)?.has(argumentIndex) === true
  );
}

function callbackIsStoredInProperty(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let expression: ts.Expression = callback;
  while (
    (ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  if (
    ts.isConditionalExpression(expression.parent) &&
    (expression.parent.whenTrue === expression || expression.parent.whenFalse === expression)
  ) {
    expression = expression.parent;
  }
  return ts.isPropertyAssignment(expression.parent) && expression.parent.initializer === expression;
}

function callbackRunsInImmediateReactHook(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  if (ts.isFunctionDeclaration(callback)) {
    return false;
  }
  const call = callback.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(callback)) {
    return false;
  }
  return [
    "useEffect",
    "useInsertionEffect",
    "useLayoutEffect",
    "useMemo",
    "useReducer",
    "useState",
  ].includes(hookCallName(call) ?? "");
}

function destructuredSourceName(element: ts.BindingElement): string | null {
  if (element.propertyName && ts.isIdentifier(element.propertyName)) {
    return element.propertyName.text;
  }
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

function directPropBinding(
  pattern: ts.ObjectBindingPattern,
  propName: string,
): ts.Identifier | null {
  for (const element of pattern.elements) {
    if (
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      destructuredSourceName(element) === propName
    ) {
      return element.name;
    }
  }
  return null;
}

function renamedPropBinding(
  pattern: ts.ObjectBindingPattern,
  propName: string,
): ts.Identifier | null {
  for (const element of pattern.elements) {
    if (
      !element.dotDotDotToken &&
      ts.isIdentifier(element.name) &&
      !element.initializer &&
      destructuredSourceName(element) === propName
    ) {
      return element.name;
    }
  }
  return null;
}

function restPropBinding(
  owner: ChildComponentSource["owner"],
  rest: ts.Identifier,
  propName: string,
): ts.Identifier | null {
  let bound: ts.Identifier | null = null;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !ts.isIdentifier(node) || node.text !== rest.text || isNonValueIdentifier(node)) {
      return;
    }
    const declaration = node.parent;
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer !== node ||
      !ts.isObjectBindingPattern(declaration.name)
    ) {
      safe = false;
      return;
    }
    bound ??= renamedPropBinding(declaration.name, propName);
  });
  return safe ? bound : null;
}

function boundPropIdentifier(
  owner: ChildComponentSource["owner"],
  propName: string,
): ts.Identifier | null {
  const [parameter] = owner.parameters;
  if (!parameter || owner.parameters.length !== 1 || !ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const direct = directPropBinding(parameter.name, propName);
  if (direct) {
    return direct;
  }
  const rest = restBindingElement(parameter.name.elements);
  if (!rest || !owner.body || bindingDeclarationCount(owner, rest.text) !== 1) {
    return null;
  }
  return restPropBinding(owner, rest, propName);
}

function isBindingName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    ts.isBindingElement(parent) ||
    ts.isVariableDeclaration(parent) ||
    (ts.isParameter(parent) && parent.name === node)
  );
}

function referenceIsWritten(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operand === node) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === node) ||
    (ts.isDeleteExpression(parent) && parent.expression === node)
  );
}

function isCustomJsxTag(attribute: ts.JsxAttribute): boolean {
  const container: ts.Node = attribute.parent;
  const element = ts.isJsxAttributes(container) ? container.parent : container;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return true;
  }
  const tag = element.tagName.getText();
  return /^[A-Z]/u.test(tag) || tag.includes(".");
}

function isJsxNode(
  node: ts.Node,
): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | ts.JsxExpression {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isJsxExpression(node)
  );
}

/**
 * Accepts one bounded chain of immutable pure projections
 * (`const label = open ? "Close" : "Open"`) whose expression contains no
 * calls, awaits, assignments, or spreads, and tracks the projected name so
 * its own later reads participate in the same proof.
 */
function tracksPureProjection(
  node: ts.Identifier,
  owner: ChildComponentSource["owner"],
  tracked: Set<string>,
): boolean {
  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !declaration.initializer ||
    !nodeWithin(node, declaration.initializer) ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1 ||
    tracked.size >= MAX_TRACKED_NAMES
  ) {
    return false;
  }
  let depth = 0;
  let pure = true;
  visit(declaration.initializer, (current) => {
    if (!pure) {
      return;
    }
    if (
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isYieldExpression(current) ||
      ts.isSpreadElement(current) ||
      (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind))
    ) {
      pure = false;
      return;
    }
    if (ts.isIdentifier(current) && tracked.has(current.text)) {
      depth += 1;
    }
  });
  if (!pure || depth === 0) {
    return false;
  }
  tracked.add(declaration.name.text);
  return true;
}
