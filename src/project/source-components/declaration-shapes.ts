import type { ReactComponentWrappers } from "../../core/react-component-wrappers.js";
import { isReactComponentWrapper } from "../../core/react-component-wrappers.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

export function isInsideModuleDeclaration(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) {
      return true;
    }
    if (ts.isSourceFile(current) || isRuntimeFunctionLike(current)) {
      return false;
    }
  }
  return false;
}

export function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function isSemanticComponentName(name: string): boolean {
  const first = name.slice(0, 1);
  return first !== "" && first === first.toUpperCase();
}

export function isComponentInitializer(
  node: ts.Expression,
  wrappers: ReactComponentWrappers,
): boolean {
  const initializer = unwrapTransparentExpression(node);
  if (
    ts.isArrowFunction(initializer) ||
    ts.isFunctionExpression(initializer) ||
    ts.isClassExpression(initializer)
  ) {
    return true;
  }
  if (
    !ts.isCallExpression(initializer) ||
    !isReactComponentWrapper(initializer.expression, wrappers)
  ) {
    return false;
  }
  const [renderFunction] = initializer.arguments;
  return renderFunction !== undefined && isComponentRenderFunction(renderFunction);
}

export function componentFunction(
  node: ts.Expression,
  wrappers: ReactComponentWrappers,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const initializer = unwrapTransparentExpression(node);
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer;
  }
  if (
    ts.isCallExpression(initializer) &&
    isReactComponentWrapper(initializer.expression, wrappers) &&
    initializer.arguments.length > 0
  ) {
    const [argument] = initializer.arguments;
    return argument ? componentRenderFunction(argument) : null;
  }
  return null;
}

function isComponentRenderFunction(node: ts.Expression): boolean {
  return componentRenderFunction(node) !== null;
}

function componentRenderFunction(
  node: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  const render = unwrapTransparentExpression(node);
  return ts.isArrowFunction(render) || ts.isFunctionExpression(render) ? render : null;
}

export function hasExport(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export function hasDefault(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return (
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false
  );
}
