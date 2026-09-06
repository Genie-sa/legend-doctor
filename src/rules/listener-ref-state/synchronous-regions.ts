import { nearestNestedFunction, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { callbackIsEventRooted } from "../state-proofs/event-roots.js";
import ts from "typescript";

export function setterRegionIsSynchronous(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const region = nearestNestedFunction(call, owner);
  return (
    region !== null && region !== owner && !isAsync(region) && !containsAwaitOrYield(region.body)
  );
}

export function regionIsSynchronousEvent(
  region: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
): boolean {
  return (
    !isAsync(region) &&
    !containsAwaitOrYield(region.body) &&
    (ts.isArrowFunction(region) ||
      ts.isFunctionDeclaration(region) ||
      ts.isFunctionExpression(region)) &&
    callbackIsEventRooted({ callback: region, owner, dependencyName: "", seen: new Set() })
  );
}

export function isAsync(node: RuntimeFunctionLike): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
}

export function containsAwaitOrYield(node: ts.Node | undefined): boolean {
  if (!node) {
    return true;
  }
  let found = false;
  visit(node, (current) => {
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) {
      found = true;
    }
  });
  return found;
}
