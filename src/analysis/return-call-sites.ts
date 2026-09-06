import type { DirectReturnCallSite, StateUsage } from "./model.js";
import {
  isRuntimeFunctionLike,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../core/ast.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { nearestMutationFunction } from "./mutations.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../core/analysis-ast.js";

export function directUniqueReturnCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): DirectReturnCallSite | null {
  const callSite = directBranchReturnCallSite(usage, owner);
  return callSite && uniqueReturnedExpression(owner) ? callSite : null;
}

export function setterCallEndsCommand(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const command = nearestMutationFunction(call, owner);
  if (!command.body) {
    return false;
  }
  if (!ts.isBlock(command.body)) {
    return unwrapTransparentExpression(command.body) === call;
  }
  const statement = call.parent;
  return (
    ts.isExpressionStatement(statement) &&
    statement.expression === call &&
    statement.parent === command.body &&
    command.body.statements.at(-1) === statement
  );
}

export function uniqueReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) {
    return null;
  }
  const expressions: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      expressions.push(node.expression);
    }
  });
  return expressions.length === 1 ? expressions[0]! : null;
}

export function directBranchReturnCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): DirectReturnCallSite | null {
  const [valueSite] = [...usage.valueTransportSites];
  if (!owner.body || valueSite === undefined || usage.repeatedValueTransport) {
    return null;
  }
  const opening = firstDirectJsxOpeningAt(owner.body, valueSite);
  return opening ? directlyReturnedCallSite(opening, owner) : null;
}

export function firstDirectJsxOpeningAt(
  body: ts.Node,
  position: number,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (
      openings.length === 0 &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === position
    ) {
      openings.push(node);
    }
  });
  return openings[0] ?? null;
}

function directlyReturnedCallSite(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  owner: RuntimeFunctionLike,
): DirectReturnCallSite | null {
  for (
    let current: ts.Node | undefined = opening.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (ts.isVariableDeclaration(current) || isRuntimeFunctionLike(current)) {
      return null;
    }
    if (ts.isReturnStatement(current)) {
      return current.expression && nodeWithin(opening, current.expression)
        ? { opening, returned: current.expression }
        : null;
    }
  }
  return null;
}

function firstJsxOpeningAt(
  body: ts.Node,
  position: number,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const openings: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visit(body, (node) => {
    if (
      openings.length === 0 &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getStart() === position
    ) {
      openings.push(node);
    }
  });
  return openings[0] ?? null;
}

function isOwnerLevelNode(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (isRuntimeFunctionLike(current)) {
      return false;
    }
  }
  return true;
}

export function stableOwnerLevelCallSite(
  usage: StateUsage,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const [valueSite] = [...usage.valueTransportSites];
  if (valueSite === undefined || !owner.body) {
    return null;
  }
  const opening = firstJsxOpeningAt(owner.body, valueSite);
  return opening && isOwnerLevelNode(opening, owner) ? opening : null;
}

export function callSiteIsKeyed(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null,
): boolean {
  if (!opening) {
    return true;
  }
  return opening.attributes.properties.some(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
}
