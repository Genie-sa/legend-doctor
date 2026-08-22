import ts from "typescript";

import {
  findAncestorUntil,
  nearestNestedFunction,
  type RuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { StateCandidate, StateUsage } from "../analyze-source.js";
import {
  hasStateInitializer,
  isRenderGateReference,
  isSafeProjectionExpression,
} from "./deferred-reveal.js";
import {
  isInsideJsxEventCallback,
  isSafeJsxProjectionReference,
  jsxElementCount,
  nearestRepeatedRenderCall,
  oneHopRenderProjectionReferences,
} from "./state-proofs.js";

interface LiteralBooleanLeafOptions {
  branchCallSiteExists: boolean;
  hasCompanionWrites: boolean;
  hasMemoizedOptionCommand: boolean;
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
        (isEventRootedLiteralSetterCall(call, state.owner) ||
          options.hasMemoizedOptionCommand);
    });
}

interface MultiSurfaceBooleanOptions {
  hasCompanionWrites: boolean;
  hasReactiveMutationPath: boolean;
  hasSafeCommands: boolean;
  isCustomHookOwner: boolean;
  pureProjectionImports: ReadonlySet<string>;
}

export function isMultiSurfaceLiteralBooleanState(
  state: StateCandidate,
  usage: StateUsage,
  options: MultiSurfaceBooleanOptions
): boolean {
  const ownerElements = jsxElementCount(state.owner);
  if (
    options.isCustomHookOwner ||
    !hasStateInitializer(state, ts.SyntaxKind.FalseKeyword) ||
    ownerElements < 12 ||
    directOwnerReturnCount(state.owner) !== 1 ||
    usage.localRenderReads < 2 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads !== 0 ||
    usage.effectWrites !== 0 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences !== 0 ||
    options.hasCompanionWrites ||
    options.hasReactiveMutationPath ||
    !options.hasSafeCommands ||
    usage.setterCallNodes.length === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.setterUsesPreviousValue ||
    usage.shadowed ||
    usage.escaped ||
    !usage.setterCallNodes.every(isLiteralBooleanSetter)
  ) {
    return false;
  }

  const projections = new Map<number, ts.Node>();
  for (const renderNode of usage.directRenderNodes) {
    const declaration = findAncestorUntil(renderNode, ts.isVariableDeclaration, state.owner);
    const aliases = declaration?.initializer && containsJsx(declaration.initializer)
      ? null
      : oneHopRenderProjectionReferences(
          state.owner,
          [renderNode],
          (expression, reference) =>
            isSafeProjectionExpression(expression, reference, options.pureProjectionImports)
        );
    for (const projection of aliases ?? [renderNode]) {
      projections.set(projection.getStart(), projection);
    }
  }

  const surfaces = new Map<number, number>();
  let conditionalSurfaces = 0;
  for (const projection of projections.values()) {
    if (
      nearestNestedFunction(projection, state.owner) ||
      nearestRepeatedRenderCall(projection, state.owner) ||
      !isSafeJsxProjectionReference(
        projection,
        state.owner,
        options.pureProjectionImports
      )
    ) {
      return false;
    }
    const attribute = findAncestorUntil(projection, ts.isJsxAttribute, state.owner);
    if (attribute) {
      if (!["className", "style"].includes(attribute.name.getText())) return false;
      surfaces.set(attribute.getStart(), 1);
      continue;
    }
    const expression = findAncestorUntil(projection, ts.isJsxExpression, state.owner);
    if (!expression?.expression || !isRenderGateReference(projection, state.owner)) return false;
    let elements = 0;
    visit(expression.expression, node => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) elements += 1;
    });
    if (elements === 0 || elements > 4) return false;
    surfaces.set(expression.getStart(), elements);
    conditionalSurfaces += 1;
  }

  const surfaceElements = [...surfaces.values()].reduce((sum, elements) => sum + elements, 0);
  return surfaces.size >= 2 &&
    surfaces.size <= 6 &&
    conditionalSurfaces > 0 &&
    surfaceElements / ownerElements <= 0.4;
}

function directOwnerReturnCount(owner: RuntimeFunctionLike): number {
  if (!owner.body) return 0;
  let returns = 0;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (ts.isReturnStatement(node) && node.expression) returns += 1;
  });
  return returns;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  visit(node, candidate => {
    if (ts.isJsxElement(candidate) || ts.isJsxFragment(candidate) || ts.isJsxSelfClosingElement(candidate)) {
      found = true;
    }
  });
  return found;
}

function isLiteralBooleanSetter(call: ts.CallExpression): boolean {
  const value = call.arguments[0];
  return call.arguments.length === 1 &&
    !!value &&
    (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword);
}

function isEventRootedLiteralSetterCall(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike
): boolean {
  return isInsideJsxEventCallback(call, owner);
}
