import {
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

export type JsxSubtreeNode = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

export function directJsxSubtree(
  expression: ts.Expression,
  boundary: ts.Node,
): JsxSubtreeNode | null {
  const current = unwrapTransparentExpression(expression);
  return literalJsxSubtree(current) ?? localJsxFactoryReturn(current, boundary);
}

function literalJsxSubtree(expression: ts.Expression): JsxSubtreeNode | null {
  const current = unwrapTransparentExpression(expression);
  return ts.isJsxElement(current) ||
    ts.isJsxFragment(current) ||
    ts.isJsxSelfClosingElement(current)
    ? current
    : null;
}

export function localJsxFactoryReturn(
  expression: ts.Expression,
  boundary: ts.Node,
): JsxSubtreeNode | null {
  const call = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(call) ||
    call.questionDotToken ||
    call.arguments.length > 0 ||
    !ts.isIdentifier(call.expression)
  ) {
    return null;
  }
  const factory = nullaryJsxFactory(boundary, call.expression.text);
  return factory ? factoryJsxResult(factory) : null;
}

function nullaryJsxFactory(
  boundary: ts.Node,
  factoryName: string,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const declaration = uniqueConstDeclaration(boundary, factoryName);
  if (!declaration?.initializer) {
    return null;
  }
  const factory = unwrapTransparentExpression(declaration.initializer);
  if (
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    factory.parameters.length > 0 ||
    factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    (ts.isFunctionExpression(factory) && factory.asteriskToken)
  ) {
    return null;
  }
  return factory;
}

function factoryJsxResult(
  factory: ts.ArrowFunction | ts.FunctionExpression,
): JsxSubtreeNode | null {
  if (!ts.isBlock(factory.body)) {
    return literalJsxSubtree(factory.body);
  }
  const returns: ts.ReturnStatement[] = [];
  visitSkippingNestedFunctions(factory.body, factory, (node) => {
    if (ts.isReturnStatement(node)) {
      returns.push(node);
    }
  });
  const returned = returns[0]?.expression;
  return returns.length === 1 && returned ? literalJsxSubtree(returned) : null;
}

function uniqueConstDeclaration(boundary: ts.Node, name: string): ts.VariableDeclaration | null {
  const declarations: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(boundary, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declarations.push(node);
    }
  });
  const [declaration] = declarations;
  if (
    declarations.length !== 1 ||
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return declaration;
}

export function uniqueConstJsxInitializer(boundary: ts.Node, name: string): ts.Expression | null {
  const initializer = uniqueConstDeclaration(boundary, name)?.initializer;
  return initializer && expressionContainsJsx(initializer) ? initializer : null;
}

export function expressionContainsJsx(expression: ts.Expression): boolean {
  let found = false;
  visit(expression, (node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) {
      found = true;
    }
  });
  return found;
}

export function jsxSubtreeAncestors(node: ts.Node, boundary: ts.Node): JsxSubtreeNode[] {
  const ancestors: JsxSubtreeNode[] = [];
  for (
    let current: ts.Node | undefined = node;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isJsxElement(current) ||
      ts.isJsxFragment(current) ||
      ts.isJsxSelfClosingElement(current)
    ) {
      ancestors.push(current);
    }
  }
  return ancestors;
}
