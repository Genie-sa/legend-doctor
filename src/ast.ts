import path from "node:path";

import ts from "typescript";

export type RuntimeFunctionLike =
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.SetAccessorDeclaration;

const RUNTIME_FUNCTION_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.SetAccessor,
]);

export function findAncestor<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T
): T | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (predicate(current)) return current;
  }
  return null;
}

export function findAncestorUntil<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T,
  boundary: ts.Node
): T | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (predicate(current)) return current;
  }
  return null;
}

export function isRuntimeFunctionLike(node: ts.Node): node is RuntimeFunctionLike {
  return RUNTIME_FUNCTION_KINDS.has(node.kind);
}

export function isNonProductionHarness(fileName: string): boolean {
  return /(?:^|\/)(?:__tests__|stories|demos)(?:\/|$)|\.(?:spec|test|stories?)\.[cm]?[jt]sx?$/i.test(
    fileName.split(path.sep).join("/")
  );
}

export function nearestNestedFunction(
  node: ts.Node,
  owner: RuntimeFunctionLike
): RuntimeFunctionLike | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (isRuntimeFunctionLike(current)) return current;
  }
  return null;
}

export function nodeWithin(node: ts.Node, ancestor: ts.Node): boolean {
  return ancestor.getStart() <= node.getStart() && node.end <= ancestor.end;
}

export function scriptKindForFile(fileName: string): ts.ScriptKind {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export function visit(node: ts.Node | undefined, callback: (node: ts.Node) => void): void {
  if (!node) return;
  callback(node);
  node.forEachChild(child => visit(child, callback));
}

export function visitSkippingNestedFunctions(
  node: ts.Node,
  allowedFunction: ts.FunctionLikeDeclaration,
  callback: (node: ts.Node) => void
): void {
  callback(node);
  node.forEachChild(child => {
    if (isRuntimeFunctionLike(child) && child !== allowedFunction) return;
    visitSkippingNestedFunctions(child, allowedFunction, callback);
  });
}

export function visitSkippingNestedRuntimeFunctions(
  node: ts.Node,
  callback: (node: ts.Node) => void
): void {
  callback(node);
  node.forEachChild(child => {
    if (isRuntimeFunctionLike(child)) return;
    visitSkippingNestedRuntimeFunctions(child, callback);
  });
}
