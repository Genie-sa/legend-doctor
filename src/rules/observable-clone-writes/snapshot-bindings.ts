import {
  bindingDeclarationCount,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";

interface SnapshotBinding {
  declaration: ts.VariableDeclaration;
}

interface SnapshotReadContext {
  owner: RuntimeFunctionLike;
  targetSpread: ts.SpreadAssignment | ts.SpreadElement;
  write: ts.CallExpression;
}

export function snapshotTarget(
  expression: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { binding: SnapshotBinding | null; target: ts.Expression } | null {
  const direct = peekTarget(expression);
  if (direct) {
    return { binding: null, target: direct };
  }
  const resolved = resolvedSnapshotBinding(expression, write, sourceFile);
  if (!resolved) {
    return null;
  }
  const target = peekTarget(resolved.initializer);
  return target ? { binding: { declaration: resolved.declaration }, target } : null;
}

function resolvedSnapshotBinding(
  expression: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { declaration: ts.VariableDeclaration; initializer: ts.Expression } | null {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(value)) {
    return null;
  }
  const owner = findAncestor(write, isRuntimeFunctionLike);
  if (!owner?.body || bindingDeclarationCount(owner, value.text) !== 1) {
    return null;
  }
  const resolved = uniqueVariableDeclaration(owner.body, value.text);
  if (
    !resolved?.initializer ||
    !ts.isVariableDeclarationList(resolved.parent) ||
    (resolved.parent.flags & ts.NodeFlags.Const) === 0 ||
    resolved.getStart(sourceFile) >= write.getStart(sourceFile)
  ) {
    return null;
  }
  return { declaration: resolved, initializer: resolved.initializer };
}

function peekTarget(expression: ts.Expression): ts.Expression | null {
  let value = unwrapTransparentExpression(expression);
  const fallback = ts.isBinaryExpression(value) ? unwrapTransparentExpression(value.right) : null;
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    fallback &&
    ts.isObjectLiteralExpression(fallback) &&
    fallback.properties.length === 0
  ) {
    value = unwrapTransparentExpression(value.left);
  }
  if (
    !ts.isCallExpression(value) ||
    value.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "peek"
  ) {
    return null;
  }
  return unwrapTransparentExpression(value.expression.expression);
}

export function snapshotBindingIsReadOnly(
  binding: SnapshotBinding,
  targetSpread: ts.SpreadAssignment | ts.SpreadElement,
  write: ts.CallExpression,
): boolean {
  const owner = findAncestor(write, isRuntimeFunctionLike);
  if (!owner?.body || !ts.isIdentifier(binding.declaration.name)) {
    return false;
  }
  if (crossesAsyncBoundary(owner.body, binding.declaration.end, write.getStart())) {
    return false;
  }
  const declared = binding.declaration.name;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !ts.isIdentifier(node) || node.text !== declared.text || node === declared) {
      return;
    }
    if (!referenceIsReadOnly(node, { owner, targetSpread, write })) {
      safe = false;
    }
  });
  return safe;
}

function crossesAsyncBoundary(body: ts.Node, start: number, end: number): boolean {
  let crosses = false;
  visit(body, (node) => {
    if (
      node.getStart() > start &&
      node.end < end &&
      (ts.isAwaitExpression(node) || ts.isYieldExpression(node))
    ) {
      crosses = true;
    }
  });
  return crosses;
}

function referenceIsReadOnly(node: ts.Identifier, context: SnapshotReadContext): boolean {
  const { owner, targetSpread, write } = context;
  if (nodeWithin(node, targetSpread.expression)) {
    return true;
  }
  if (
    node.getStart() >= write.end ||
    findAncestor(node, isRuntimeFunctionLike) !== owner ||
    referenceMayRepeatAfterWrite(node, write, owner)
  ) {
    return false;
  }
  const access = outermostAccess(node);
  if (access === node && !isControlConditionReference(node, owner)) {
    return false;
  }
  return !isMutatingAccess(access);
}

function isMutatingAccess(access: ts.Expression): boolean {
  const { parent } = access;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === access &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      parent.operand === access) ||
    (ts.isDeleteExpression(parent) && parent.expression === access) ||
    (ts.isCallExpression(parent) && parent.expression === access) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === access) ||
    (ts.isSpreadElement(parent) && parent.expression === access)
  );
}

function isControlConditionReference(node: ts.Node, owner: ts.Node): boolean {
  let current = node;
  while (current.parent && current.parent !== owner) {
    const { parent } = current;
    if (
      (ts.isIfStatement(parent) && parent.expression === current) ||
      (ts.isConditionalExpression(parent) && parent.condition === current)
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function referenceMayRepeatAfterWrite(node: ts.Node, write: ts.Node, owner: ts.Node): boolean {
  let current = node;
  while (current.parent && current.parent !== owner) {
    const { parent } = current;
    const repeatedCondition =
      ((ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
        parent.expression === current) ||
      (ts.isForStatement(parent) &&
        (parent.condition === current || parent.incrementor === current));
    if (repeatedCondition && nodeWithin(write, parent.statement)) {
      return true;
    }
    current = parent;
  }
  return false;
}

function outermostAccess(root: ts.Identifier): ts.Expression {
  let current: ts.Expression = root;
  while (
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}
