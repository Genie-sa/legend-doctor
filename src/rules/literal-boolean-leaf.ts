import ts from "typescript";

import type { StateCandidate, StateUsage } from "../analyze-source.js";
import { isRuntimeFunctionLike, type RuntimeFunctionLike } from "../ast.js";
import { hasStateInitializer } from "./deferred-reveal.js";
import { isInsideJsxEventCallback, jsxElementCount } from "./state-proofs.js";

interface LiteralBooleanLeafOptions {
  branchCallSiteExists: boolean;
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  isCustomHookOwner: boolean;
  localComponents: ReadonlySet<string>;
  sourceComponents: ReadonlySet<string>;
}

export function isLiteralBooleanLeafState(
  state: StateCandidate,
  usage: StateUsage,
  options: LiteralBooleanLeafOptions
): boolean {
  const target = [...usage.valueTargets][0] ?? "";
  return !options.isCustomHookOwner &&
    hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) &&
    jsxElementCount(state.owner) >= 12 &&
    usage.localRenderReads === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.transportedOccurrences > 0 &&
    usage.valueTransportSites.size === 1 &&
    usage.valueTargets.size === 1 &&
    (options.localComponents.has(target) || options.sourceComponents.has(target)) &&
    options.branchCallSiteExists &&
    !usage.repeatedValueTransport &&
    !options.hasCompanionWrites &&
    !options.hasReactiveMutationPath &&
    usage.setterCallNodes.length > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.setterCallNodes.every(call => {
      const value = call.arguments[0];
      return call.arguments.length === 1 &&
        !!value &&
        (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) &&
        isEventRootedLiteralSetterCall(call, state.owner);
    });
}

function isEventRootedLiteralSetterCall(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike
): boolean {
  if (isInsideJsxEventCallback(call, owner)) return true;
  for (let current: ts.Node | undefined = call.parent; current && current !== owner; current = current.parent) {
    if (!isRuntimeFunctionLike(current)) continue;
    const parent: ts.Node = current.parent;
    if (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === current &&
      /^on[A-Z]/.test(parent.name.getText())
    ) {
      return true;
    }
  }
  return false;
}
