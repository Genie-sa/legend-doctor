import {
  hasStableCacheDependencies,
  hasStableEffectDependencies,
  subscriptionStableValue,
} from "./stable-effect-dependencies.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import ts from "typescript";
import { visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";

/**
 * Every subscription relocation must preserve commit work and imperative render snapshots. Work
 * blocks only when a subscription-only render would redo it: an effect or cache whose dependency
 * can change identity, a ref whose identity can change, or a render-time `.current`, `get()`, or
 * `peek()` read whose snapshot would otherwise refresh.
 */
export function hasUnprovenOwnerWork(
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (!owner.body) {
    return true;
  }
  let found = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      (ts.isCallExpression(node) && unstableCachedHook(node, owner, scan)) ||
      (ts.isJsxAttribute(node) && unstableRefAttribute(node, owner, scan)) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "current") ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "current") ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["get", "peek"].includes(node.expression.name.text))
    ) {
      found = true;
    }
    if (!found && ts.isCallExpression(node) && !hasStableEffectDependencies(node, owner, scan)) {
      found = (
        ["useEffect", "useLayoutEffect", "useInsertionEffect", "useImperativeHandle"] as const
      ).some((canonicalName) =>
        isImportedHookCall({
          call: node,
          canonicalName,
          localNames: scan.imports[canonicalName],
          namespaceNames: scan.imports.reactNamespaces,
        }),
      );
    }
  });
  return found;
}

/** React reattaches a ref on commit only when its identity changes. */
function unstableRefAttribute(
  attribute: ts.JsxAttribute,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (attribute.name.getText() !== "ref") {
    return false;
  }
  const value =
    attribute.initializer && ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : undefined;
  return !value || !subscriptionStableValue(value, owner, scan);
}

function unstableCachedHook(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  return (
    (["useMemo", "useCallback"] as const).some((canonicalName) =>
      isImportedHookCall({
        call,
        canonicalName,
        localNames: scan.imports[canonicalName],
        namespaceNames: scan.imports.reactNamespaces,
      }),
    ) && !hasStableCacheDependencies(call, owner, scan)
  );
}
