import ts from "typescript";

import {
  bindingDeclarationCount,
  isAssignmentOperator,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../ast.js";
import type { LegendPracticeFinding } from "../types.js";
import { RESERVED_OBSERVABLE_MEMBERS } from "./observable-reads.js";
import { uniqueVariableDeclaration } from "./state-proofs.js";

interface SnapshotBinding {
  declaration: ts.VariableDeclaration;
}

interface NarrowWrite {
  replacement: string;
  target: string;
}

export function findObservableCloneWritePractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  observableBindings: ReadonlySet<string>
): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, node => {
    if (!ts.isCallExpression(node)) return;
    const write = narrowObservableWrite(node, sourceFile, observableBindings);
    if (!write) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      action: "narrow-observable-write",
      confidence: "probable",
      disposition: "change",
      evidence: [
        `the object clone starts from a non-tracking snapshot of ${write.target}`,
        "the clone changes exactly one proven child and the snapshot binding is not mutated or escaped",
      ],
      location: { column: character + 1, file: fileName, line: line + 1 },
      message: `Replace this whole-object clone write with \`${write.replacement}\`; update the observable child directly so Legend does not clone or replace unaffected sibling fields.`,
      practice: "reactivity",
    });
  });
  return findings;
}

function narrowObservableWrite(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  observableBindings: ReadonlySet<string>
): NarrowWrite | null {
  if (
    call.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "set"
  ) {
    return null;
  }
  const target = unwrapTransparentExpression(call.expression.expression);
  const root = rootIdentifier(target);
  if (!root || !observableBindings.has(root.text)) return null;

  const value = unwrapTransparentExpression(call.arguments[0]!);
  if (!ts.isObjectLiteralExpression(value) || value.properties.length !== 2) return null;
  const [spread, override] = value.properties;
  if (!spread || !ts.isSpreadAssignment(spread) || !override) return null;

  const snapshot = snapshotTarget(spread.expression, call, sourceFile);
  if (!snapshot || snapshot.target.getText(sourceFile) !== target.getText(sourceFile)) return null;
  if (
    snapshot.binding &&
    !snapshotBindingIsReadOnly(snapshot.binding, spread, call)
  ) {
    return null;
  }

  const targetText = target.getText(sourceFile);
  if (ts.isShorthandPropertyAssignment(override)) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(override.name.text)) return null;
    return {
      replacement: `${targetText}.${override.name.text}.set(${override.name.text})`,
      target: targetText,
    };
  }
  if (!ts.isPropertyAssignment(override)) return null;
  const argument = override.initializer.getText(sourceFile);
  if (ts.isIdentifier(override.name) || ts.isStringLiteral(override.name)) {
    const property = override.name.text;
    if (RESERVED_OBSERVABLE_MEMBERS.has(property)) return null;
    const child = ts.isIdentifier(override.name)
      ? `.${property}`
      : `[${override.name.getText(sourceFile)}]`;
    return {
      replacement: `${targetText}${child}.set(${argument})`,
      target: targetText,
    };
  }
  if (ts.isNumericLiteral(override.name)) {
    return {
      replacement: `${targetText}[${override.name.getText(sourceFile)}].set(${argument})`,
      target: targetText,
    };
  }
  if (!ts.isComputedPropertyName(override.name) || !safeDynamicKey(override.name.expression)) {
    return null;
  }
  const key = override.name.expression.getText(sourceFile);
  return {
    replacement: `${targetText}[${key}].set(${argument})`,
    target: targetText,
  };
}

function snapshotTarget(
  expression: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile
): { binding: SnapshotBinding | null; target: ts.Expression } | null {
  const direct = peekTarget(expression);
  if (direct) return { binding: null, target: direct };
  const value = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(value)) return null;
  const owner = findAncestor(write, isRuntimeFunctionLike);
  if (!owner?.body || bindingDeclarationCount(owner, value.text) !== 1) return null;

  const resolved = uniqueVariableDeclaration(owner.body, value.text);
  if (
    !resolved?.initializer ||
    !ts.isVariableDeclarationList(resolved.parent) ||
    (resolved.parent.flags & ts.NodeFlags.Const) === 0 ||
    resolved.getStart(sourceFile) >= write.getStart(sourceFile)
  ) {
    return null;
  }
  const target = peekTarget(resolved.initializer);
  return target ? { binding: { declaration: resolved }, target } : null;
}

function peekTarget(expression: ts.Expression): ts.Expression | null {
  let value = unwrapTransparentExpression(expression);
  const fallback = ts.isBinaryExpression(value)
    ? unwrapTransparentExpression(value.right)
    : null;
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

function snapshotBindingIsReadOnly(
  binding: SnapshotBinding,
  targetSpread: ts.SpreadAssignment,
  write: ts.CallExpression
): boolean {
  const owner = findAncestor(write, isRuntimeFunctionLike);
  if (!owner?.body || !ts.isIdentifier(binding.declaration.name)) return false;
  let crossesAsyncBoundary = false;
  visit(owner.body, node => {
    if (
      node.getStart() > binding.declaration.end &&
      node.end < write.getStart() &&
      (ts.isAwaitExpression(node) || ts.isYieldExpression(node))
    ) {
      crossesAsyncBoundary = true;
    }
  });
  if (crossesAsyncBoundary) return false;
  const name = binding.declaration.name.text;
  let safe = true;
  visit(owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      node === binding.declaration.name ||
      node.getStart() >= write.end
    ) {
      return;
    }
    if (nodeWithin(node, targetSpread.expression)) return;
    const access = outermostAccess(node);
    const parent = access.parent;
    if (
      (ts.isBinaryExpression(parent) &&
        parent.left === access &&
        isAssignmentOperator(parent.operatorToken.kind)) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        parent.operand === access) ||
      (ts.isDeleteExpression(parent) && parent.expression === access) ||
      (access === node && ts.isCallExpression(parent) && parent.arguments.includes(access)) ||
      (access === node && ts.isNewExpression(parent) && parent.arguments?.includes(access) === true) ||
      (ts.isCallExpression(parent) && parent.expression === access) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === access) ||
      (ts.isSpreadElement(parent) && parent.expression === access)
    ) {
      safe = false;
    }
  });
  return safe;
}

function outermostAccess(root: ts.Identifier): ts.Expression {
  let current: ts.Expression = root;
  while (
    (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function safeDynamicKey(expression: ts.Expression): boolean {
  const key = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(key) || ts.isNumericLiteral(key)) return true;
  return ts.isStringLiteral(key) && !RESERVED_OBSERVABLE_MEMBERS.has(key.text);
}
