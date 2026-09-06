import { findAncestorUntil, isRuntimeFunctionLike } from "../core/ast.js";
import type { JsxSubtreeNode } from "../rules/deferred-reveal/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { STABLE_CALL_SITE_PAIR } from "./constants.js";
import { isInsideJsxAttribute } from "../core/analysis-ast.js";
import { nearestRepeatedRenderCall } from "../rules/state-proofs/jsx-subtrees.js";
import ts from "typescript";

export function calleeRootIdentifier(expression: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(expression)) {
    return expression;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression;
  }
  return null;
}

export function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
}

export function declaredBindingName(node: ts.Node): string | null {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  return null;
}

export function soleReturnedExpression(body: ts.ConciseBody): ts.Expression | null {
  if (!ts.isBlock(body)) {
    return body;
  }
  const [only] = body.statements;
  if (body.statements.length !== 1 || !only || !ts.isReturnStatement(only)) {
    return null;
  }
  return only.expression ?? null;
}

export function soleStatementExpression(body: ts.ConciseBody): ts.Expression | null {
  if (!ts.isBlock(body)) {
    return body;
  }
  const [only] = body.statements;
  if (body.statements.length !== 1 || !only || !ts.isExpressionStatement(only)) {
    return null;
  }
  return only.expression;
}

export function jsxSubtreeForOpening(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): JsxSubtreeNode {
  return ts.isJsxOpeningElement(opening) ? opening.parent : opening;
}

export function subtreeClusterOwnership(repeated: boolean, needsObservable: boolean): string {
  if (repeated) {
    return "replace them with one component-lifetime observable model and subscribe with per-item `useValue` selectors in the repeated row leaf";
  }
  if (needsObservable) {
    return "replace them with one component-lifetime observable model and subscribe in the extracted leaf with `useValue`";
  }
  return "move their ownership into the extracted leaf component";
}

export function asyncStatusBoundaryLabel(
  callSiteCount: number,
  target: string | undefined,
): string {
  if (callSiteCount > 1) {
    const count = callSiteCount === STABLE_CALL_SITE_PAIR ? "two" : "three";
    return `${count} stable status call sites`;
  }
  return target ? `the stable \`${target}\` call site` : "the stable pending-control call site";
}

export function renderCutSuffix(
  hasCompactBooleanCut: boolean,
  hasRepeatedOwnerCut: boolean,
): string {
  if (hasCompactBooleanCut) {
    return " The independent sibling render cut proves that these updates skip owner work.";
  }
  if (hasRepeatedOwnerCut) {
    return " The leaf subscription skips the owner's repeated render work.";
  }
  return "";
}

export function competingSubscriptionsNote(subscriptions: number): string {
  if (subscriptions === 0) {
    return "";
  }
  if (subscriptions === 1) {
    return " The owner also re-renders through an existing observable subscription; isolate this state only if it updates less often than that subscription.";
  }
  return ` The owner also re-renders through ${subscriptions} existing observable subscriptions; isolate this state only if it updates less often than they do.`;
}

export function commonRepeatedRender(
  nodes: readonly ts.Node[],
  boundary: ts.Node,
): ts.CallExpression | null {
  const calls = nodes.map((node) => nearestRepeatedRenderCall(node, boundary));
  const [first] = calls;
  return first && calls.every((call) => call === first) ? first : null;
}

export function jsxSubtreeLabel(node: JsxSubtreeNode): string {
  if (ts.isJsxFragment(node)) {
    return "fragment";
  }
  return ts.isJsxElement(node)
    ? `<${node.openingElement.tagName.getText()}>`
    : `<${node.tagName.getText()}>`;
}

export function ownerLineSpan(owner: RuntimeFunctionLike, sourceFile: ts.SourceFile): number {
  const start = sourceFile.getLineAndCharacterOfPosition(owner.getStart(sourceFile)).line;
  const end = sourceFile.getLineAndCharacterOfPosition(owner.end).line;
  return end - start + 1;
}

export function runtimeFunctionName(owner: RuntimeFunctionLike): string | null {
  if (owner.name && ts.isIdentifier(owner.name)) {
    return owner.name.text;
  }
  const { parent } = owner;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
}

export function isCustomHookOwner(owner: RuntimeFunctionLike): boolean {
  const name = runtimeFunctionName(owner);
  return name !== null && /^use[A-Z0-9]/u.test(name);
}

export function ancestorCallInSet(
  node: ts.Node,
  calls: ReadonlySet<ts.CallExpression>,
  boundary: ts.Node,
): ts.CallExpression | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (ts.isCallExpression(current) && calls.has(current)) {
      return current;
    }
  }
  return null;
}

export function jsxTargetName(attribute: ts.JsxAttribute): string | null {
  const properties = attribute.parent;
  const opening = properties.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return null;
  }
  return opening.tagName.getText();
}

export function isCustomJsxTarget(name: string): boolean {
  const [first] = name;
  return first !== undefined && (first === first.toUpperCase() || name.includes("."));
}

export function jsxTransportSite(attribute: ts.JsxAttribute): number {
  return attribute.parent.parent.getStart();
}

export function isInsideJsxCallback(node: ts.Node, boundary: RuntimeFunctionLike): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (!isRuntimeFunctionLike(current)) {
      continue;
    }
    const attribute = findAncestorUntil(current, ts.isJsxAttribute, boundary);
    if (attribute && isInsideJsxAttribute(current, attribute)) {
      return true;
    }
  }
  return false;
}

export function hasUnstableJsxLifetime(node: ts.Node, boundary: ts.Node): boolean {
  const opening = node.parent.parent;
  if (
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    opening.attributes.properties.some(
      (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
    )
  ) {
    return true;
  }
  for (
    let current: ts.Node | undefined = opening.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isConditionalExpression(current) ||
      (ts.isBinaryExpression(current) &&
        (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
  }
  return nearestRepeatedRenderCall(opening, boundary) !== null;
}

export function isDirectArgumentToUnknownCall(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    ts.isCallExpression(parent) && parent.expression !== node && parent.arguments.includes(node)
  );
}

export function isOriginalStateBinding(node: ts.Identifier, call: ts.CallExpression): boolean {
  const declaration = call.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.name.getStart() <= node.getStart() &&
    node.end <= declaration.name.end
  );
}

export function hasAncestorInSet(node: ts.Node, ancestors: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ancestors.has(current)) {
      return true;
    }
  }
  return false;
}

export function isInsideImportedCallback(node: ts.Node, hookNames: ReadonlySet<string>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      hookNames.has(current.expression.text) &&
      current.arguments.some(
        (argument) => argument.getStart() <= node.getStart() && node.end <= argument.end,
      )
    ) {
      return true;
    }
  }
  return false;
}
