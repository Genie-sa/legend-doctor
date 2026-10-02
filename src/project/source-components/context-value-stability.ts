import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isStableDependency } from "../../rules/in-place-memo-keys/memo-dependencies.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../../rules/state-proofs/binding-lookup.js";

type ProviderElement = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

interface StabilityScope {
  /** Memoized bindings already being proven, so a dependency cycle fails instead of recursing. */
  readonly chain: ReadonlySet<string>;
  readonly imports: HookImports;
  readonly owner: RuntimeFunctionLike;
}

/** Every provider tag the module renders for these context aliases. */
export function contextProviderElements(
  sourceFile: ts.SourceFile,
  aliases: ReadonlySet<string>,
): readonly ProviderElement[] {
  const elements: ProviderElement[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    const context = providedContext(node.tagName);
    if (context && aliases.has(context.text)) {
      elements.push(node);
    }
  });
  return elements;
}

/**
 * The context a provider tag names: `<Context.Provider>`, or a bare `<Context>`, which React 19
 * renders as its provider.
 */
export function providedContext(tag: ts.JsxTagNameExpression): ts.Identifier | null {
  const context =
    ts.isPropertyAccessExpression(tag) && tag.name.text === "Provider" ? tag.expression : tag;
  return ts.isIdentifier(context) ? context : null;
}

/**
 * The provider passes a single `value` whose identity never changes after mount: a ref, an owned
 * observable, a state setter, a module binding, or a `useMemo`/`useCallback` result whose
 * dependencies are all such values. No render of its owner then changes the context, so no
 * consumer renders because of it.
 */
export function providerValueIsMountStable(
  element: ProviderElement,
  imports: HookImports,
): boolean {
  const [value, ...others] = element.attributes.properties.filter(
    (attribute) => !ts.isJsxAttribute(attribute) || attribute.name.getText() === "value",
  );
  const initializer = value && ts.isJsxAttribute(value) ? value.initializer : undefined;
  const expression =
    initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
  const owner = findAncestor(element, isRuntimeFunctionLike);
  return (
    others.length === 0 &&
    expression !== undefined &&
    owner !== null &&
    isMountStableValue(expression, { chain: new Set(), imports, owner })
  );
}

function isMountStableValue(expression: ts.Expression, scope: StabilityScope): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isCallExpression(value)) {
    return isMemoizedOverStableValues(value, scope);
  }
  if (!ts.isIdentifier(value)) {
    return false;
  }
  if (isStableDependency(value, scope.owner, scope.imports)) {
    return true;
  }
  const initializer = memoizedConstInitializer(value.text, scope);
  return (
    initializer !== null &&
    isMemoizedOverStableValues(initializer, {
      ...scope,
      chain: new Set(scope.chain).add(value.text),
    })
  );
}

/** The `useMemo`/`useCallback` call a sole owner-level `const` binds, outside the proof chain. */
function memoizedConstInitializer(name: string, scope: StabilityScope): ts.CallExpression | null {
  const declaration =
    !scope.chain.has(name) && bindingDeclarationCount(scope.owner, name) === 1 && scope.owner.body
      ? uniqueVariableDeclaration(scope.owner.body, name)
      : null;
  const initializer = declaration?.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  return declaration &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    initializer &&
    ts.isCallExpression(initializer)
    ? initializer
    : null;
}

function isMemoizedOverStableValues(call: ts.CallExpression, scope: StabilityScope): boolean {
  const [, dependencies, ...rest] = call.arguments;
  return (
    (isReactHook(call, "useMemo", scope.imports) ||
      isReactHook(call, "useCallback", scope.imports)) &&
    rest.length === 0 &&
    dependencies !== undefined &&
    ts.isArrayLiteralExpression(dependencies) &&
    dependencies.elements.every(
      (dependency) => !ts.isSpreadElement(dependency) && isMountStableValue(dependency, scope),
    )
  );
}

function isReactHook(
  call: ts.CallExpression,
  canonicalName: "useCallback" | "useMemo",
  imports: HookImports,
): boolean {
  return isImportedHookCall({
    call,
    canonicalName,
    localNames: imports[canonicalName],
    namespaceNames: imports.reactNamespaces,
  });
}
