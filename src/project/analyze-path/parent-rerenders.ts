import {
  RESERVED_OBSERVABLE_MEMBERS,
  isUseValueCall,
} from "../../rules/observable-reads/observable-paths.js";
import {
  bindingDeclarationCount,
  outermostTransparentParent,
  rootIdentifier,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  collectReactComponentWrappers,
  isReactComponentWrapper,
} from "../../core/react-component-wrappers.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { ComponentTarget } from "./component-references.js";
import type { HookImports } from "../../core/imports.js";
import type { ParentRerenderProof } from "../../rules/child-contract/model.js";
import type { RenderFunction } from "../../rules/observable-tracking/render-owners.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { collectHookImports } from "../../core/imports.js";
import { componentReferences } from "./component-references.js";
import { findHookDeclaration } from "./source-declarations.js";
import { pathIdentityKey } from "../../core/path-identity.js";
import { renderOwnerOf } from "../../rules/observable-tracking/render-owners.js";
import ts from "typescript";

/** A resolved observable declaration key followed by the static member path below it. */
type ObservablePathKey = readonly string[];

/** How a component answers a parent render: always, only for a fresh prop, or unknowably. */
type RerenderMode = "always" | "fresh-props" | "unknown";

type PathCoverage = "ancestor" | "exact" | "none";

type SiteRerender = "independent" | "overlapping" | "rerendering" | "unresolved";

interface DeclaredComponent {
  readonly mode: RerenderMode;
  readonly target: ComponentTarget;
}

interface SiteQuery {
  readonly childPaths: readonly (ObservablePathKey | null)[];
  readonly component: DeclaredComponent;
  readonly context: AnalysisContext;
}

const FRESH_VALUE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.JsxElement,
  ts.SyntaxKind.JsxFragment,
  ts.SyntaxKind.JsxSelfClosingElement,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.ObjectLiteralExpression,
]);

const hookImportsBySource = new WeakMap<ts.SourceFile, HookImports>();

const MAX_CUSTOM_HOOK_DEPTH = 3;
const CUSTOM_HOOK_NAME = /^use[A-Z0-9]/u;

/**
 * Whether the components that render `owner` subscribe to these observable paths themselves, or
 * through source-resolved custom hooks their render calls, and so rerender it on the same changes.
 * `proven` needs every reference to be a JSX site whose render owner subscribes to every path
 * exactly and whose render reaches the child.
 */
export function componentParentRerender(
  context: AnalysisContext,
  owner: RuntimeFunctionLike,
  paths: readonly ts.Expression[],
): ParentRerenderProof {
  const component = declaredComponent(owner);
  if (!component) {
    return "absent";
  }
  const ownerFile = owner.getSourceFile().fileName;
  const query: SiteQuery = {
    childPaths: paths.map((path) => observablePathKey(context, ownerFile, path)),
    component,
    context,
  };
  const { complete, references } = componentReferences(context, component.target);
  const sites = references
    .filter((reference) => !isClosingTag(reference))
    .map((reference) => siteRerender(reference, query));
  if (!sites.some((site) => site === "overlapping" || site === "rerendering")) {
    return "absent";
  }
  return complete && sites.every((site) => site === "rerendering") ? "proven" : "possible";
}

export function declaredComponent(owner: RuntimeFunctionLike): DeclaredComponent | null {
  if (ts.isFunctionDeclaration(owner)) {
    return owner.name && isComponentName(owner.name.text)
      ? { mode: "always", target: componentTarget(owner.name) }
      : null;
  }
  return ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)
    ? declaredExpressionComponent(owner)
    : null;
}

/** A `const` component whose render function is bare or wrapped in single-argument calls. */
function declaredExpressionComponent(
  owner: ts.ArrowFunction | ts.FunctionExpression,
): DeclaredComponent | null {
  const wrappers = collectReactComponentWrappers(owner.getSourceFile());
  let mode: RerenderMode = "always";
  let current = outermostTransparentParent(owner);
  while (ts.isCallExpression(current.parent) && current.parent.arguments[0] === current) {
    const call = current.parent;
    const memoLike =
      call.arguments.length === 1 && isReactComponentWrapper(call.expression, wrappers);
    mode = mode === "unknown" || !memoLike ? "unknown" : "fresh-props";
    current = outermostTransparentParent(call);
  }
  const declaration = current.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === current &&
    ts.isIdentifier(declaration.name) &&
    isComponentName(declaration.name.text) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ? { mode, target: componentTarget(declaration.name) }
    : null;
}

function componentTarget(name: ts.Identifier): ComponentTarget {
  return {
    declarationName: name,
    file: pathIdentityKey(name.getSourceFile().fileName),
    name: name.text,
  };
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/u.test(name);
}

function isClosingTag(reference: ts.Identifier): boolean {
  return ts.isJsxClosingElement(reference.parent) && reference.parent.tagName === reference;
}

function siteRerender(reference: ts.Identifier, query: SiteQuery): SiteRerender {
  const opening = jsxSite(reference);
  const imports = hookImportsFor(reference.getSourceFile());
  const parent = opening ? renderOwnerOf(opening, imports) : null;
  if (!opening || parent?.kind !== "component") {
    return "unresolved";
  }
  const parentPaths = [
    ...subscribedPaths(parent.owner, imports, query.context),
    ...customHookSubscribedPaths(query.context, parent.owner, MAX_CUSTOM_HOOK_DEPTH),
  ];
  const coverage = query.childPaths.map((path) => pathCoverage(path, parentPaths));
  if (coverage.every((entry) => entry === "none")) {
    return "independent";
  }
  return coverage.every((entry) => entry === "exact") &&
    rendersWithParent(opening, parent.owner, query.component.mode)
    ? "rerendering"
    : "overlapping";
}

/**
 * Whether a custom hook that `owner`'s render calls, followed through the custom hooks it calls in
 * turn, subscribes to this observable path or an ancestor with a `useValue`-style hook. Hooks run
 * on every render of their caller, so the owner already rerenders on each change of the path.
 */
export function customHookSubscribes(
  context: AnalysisContext,
  owner: RuntimeFunctionLike,
  observable: ts.Expression,
): boolean {
  const read = observablePathKey(context, owner.getSourceFile().fileName, observable);
  return (
    read !== null &&
    customHookSubscribedPaths(context, owner, MAX_CUSTOM_HOOK_DEPTH).some((path) =>
      isPathPrefix(path, read),
    )
  );
}

function customHookSubscribedPaths(
  context: AnalysisContext,
  owner: RuntimeFunctionLike,
  depth: number,
): ObservablePathKey[] {
  if (depth === 0) {
    return [];
  }
  return calledCustomHooks(context, owner).flatMap((hook) => [
    ...subscribedPaths(hook, hookImportsFor(hook.getSourceFile()), context),
    ...customHookSubscribedPaths(context, hook, depth - 1),
  ]);
}

function calledCustomHooks(context: AnalysisContext, owner: RuntimeFunctionLike): RenderFunction[] {
  const file = owner.getSourceFile().fileName;
  const hooks: RenderFunction[] = [];
  visit(owner.body, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !CUSTOM_HOOK_NAME.test(node.expression.text) ||
      findAncestor(node, isRuntimeFunctionLike) !== owner
    ) {
      return;
    }
    const resolved = context.sourceIndex.hookDeclarationFor(file, node.expression.text);
    const sourceFile = resolved && context.project.getFile(resolved.file)?.sourceFile;
    const hook = sourceFile && findHookDeclaration(sourceFile, resolved.localName);
    if (hook) {
      hooks.push(hook);
    }
  });
  return hooks;
}

function jsxSite(reference: ts.Identifier): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const opening = reference.parent;
  return (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    opening.tagName === reference &&
    !isLocallyBound(reference)
    ? opening
    : null;
}

function hookImportsFor(sourceFile: ts.SourceFile): HookImports {
  const cached = hookImportsBySource.get(sourceFile);
  if (cached) {
    return cached;
  }
  const imports = collectHookImports(sourceFile);
  hookImportsBySource.set(sourceFile, imports);
  return imports;
}

/** Observable paths the component's own render subscribes to through `useValue`-style hooks. */
function subscribedPaths(
  owner: RenderFunction,
  imports: HookImports,
  context: AnalysisContext,
): ObservablePathKey[] {
  const file = owner.getSourceFile().fileName;
  const paths: ObservablePathKey[] = [];
  visit(owner.body, (node) => {
    if (
      !ts.isCallExpression(node) ||
      node.arguments.length !== 1 ||
      !isUseValueCall(node, imports) ||
      findAncestor(node, isRuntimeFunctionLike) !== owner
    ) {
      return;
    }
    const path = observablePathKey(context, file, node.arguments[0]!);
    if (path) {
      paths.push(path);
    }
  });
  return paths;
}

function observablePathKey(
  context: AnalysisContext,
  file: string,
  expression: ts.Expression,
): ObservablePathKey | null {
  const path = staticPropertyPath(expression);
  const root = rootIdentifier(expression);
  if (
    !path ||
    !root ||
    path.slice(1).some((member) => RESERVED_OBSERVABLE_MEMBERS.has(member)) ||
    isLocallyBound(root)
  ) {
    return null;
  }
  const symbol = context.sourceIndex.observableDeclarationFor(file, root.text);
  return symbol ? [`${pathIdentityKey(symbol.file)}\0${symbol.localName}`, ...path.slice(1)] : null;
}

function isLocallyBound(identifier: ts.Identifier): boolean {
  for (
    let scope = findAncestor(identifier, isRuntimeFunctionLike);
    scope;
    scope = findAncestor(scope, isRuntimeFunctionLike)
  ) {
    if (bindingDeclarationCount(scope, identifier.text) > 0) {
      return true;
    }
  }
  return false;
}

function pathCoverage(
  childPath: ObservablePathKey | null,
  parentPaths: readonly ObservablePathKey[],
): PathCoverage {
  if (!childPath) {
    return "none";
  }
  let coverage: PathCoverage = "none";
  for (const parentPath of parentPaths) {
    if (!isPathPrefix(parentPath, childPath)) {
      continue;
    }
    if (parentPath.length === childPath.length) {
      return "exact";
    }
    coverage = "ancestor";
  }
  return coverage;
}

function isPathPrefix(prefix: ObservablePathKey, path: ObservablePathKey): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

function rendersWithParent(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  parent: RenderFunction,
  mode: RerenderMode,
): boolean {
  if (mode !== "fresh-props") {
    return mode === "always";
  }
  const freshAttribute = opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.initializer !== undefined &&
      isFreshAttributeValue(attribute.initializer, parent),
  );
  return (
    freshAttribute ||
    (ts.isJsxOpeningElement(opening) &&
      opening.parent.children.some((child) => isFreshChild(child, parent)))
  );
}

function isFreshAttributeValue(value: ts.JsxAttributeValue, parent: RenderFunction): boolean {
  return ts.isJsxExpression(value)
    ? value.expression !== undefined && isFreshValue(value.expression, parent)
    : FRESH_VALUE_KINDS.has(value.kind);
}

function isFreshChild(child: ts.JsxChild, parent: RenderFunction): boolean {
  return ts.isJsxExpression(child)
    ? child.expression !== undefined && isFreshValue(child.expression, parent)
    : FRESH_VALUE_KINDS.has(child.kind);
}

/** A value created anew by every render of `parent`: a literal, or a render-local binding to one. */
function isFreshValue(expression: ts.Expression, parent: RenderFunction): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    FRESH_VALUE_KINDS.has(value.kind) ||
    (ts.isIdentifier(value) && isRenderLocalFreshBinding(value.text, parent))
  );
}

function isRenderLocalFreshBinding(name: string, parent: RenderFunction): boolean {
  if (bindingDeclarationCount(parent, name) !== 1) {
    return false;
  }
  let fresh = false;
  visit(parent.body, (node) => {
    if (findAncestor(node, isRuntimeFunctionLike) !== parent) {
      return;
    }
    fresh ||=
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer !== undefined &&
        FRESH_VALUE_KINDS.has(unwrapTransparentExpression(node.initializer).kind));
  });
  return fresh;
}
