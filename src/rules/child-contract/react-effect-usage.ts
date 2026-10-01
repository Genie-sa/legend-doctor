import { nearestNestedFunction, nodeWithin } from "../../core/ast.js";
import {
  outermostTransparentParent,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { ChildComponentSource } from "./model.js";
import type { HookImports } from "../../core/imports.js";
import { callbackReferenceIsObservationOnly } from "./observation-only-reads.js";
import { isReactHookCall } from "../../core/imports.js";
import ts from "typescript";

export function reactEffectCallbackUsage(
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
  const expression = outermostTransparentParent(reference);
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression
    ? "invoke"
    : null;
}

function isReactEffectCall(call: ts.CallExpression, imports: HookImports): boolean {
  return (
    isReactHookCall(call, "useEffect", imports) ||
    isReactHookCall(call, "useLayoutEffect", imports) ||
    isReactHookCall(call, "useInsertionEffect", imports)
  );
}
