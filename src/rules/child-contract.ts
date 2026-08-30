import ts from "typescript";

import {
  bindingDeclarationCount,
  hookCallName,
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
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
import { collectHookImports, isImportedHookCall } from "../imports.js";
import type { HookImports } from "../imports.js";

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

const MAX_TRACKED_NAMES = 8,
  TRACKED_ARRAY_ITERATION_METHODS = new Set([
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

  let renderReads = 0,
    safe = true;
  const tracked = new Set([bound.text]);
  visit(source.owner.body, (node) => {
    if (!safe || !ts.isIdentifier(node) || !tracked.has(node.text)) {
      return;
    }
    if (isNonValueIdentifier(node)) {
      return;
    }
    if (isBindingName(node)) {
      return;
    }
    if (findAncestor(node, isRuntimeFunctionLike) !== source.owner) {
      safe = false;
      return;
    }
    if (referenceIsWritten(node)) {
      safe = false;
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, source.owner);
    if (attribute) {
      if (isCustomJsxTag(attribute)) {
        safe = false;
        return;
      }
      renderReads += 1;
      return;
    }
    if (findAncestorUntil(node, isJsxNode, source.owner)) {
      renderReads += 1;
      return;
    }
    if (tracksPureProjection(node, source.owner, tracked)) {
      return;
    }
    safe = false;
  });
  return safe && renderReads > 0;
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
  const bound = boundPropIdentifier(source.owner, propName),
    type = declaredPropType(source, propName);
  if (!bound || !type || !primitiveValueType(type)) {
    return false;
  }
  if (bindingDeclarationCount(source.owner, bound.text) !== 1) {
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

function declaredPropType(source: ChildComponentSource, propName: string): ts.TypeNode | null {
  const parameter = source.owner.parameters[0];
  if (!parameter?.type || source.owner.parameters.length !== 1) {
    return null;
  }
  let propsType = parameter.type;
  while (ts.isParenthesizedTypeNode(propsType)) {
    propsType = propsType.type;
  }

  let members: ts.NodeArray<ts.TypeElement> | null = null;
  if (ts.isTypeLiteralNode(propsType)) {
    members = propsType.members;
  } else if (ts.isTypeReferenceNode(propsType) && ts.isIdentifier(propsType.typeName)) {
    const typeName = propsType.typeName.text,
      declarations: (ts.InterfaceDeclaration | ts.TypeAliasDeclaration)[] = [];
    for (const statement of source.owner.getSourceFile().statements) {
      if (
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === typeName
      ) {
        declarations.push(statement);
      }
    }
    if (declarations.length !== 1) {
      return null;
    }
    const declaration = declarations[0]!;
    if (ts.isInterfaceDeclaration(declaration)) {
      if (declaration.heritageClauses?.length) {
        return null;
      }
      members = declaration.members;
    } else {
      let alias = declaration.type;
      while (ts.isParenthesizedTypeNode(alias)) {
        alias = alias.type;
      }
      if (!ts.isTypeLiteralNode(alias)) {
        return null;
      }
      members = alias.members;
    }
  }
  if (!members) {
    return null;
  }

  const properties = members.filter(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && staticPropertyName(member.name) === propName,
  );
  return properties.length === 1 ? (properties[0]!.type ?? null) : null;
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
export function propDefersArrayItemCallback(
  source: ChildComponentSource,
  propName: string,
  callbackProp: string,
  resolver: CallbackContractSourceResolver | undefined,
): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body) {
    return false;
  }
  if (bindingDeclarationCount(source.owner, bound.text) !== 1) {
    return false;
  }

  const arrayNames = new Set([bound.text]);
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
  if (!arrayBindingsStayWithinTrackedConsumers(source, arrayNames)) {
    return false;
  }

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
  if (itemNames.size === 0) {
    return false;
  }

  let references = 0,
    safe = true;
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
    const member = node.parent;
    if (
      ts.isSpreadAssignment(member) &&
      member.expression === node &&
      spreadCallbackIsOverridden(member, callbackProp)
    ) {
      return;
    }
    if (!ts.isPropertyAccessExpression(member) || member.expression !== node) {
      const callback = nearestNestedFunction(node, source.owner);
      safe =
        callback !== null &&
        callback !== source.owner &&
        (ts.isArrowFunction(callback) ||
          ts.isFunctionDeclaration(callback) ||
          ts.isFunctionExpression(callback)) &&
        callbackInvocationIsDeferred(
          callback,
          source.owner,
          source.deferredCallbackHooks,
          resolver ? source : undefined,
          resolver,
        );
      return;
    }
    if (member.name.text !== callbackProp) {
      return;
    }

    references += 1;
    if (ts.isCallExpression(member.parent) && member.parent.expression === member) {
      const callback = nearestNestedFunction(member, source.owner);
      if (
        !callback ||
        (!ts.isArrowFunction(callback) &&
          !ts.isFunctionDeclaration(callback) &&
          !ts.isFunctionExpression(callback)) ||
        callback === source.owner ||
        !callbackInvocationIsDeferred(
          callback,
          source.owner,
          source.deferredCallbackHooks,
          resolver ? source : undefined,
          resolver,
        )
      ) {
        safe = false;
      }
      return;
    }
    if (callbackReferenceIsObservationOnly(member)) {
      return;
    }

    const attribute = findAncestorUntil(member, ts.isJsxAttribute, source.owner);
    if (!resolver || !attribute || !jsxAttributeDirectlyCarries(attribute, member)) {
      safe = false;
      return;
    }
    const prop = attribute.name.getText(),
      target = jsxOwnerTarget(attribute);
    if (!/^on[A-Z]/u.test(prop) || !target) {
      safe = false;
      return;
    }
    if (
      jsxOwnerIsDeferredEventTarget(attribute, source) ||
      resolver.frameworkEventComponent(source.file, target)
    ) {
      return;
    }
    const child = resolver.resolveComponent(source.file, target);
    if (
      child === null ||
      !sourceInputCallbackIsDeferred(
        atJsxInvocation(child, attribute, source),
        0,
        [prop],
        resolver,
        new Set(),
        0,
      )
    ) {
      safe = false;
    }
  });
  return safe && references > 0;
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
    const value = climbTransparentExpression(node),
      member = value.parent;
    if (!ts.isPropertyAccessExpression(member) || member.expression !== value) {
      safe = false;
      return;
    }
    if (member.name.text === "length") {
      return;
    }
    if (
      ts.isCallExpression(member.parent) &&
      member.parent.expression === member &&
      (member.name.text === "at" || TRACKED_ARRAY_ITERATION_METHODS.has(member.name.text))
    ) {
      return;
    }
    safe = false;
  });
  return safe;
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
  return sourceInputCallbackIsDeferred(
    source,
    0,
    [propName, callbackProperty],
    resolver,
    new Set(),
    0,
  );
}

export function propCallbackIsDeferred(
  source: ChildComponentSource,
  propName: string,
  resolver: CallbackContractSourceResolver,
): boolean {
  return sourceInputCallbackIsDeferred(source, 0, [propName], resolver, new Set(), 0);
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
  let invocations = 0,
    safe = true;
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
      const effect = parent.arguments[0],
        dependencies = parent.arguments[1];
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
    current = parent;
  }
  return null;
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

const MAX_CALLBACK_PATH_DEPTH = 32,
  CALLBACK_IDENTITY_HOOKS = new Set([
    "useCallback",
    "useEffect",
    "useInsertionEffect",
    "useLayoutEffect",
    "useMemo",
  ]),
  reactNamespacesBySourceFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function reactNamespacesFor(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = reactNamespacesBySourceFile.get(sourceFile);
  if (cached) {
    return cached;
  }
  const namespaces = collectHookImports(sourceFile).reactNamespaces;
  reactNamespacesBySourceFile.set(sourceFile, namespaces);
  return namespaces;
}

function sourceInputCallbackIsDeferred(
  source: ChildComponentSource,
  argumentIndex: number,
  path: readonly string[],
  resolver: CallbackContractSourceResolver,
  visited: ReadonlySet<string>,
  depth: number,
  returnTarget: CallbackReturnTarget | null = null,
): boolean {
  if (depth > MAX_CALLBACK_PATH_DEPTH || !source.owner.body) {
    return false;
  }
  const parameter = source.owner.parameters[argumentIndex],
    tracked = parameter ? bindCallbackPath(parameter.name, path) : null;
  return (
    tracked !== null &&
    trackedCallbackPathIsDeferred(source, tracked, resolver, visited, depth, returnTarget)
  );
}

function bindCallbackPath(
  binding: ts.BindingName,
  path: readonly string[],
): TrackedCallbackPath | null {
  if (ts.isIdentifier(binding)) {
    return { name: binding.text, path };
  }
  if (!ts.isObjectBindingPattern(binding)) {
    return null;
  }
  const [head, ...tail] = path;
  if (!head) {
    return null;
  }
  let rest: ts.Identifier | null = null;
  for (const element of binding.elements) {
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) {
        rest = element.name;
      }
      continue;
    }
    if (!ts.isIdentifier(element.name)) {
      continue;
    }
    if (bindingElementPropertyName(element) === head) {
      return { name: element.name.text, path: tail };
    }
  }
  return rest ? { name: rest.text, path } : null;
}

function trackedCallbackPathIsDeferred(
  source: ChildComponentSource,
  tracked: TrackedCallbackPath,
  resolver: CallbackContractSourceResolver,
  visited: ReadonlySet<string>,
  depth: number,
  returnTarget: CallbackReturnTarget | null = null,
): boolean {
  if (
    depth > MAX_CALLBACK_PATH_DEPTH ||
    bindingDeclarationCount(source.owner, tracked.name) !== 1
  ) {
    return false;
  }
  const invocationKey = source.invocation
      ? `${source.invocation.getSourceFile().fileName}:${source.invocation.pos}`
      : "",
    key = `${source.file}\0${source.owner.pos}\0${invocationKey}\0${tracked.name}\0${tracked.path.join(".")}`;
  if (visited.has(key)) {
    return false;
  }
  const nextVisited = new Set(visited).add(key);
  let references = 0,
    safe = true;
  for (const node of identifiersNamed(source.owner.body, tracked.name)) {
    if (!safe) {
      break;
    }
    if (isBindingName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    references += 1;
    safe = callbackPathReferenceIsDeferred(
      source,
      node,
      tracked.path,
      resolver,
      nextVisited,
      depth,
      returnTarget,
    );
  }
  return safe && references > 0;
}

function callbackPathReferenceIsDeferred(
  source: ChildComponentSource,
  reference: ts.Identifier,
  path: readonly string[],
  resolver: CallbackContractSourceResolver,
  visited: ReadonlySet<string>,
  depth: number,
  returnTarget: CallbackReturnTarget | null,
): boolean {
  const expression = climbTransparentExpression(reference),
    [head, ...tail] = path;
  if (head) {
    const access = staticPropertyAccessFrom(expression);
    if (access) {
      return (
        access.name !== head ||
        callbackPathExpressionIsDeferred(
          source,
          access.expression,
          tail,
          resolver,
          visited,
          depth,
          returnTarget,
        )
      );
    }
    const destructured = destructuredCallbackPath(source.owner, expression, path);
    if (destructured) {
      return trackedCallbackPathIsDeferred(
        source,
        destructured,
        resolver,
        visited,
        depth + 1,
        returnTarget,
      );
    }
  }
  return callbackPathExpressionIsDeferred(
    source,
    expression,
    path,
    resolver,
    visited,
    depth,
    returnTarget,
  );
}

function callbackPathExpressionIsDeferred(
  source: ChildComponentSource,
  expression: ts.Expression,
  path: readonly string[],
  resolver: CallbackContractSourceResolver,
  visited: ReadonlySet<string>,
  depth: number,
  returnTarget: CallbackReturnTarget | null,
): boolean {
  const value = climbTransparentExpression(expression),
    alias = directConstAlias(value, source.owner);
  if (alias) {
    return trackedCallbackPathIsDeferred(
      source,
      { name: alias.text, path },
      resolver,
      visited,
      depth + 1,
      returnTarget,
    );
  }

  if (returnTarget) {
    const returnedPath = returnedCallbackPath(value, path, source.owner);
    if (returnedPath === "ignored") {
      return true;
    }
    if (
      returnedPath &&
      callResultCallbackIsDeferred(returnTarget, returnedPath, resolver, visited, depth + 1)
    ) {
      return true;
    }
  }

  const attribute = findAncestorUntil(value, ts.isJsxAttribute, source.owner);
  if (
    attribute?.initializer &&
    nodeWithin(value, attribute.initializer) &&
    jsxAttributeCarriesCallbackIdentity(attribute, value)
  ) {
    if (
      path.length === 0 &&
      /^on[A-Z]/u.test(attribute.name.getText()) &&
      jsxOwnerIsDeferredEventTarget(attribute, source)
    ) {
      return true;
    }
    const target = jsxOwnerTarget(attribute);
    if (
      path.length === 0 &&
      target &&
      /^on[A-Z]/u.test(attribute.name.getText()) &&
      resolver.frameworkEventComponent(source.file, target)
    ) {
      return true;
    }
    const child = target ? resolver.resolveComponent(source.file, target) : null;
    return (
      child !== null &&
      sourceInputCallbackIsDeferred(
        atJsxInvocation(child, attribute, source),
        0,
        [attribute.name.getText(), ...path],
        resolver,
        visited,
        depth + 1,
      )
    );
  }

  const spread = findAncestorUntil(value, ts.isJsxSpreadAttribute, source.owner);
  if (
    spread &&
    nodeWithin(value, spread.expression) &&
    unwrapTransparentExpression(spread.expression) === unwrapTransparentExpression(value)
  ) {
    const target = jsxOwnerTarget(spread);
    if (
      target &&
      path.length === 1 &&
      /^on[A-Z]/u.test(path[0] ?? "") &&
      (jsxOwnerIsDeferredEventTarget(spread, source) ||
        resolver.frameworkEventComponent(source.file, target))
    ) {
      return true;
    }
    const child = target ? resolver.resolveComponent(source.file, target) : null;
    return (
      child !== null &&
      sourceInputCallbackIsDeferred(
        atJsxInvocation(child, spread, source),
        0,
        path,
        resolver,
        visited,
        depth + 1,
      )
    );
  }

  if (
    ts.isIdentifier(value) &&
    isHookDependencyReference(
      value,
      CALLBACK_IDENTITY_HOOKS,
      reactNamespacesFor(source.owner.getSourceFile()),
    )
  ) {
    return true;
  }

  if (path.length === 0 && callbackReferenceIsObservationOnly(value)) {
    return true;
  }

  if (path.length === 0) {
    const arrayPublication = deferredArrayItemCallbackPublication(source, value, resolver);
    if (arrayPublication !== null) {
      return arrayPublication;
    }
  }

  if (path.length === 0) {
    const publication = memoizedContextPublication(value, source.owner);
    if (
      publication &&
      contextPropertyConsumersAreDeferred(
        resolver,
        source.file,
        publication.contextName,
        publication.property,
        visited,
        depth + 1,
      )
    ) {
      return true;
    }
  }

  if (path.length === 0) {
    const callback = nearestNestedFunction(value, source.owner);
    if (
      callback &&
      (ts.isArrowFunction(callback) ||
        ts.isFunctionDeclaration(callback) ||
        ts.isFunctionExpression(callback)) &&
      (callbackIsDeferredByJsx(callback, source, resolver, visited, depth + 1) ||
        callbackInvocationIsDeferred(
          callback,
          source.owner,
          source.deferredCallbackHooks,
          source,
          resolver,
          visited,
          depth + 1,
        ))
    ) {
      return true;
    }
  }

  const objectForward = forwardedObjectCall(value, source.owner);
  if (objectForward) {
    const hook = resolver.resolveHook(source.file, objectForward.hookName);
    return (
      hook !== null &&
      sourceInputCallbackIsDeferred(
        hook,
        objectForward.argumentIndex,
        [objectForward.property, ...path],
        resolver,
        visited,
        depth + 1,
        { call: objectForward.call, source },
      )
    );
  }

  const directCall = directCallArgument(value, source.owner);
  if (directCall) {
    if (
      path.length === 0 &&
      resolver.hookCallbackIsDeferred(source.file, directCall.hookName, directCall.argumentIndex)
    ) {
      return true;
    }
    const hook = resolver.resolveHook(source.file, directCall.hookName);
    return (
      hook !== null &&
      sourceInputCallbackIsDeferred(
        hook,
        directCall.argumentIndex,
        path,
        resolver,
        visited,
        depth + 1,
        { call: directCall.call, source },
      )
    );
  }

  return false;
}

function deferredArrayItemCallbackPublication(
  source: ChildComponentSource,
  callback: ts.Expression,
  resolver: CallbackContractSourceResolver,
): boolean | null {
  const property = callback.parent;
  if (
    !ts.isPropertyAssignment(property) ||
    unwrapTransparentExpression(property.initializer) !== callback
  ) {
    return null;
  }
  const callbackProperty = propertyName(property.name),
    object = property.parent,
    carriedObject = ts.isObjectLiteralExpression(object)
      ? climbTransparentExpression(object)
      : null,
    array = carriedObject?.parent;
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

  const carriedArray = climbTransparentExpression(array),
    declaration = carriedArray.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== carriedArray ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(source.owner, declaration.name.text) !== 1
  ) {
    return false;
  }
  const arrayBinding = declaration.name.text;

  let publications = 0,
    safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== arrayBinding ||
      node === declaration.name ||
      isBindingName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, source.owner);
    if (!attribute || !jsxAttributeDirectlyCarries(attribute, node)) {
      safe = false;
      return;
    }
    const target = jsxOwnerTarget(attribute),
      child = target ? resolver.resolveComponent(source.file, target) : null;
    if (
      !child ||
      !propDefersArrayItemCallback(
        atJsxInvocation(child, attribute, source),
        attribute.name.getText(),
        callbackProperty,
        resolver,
      )
    ) {
      safe = false;
      return;
    }
    publications += 1;
  });
  return safe && publications > 0;
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

function callbackReferenceIsObservationOnly(expression: ts.Expression): boolean {
  const { parent } = expression;
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
  if (ts.isTypeQueryNode(parent) && parent.exprName === expression) {
    return true;
  }
  if (!ts.isBinaryExpression(parent)) {
    return false;
  }
  if (
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(parent.operatorToken.kind)
  ) {
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

function returnedCallbackPath(
  value: ts.Expression,
  path: readonly string[],
  owner: ChildComponentSource["owner"],
): readonly string[] | "ignored" | null {
  const directReturn = findAncestorUntil(value, ts.isReturnStatement, owner);
  if (
    directReturn?.expression &&
    findAncestor(directReturn, isRuntimeFunctionLike) === owner &&
    unwrapTransparentExpression(directReturn.expression) === unwrapTransparentExpression(value)
  ) {
    return path;
  }
  const object = findAncestorUntil(value, ts.isObjectLiteralExpression, owner);
  if (!object) {
    return null;
  }
  const objectReturn = findAncestorUntil(object, ts.isReturnStatement, owner);
  if (
    !objectReturn?.expression ||
    findAncestor(objectReturn, isRuntimeFunctionLike) !== owner ||
    unwrapTransparentExpression(objectReturn.expression) !== object
  ) {
    return null;
  }
  const index = object.properties.findIndex((member) => nodeWithin(value, member)),
    member = index === -1 ? null : object.properties[index];
  if (!member) {
    return null;
  }
  if (ts.isSpreadAssignment(member)) {
    const head = path[0],
      overridden =
        head &&
        object.properties
          .slice(index + 1)
          .some(
            (candidate) =>
              (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
              propertyName(candidate.name) === head,
          );
    return overridden ? "ignored" : path;
  }
  if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
    return null;
  }
  const property = propertyName(member.name);
  return property ? [property, ...path] : null;
}

function callResultCallbackIsDeferred(
  target: CallbackReturnTarget,
  path: readonly string[],
  resolver: CallbackContractSourceResolver,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  const expression = climbTransparentExpression(target.call),
    alias = directConstAlias(expression, target.source.owner);
  return (
    alias !== null &&
    trackedCallbackPathIsDeferred(
      target.source,
      { name: alias.text, path },
      resolver,
      visited,
      depth,
    )
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
    ),
    match = matches.length === 1 ? matches[0] : null;
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
  const left = unwrapTransparentExpression(unwrapped.left),
    right = unwrapTransparentExpression(unwrapped.right);
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
  if (!ts.isObjectLiteralExpression(object)) {
    return null;
  }
  const call = findAncestorUntil(object, ts.isCallExpression, owner);
  if (!call) {
    return null;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(object, argument)),
    hookName = hookCallName(call),
    property = propertyName(member.name);
  return argumentIndex !== -1 && hookName && property
    ? { argumentIndex, call, hookName, property }
    : null;
}

function directCallArgument(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): { argumentIndex: number; call: ts.CallExpression; hookName: string } | null {
  const call = findAncestorUntil(expression, ts.isCallExpression, owner);
  if (!call || nodeWithin(expression, call.expression)) {
    return null;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(expression, argument)),
    hookName = hookCallName(call);
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
  const attributes = attribute.parent,
    opening = ts.isJsxAttributes(attributes) ? attributes.parent : null;
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

  const declaration = uniqueVariableDeclaration(source.body, opening.tagName.text);
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(source.owner, declaration.name.text) !== 1
  ) {
    return false;
  }

  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (!ts.isConditionalExpression(initializer)) {
    return false;
  }
  const condition = unwrapTransparentExpression(initializer.condition);
  if (!ts.isIdentifier(condition)) {
    return false;
  }
  const conditionValue = booleanPropAtInvocation(source, condition),
    selected =
      conditionValue === true
        ? initializer.whenTrue
        : conditionValue === false
          ? initializer.whenFalse
          : null;
  if (!selected) {
    return false;
  }
  const target = unwrapTransparentExpression(selected);
  return ts.isStringLiteralLike(target) && /^[a-z]/u.test(target.text);
}

function booleanPropAtInvocation(
  source: ChildComponentSource,
  binding: ts.Identifier,
): boolean | null {
  const parameter = source.owner.parameters[0];
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const matches = parameter.name.elements.filter(
      (element) =>
        !element.dotDotDotToken &&
        ts.isIdentifier(element.name) &&
        element.name.text === binding.text,
    ),
    element = matches.length === 1 ? matches[0] : null,
    propName = element ? bindingElementPropertyName(element) : null;
  if (!element || !propName || bindingDeclarationCount(source.owner, binding.text) !== 1) {
    return null;
  }

  let written = false;
  visit(source.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === binding.text &&
      node !== element.name &&
      !isNonValueIdentifier(node) &&
      referenceIsWithinWriteTarget(node, source.owner)
    ) {
      written = true;
    }
  });
  if (written) {
    return null;
  }

  const value = booleanPropValueAtInvocation(source, propName);
  if (value !== "absent") {
    return value;
  }
  return element.initializer
    ? booleanLiteral(unwrapTransparentExpression(element.initializer))
    : null;
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
    if (ts.isJsxAttribute(attribute)) {
      if (attribute.name.getText() !== propName) {
        continue;
      }
      if (!attribute.initializer) {
        value = true;
        continue;
      }
      if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) {
        return null;
      }
      const explicit = booleanLiteral(
        unwrapTransparentExpression(attribute.initializer.expression),
      );
      if (explicit === null) {
        return null;
      }
      value = explicit;
      continue;
    }
    const spread = booleanPropFromSpread(source.invocationOwner, attribute.expression, propName);
    if (spread === null) {
      return null;
    }
    if (spread !== "absent") {
      value = spread;
    }
  }
  return value;
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
  const parameter = owner.owner.parameters[0];
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const rest = parameter.name.elements.filter(
    (element) =>
      element.dotDotDotToken && ts.isIdentifier(element.name) && element.name.text === value.text,
  );
  if (rest.length !== 1 || bindingDeclarationCount(owner.owner, value.text) !== 1) {
    return null;
  }

  let safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== value.text ||
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
  if (!safe) {
    return null;
  }

  const excluded = parameter.name.elements.some(
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

function referenceIsWithinWriteTarget(
  reference: ts.Identifier,
  owner: ChildComponentSource["owner"],
): boolean {
  for (
    let current: ts.Node = reference;
    current.parent && current.parent !== owner;
    current = current.parent
  ) {
    const { parent } = current;
    if (ts.isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) {
      return nodeWithin(reference, parent.left);
    }
    if (
      (ts.isPostfixUnaryExpression(parent) && parent.operand === current) ||
      (ts.isPrefixUnaryExpression(parent) &&
        parent.operand === current &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken ||
          parent.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      return true;
    }
    if (ts.isDeleteExpression(parent) && parent.expression === current) {
      return true;
    }
    if (
      (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
      nodeWithin(reference, parent.initializer)
    ) {
      return true;
    }
    if (ts.isStatement(parent) || ts.isCallExpression(parent) || isRuntimeFunctionLike(parent)) {
      return false;
    }
  }
  return false;
}

function jsxTagName(name: ts.JsxTagNameExpression): string | null {
  return ts.isIdentifier(name) || ts.isPropertyAccessExpression(name) ? name.getText() : null;
}

function bindingElementPropertyName(element: ts.BindingElement): string | null {
  return element.propertyName
    ? propertyName(element.propertyName)
    : ts.isIdentifier(element.name)
      ? element.name.text
      : null;
}

interface ContextPublication {
  contextName: string;
  property: string;
}

function memoizedContextPublication(
  expression: ts.Expression,
  owner: ChildComponentSource["owner"],
): ContextPublication | null {
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
  const property = propertyName(member.name),
    object = member.parent;
  if (!property || !ts.isObjectLiteralExpression(object)) {
    return null;
  }
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
  const carriedCall = climbTransparentExpression(call),
    declaration = carriedCall.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== carriedCall ||
    !ts.isIdentifier(declaration.name) ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  const bindingName = declaration.name.text;
  let contextName: string | null = null,
    references = 0,
    safe = true;
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
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner),
      provider = attribute && jsxContextProvider(attribute, node);
    if (!provider || (contextName !== null && contextName !== provider)) {
      safe = false;
      return;
    }
    contextName = provider;
  });
  return safe && references > 0 && contextName ? { contextName, property } : null;
}

function jsxContextProvider(attribute: ts.JsxAttribute, expression: ts.Expression): string | null {
  if (attribute.name.getText() !== "value" || !jsxAttributeDirectlyCarries(attribute, expression)) {
    return null;
  }
  const attributes = attribute.parent,
    opening = ts.isJsxAttributes(attributes) ? attributes.parent : null,
    tag =
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

function contextPropertyConsumersAreDeferred(
  resolver: CallbackContractSourceResolver,
  providerFile: string,
  contextName: string,
  property: string,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  if (depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const readers = resolver.contextReaderHooks(providerFile, contextName);
  let consumed = false,
    safe = readers.size > 0;
  for (const [file, hookNames] of readers) {
    const sourceFile = resolver.sourceFile(file);
    if (!sourceFile) {
      return false;
    }
    for (const hookName of hookNames) {
      for (const node of identifiersNamed(sourceFile, hookName)) {
        if (!safe) {
          break;
        }
        if (
          isDeclarationName(node) ||
          isNonValueIdentifier(node) ||
          isModuleBindingReference(node)
        ) {
          continue;
        }
        const call = node.parent;
        if (!ts.isCallExpression(call) || call.expression !== node) {
          safe = false;
          continue;
        }
        const owner = findAncestor(call, isRuntimeFunctionLike);
        if (
          !owner ||
          (!ts.isArrowFunction(owner) &&
            !ts.isFunctionDeclaration(owner) &&
            !ts.isFunctionExpression(owner)) ||
          !owner.body
        ) {
          safe = false;
          continue;
        }
        const carriedCall = climbTransparentExpression(call),
          declaration = carriedCall.parent;
        if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== carriedCall) {
          safe = false;
          continue;
        }
        const tracked = bindCallbackPath(declaration.name, [property]);
        if (!tracked) {
          if (objectBindingOmitsProperty(declaration.name, property)) {
            continue;
          }
          safe = false;
          continue;
        }
        consumed = true;
        safe = trackedCallbackPathIsDeferred(
          {
            body: owner.body,
            deferredCallbackHooks: resolver.deferredCallbackHooks(file),
            file,
            owner,
          },
          tracked,
          resolver,
          visited,
          depth,
        );
      }
    }
  }
  return safe && consumed;
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

function callbackInvocationIsDeferred(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: ChildComponentSource["owner"],
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>,
  source: ChildComponentSource | undefined,
  resolver: CallbackContractSourceResolver | undefined,
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
  seenCallbacks: ReadonlySet<number> = new Set(),
): boolean {
  if (depth > MAX_CALLBACK_PATH_DEPTH || seenCallbacks.has(callback.pos)) {
    return false;
  }
  const nextCallbacks = new Set(seenCallbacks).add(callback.pos),
    synchronous = isSynchronousRenderCallback(callback),
    immediateHook = callbackRunsInImmediateReactHook(callback);
  if (synchronous || immediateHook) {
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

  let referenced = false,
    safe = true;
  for (const node of identifiersNamed(owner.body, name)) {
    if (!safe) {
      break;
    }
    if (isBindingName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    referenced = true;
    if (
      isHookDependencyReference(
        node,
        CALLBACK_IDENTITY_HOOKS,
        reactNamespacesFor(owner.getSourceFile()),
      )
    ) {
      continue;
    }
    if (callbackReferenceIsObservationOnly(node)) {
      continue;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    if (
      attribute &&
      /^on[A-Z]/u.test(attribute.name.getText()) &&
      jsxAttributeCarriesCallbackIdentity(attribute, node)
    ) {
      if (jsxOwnerIsDeferredEventTarget(attribute, source)) {
        continue;
      }
      const target = jsxOwnerTarget(attribute);
      if (source && resolver && target && resolver.frameworkEventComponent(source.file, target)) {
        continue;
      }
      const child =
        source && resolver && target ? resolver.resolveComponent(source.file, target) : null;
      if (
        child &&
        sourceInputCallbackIsDeferred(
          atJsxInvocation(child, attribute, source),
          0,
          [attribute.name.getText()],
          resolver!,
          visited,
          depth + 1,
        )
      ) {
        continue;
      }
    }
    if (identifierRunsInProvenDeferredHook(node, deferredCallbackHooks)) {
      continue;
    }
    if (
      source &&
      resolver &&
      higherOrderCallDefersCallback(node, source, resolver, visited, depth + 1)
    ) {
      continue;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const caller = nearestNestedFunction(node, owner);
      if (
        caller &&
        (ts.isArrowFunction(caller) ||
          ts.isFunctionDeclaration(caller) ||
          ts.isFunctionExpression(caller)) &&
        caller !== owner &&
        (callbackRunsInProvenDeferredHook(caller, deferredCallbackHooks) ||
          callbackInvocationIsDeferred(
            caller,
            owner,
            deferredCallbackHooks,
            source,
            resolver,
            visited,
            depth + 1,
            nextCallbacks,
          ))
      ) {
        continue;
      }
    }
    safe = false;
  }
  return referenced && safe;
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

function callbackIsDeferredByJsx(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  source: ChildComponentSource,
  resolver: CallbackContractSourceResolver,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  if (ts.isFunctionDeclaration(callback) || depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const expression = climbTransparentExpression(callback),
    attribute = findAncestorUntil(expression, ts.isJsxAttribute, source.owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !jsxAttributeCarriesCallbackIdentity(attribute, expression)
  ) {
    return false;
  }
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
    sourceInputCallbackIsDeferred(
      atJsxInvocation(child, attribute, source),
      0,
      [attribute.name.getText()],
      resolver,
      visited,
      depth + 1,
    )
  );
}

function higherOrderCallDefersCallback(
  callback: ts.Identifier,
  source: ChildComponentSource,
  resolver: CallbackContractSourceResolver,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  if (depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const call = findAncestor(callback, ts.isCallExpression);
  if (!call || nodeWithin(callback, call.expression)) {
    return false;
  }
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(callback, argument)),
    deferredResult =
      argumentIndex !== -1 && callResultIsDeferredEvent(call, source, resolver, visited, depth);
  if (!deferredResult) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isIdentifier(callee) || bindingDeclarationCount(source.owner, callee.text) !== 1) {
    return false;
  }
  const hookBinding = returnedHookFunctionBinding(source.owner, callee.text);
  if (!hookBinding) {
    return false;
  }
  const hook = resolver.resolveHook(source.file, hookBinding.hookName),
    factory = hook ? returnedLocalFunction(hook, hookBinding.property) : null,
    deferredParameter =
      factory !== null && higherOrderFunctionDefersParameter(factory, argumentIndex);
  return deferredParameter;
}

function callResultIsDeferredEvent(
  call: ts.CallExpression,
  source: ChildComponentSource,
  resolver: CallbackContractSourceResolver,
  visited: ReadonlySet<string>,
  depth: number,
): boolean {
  let result: ts.Expression = climbTransparentExpression(call);
  if (
    ts.isConditionalExpression(result.parent) &&
    (result.parent.whenTrue === result || result.parent.whenFalse === result)
  ) {
    const other =
      result.parent.whenTrue === result ? result.parent.whenFalse : result.parent.whenTrue;
    if (!isNullishExpression(other, source.owner)) {
      return false;
    }
    result = result.parent;
  }
  const attribute = findAncestorUntil(result, ts.isJsxAttribute, source.owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !jsxAttributeDirectlyCarries(attribute, result)
  ) {
    return false;
  }
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
    sourceInputCallbackIsDeferred(
      atJsxInvocation(child, attribute, source),
      0,
      [attribute.name.getText()],
      resolver,
      visited,
      depth + 1,
    )
  );
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
      ),
      match = matches.length === 1 ? matches[0] : null,
      call = unwrapTransparentExpression(node.initializer),
      hookName = ts.isCallExpression(call) ? hookCallName(call) : null,
      property = match ? bindingElementPropertyName(match) : null;
    if (hookName && property) {
      binding = { hookName, property };
    }
  });
  return binding;
}

function returnedLocalFunction(
  source: ChildComponentSource,
  property: string,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const names = new Set<string>();
  let safe = true;
  visit(source.owner.body, (node) => {
    if (!safe || !ts.isReturnStatement(node) || !node.expression) {
      return;
    }
    if (findAncestor(node, isRuntimeFunctionLike) !== source.owner) {
      return;
    }
    const returned = unwrapTransparentExpression(node.expression);
    if (!ts.isObjectLiteralExpression(returned)) {
      safe = false;
      return;
    }
    const matches = returned.properties.filter(
        (member) =>
          (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
          propertyName(member.name) === property,
      ),
      match = matches.length === 1 ? matches[0] : null,
      value =
        match && ts.isShorthandPropertyAssignment(match)
          ? match.name
          : match && ts.isPropertyAssignment(match)
            ? unwrapTransparentExpression(match.initializer)
            : null;
    if (!value || !ts.isIdentifier(value)) {
      safe = false;
      return;
    }
    names.add(value.text);
  });
  if (!safe || names.size !== 1) {
    return null;
  }
  const name = names.values().next().value;
  if (!name || bindingDeclarationCount(source.owner, name) !== 1) {
    return null;
  }
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
    const initializer = unwrapTransparentExpression(node.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      result = initializer;
      return;
    }
    if (
      ts.isCallExpression(initializer) &&
      hookCallName(initializer) === "useCallback" &&
      bindingDeclarationCount(source.owner, "useCallback") === 0 &&
      initializer.arguments[0] &&
      (ts.isArrowFunction(initializer.arguments[0]) ||
        ts.isFunctionExpression(initializer.arguments[0]))
    ) {
      result = initializer.arguments[0];
    }
  });
  return result;
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
  let references = 0,
    safe = true;
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
    const call = findAncestorUntil(node, ts.isCallExpression, factory),
      wrapper = nearestNestedFunction(node, factory);
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
  const expression = climbTransparentExpression(call),
    declaration = expression.parent;
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
  const returned = climbTransparentExpression(callback),
    factory = returned.parent;
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
  const argumentIndex = call.arguments.findIndex((argument) => nodeWithin(identifier, argument)),
    hookName = hookCallName(call);
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
  const argumentIndex = call.arguments.indexOf(callback),
    hookName = hookCallName(call);
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

function boundPropIdentifier(
  owner: ChildComponentSource["owner"],
  propName: string,
): ts.Identifier | null {
  const parameter = owner.parameters[0];
  if (!parameter || owner.parameters.length !== 1) {
    return null;
  }
  if (!ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  let restBinding: ts.Identifier | null = null;
  for (const element of parameter.name.elements) {
    if (!ts.isBindingElement(element)) {
      continue;
    }
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) {
        restBinding = element.name;
      }
      continue;
    }
    if (!ts.isIdentifier(element.name)) {
      continue;
    }
    const source =
      element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : element.name.text;
    if (source === propName) {
      return element.name;
    }
  }
  if (!restBinding || !owner.body) {
    return null;
  }
  if (bindingDeclarationCount(owner, restBinding.text) !== 1) {
    return null;
  }

  let bound: ts.Identifier | null = null,
    safe = true;
  visit(owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== restBinding.text ||
      isNonValueIdentifier(node)
    ) {
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
    for (const element of declaration.name.elements) {
      if (
        !ts.isBindingElement(element) ||
        element.dotDotDotToken ||
        !ts.isIdentifier(element.name) ||
        element.initializer
      ) {
        continue;
      }
      const source =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
      if (source !== propName || bound !== null) {
        continue;
      }
      bound = element.name;
    }
  });
  return safe && bound !== null ? bound : null;
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
  const container: ts.Node = attribute.parent,
    element = ts.isJsxAttributes(container) ? container.parent : container;
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
  let depth = 0,
    pure = true;
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
