import {
  hasStableEffectDependencies,
  stablePrimitiveDependency,
} from "./stable-effect-dependencies.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { identifiedUseValueDeclaration } from "./observable-paths.js";
import { isImportedHookCall } from "../../core/imports.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";
import { visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";

/** Every subscription relocation must preserve commit work and imperative render snapshots. */
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
      (ts.isJsxAttribute(node) && node.name.getText() === "ref") ||
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

function unstableCachedHook(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (
    !(["useMemo", "useCallback"] as const).some((canonicalName) =>
      isImportedHookCall({
        call,
        canonicalName,
        localNames: scan.imports[canonicalName],
        namespaceNames: scan.imports.reactNamespaces,
      }),
    )
  ) {
    return false;
  }
  const [callback, dependencies] = call.arguments;
  return (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !dependencies ||
    !ts.isArrayLiteralExpression(dependencies) ||
    !dependencies.elements.every((dependency) => stableMemoDependency(dependency, owner, scan))
  );
}
function stableMemoDependency(
  dependency: ts.Expression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (stablePrimitiveDependency(dependency, owner)) {
    return true;
  }
  const declaration = ts.isIdentifier(dependency)
    ? uniqueVariableDeclaration(owner, dependency.text)
    : null;
  return declaration !== null && identifiedUseValueDeclaration(declaration, scan) !== null;
}
