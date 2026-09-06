import {
  containsElementAccess,
  staticPathHasBinding,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import type { LegendPracticeFinding } from "../core/types.js";
import { RESERVED_OBSERVABLE_MEMBERS } from "./observable-reads/observable-paths.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

export function findObservableTogglePractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  observableBindings: ReadonlySet<string>,
): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const target = exactBooleanToggleTarget(node, observableBindings);
    if (!target) {
      return;
    }
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const path = target.getText(sourceFile);
    findings.push({
      action: "toggle-observable",
      confidence: "certain",
      disposition: "change",
      evidence: [
        `${path} is a proven static Legend observable path`,
        "the set argument is exactly the negation of the same observable value without a tracked get() read",
      ],
      location: { column: character + 1, file: fileName, line: line + 1 },
      message: `Replace this exact boolean flip with \`${path}.toggle()\`; the direct observable operation preserves the update with less code.`,
      practice: "reactivity",
    });
  });
  return findings;
}

function exactBooleanToggleTarget(
  call: ts.CallExpression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  if (
    call.arguments.length !== 1 ||
    call.questionDotToken ||
    (call.typeArguments?.length ?? 0) > 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.questionDotToken ||
    call.expression.name.text !== "set"
  ) {
    return null;
  }
  const target = provenStaticObservablePath(call.expression.expression, observableBindings);
  if (!target) {
    return null;
  }
  const argument = unwrapTransparentExpression(call.arguments[0]!);
  if (isSamePathPeekNegation(argument, target)) {
    return target;
  }
  return isExactBooleanUpdater(argument) ? target : null;
}

function isSamePathPeekNegation(argument: ts.Expression, target: ts.Expression): boolean {
  if (
    !ts.isPrefixUnaryExpression(argument) ||
    argument.operator !== ts.SyntaxKind.ExclamationToken
  ) {
    return false;
  }
  const read = unwrapTransparentExpression(argument.operand);
  if (
    !ts.isCallExpression(read) ||
    read.arguments.length > 0 ||
    (read.typeArguments?.length ?? 0) > 0 ||
    read.questionDotToken ||
    !ts.isPropertyAccessExpression(read.expression) ||
    read.expression.questionDotToken ||
    read.expression.name.text !== "peek"
  ) {
    return false;
  }
  const readPath = staticPropertyPath(read.expression.expression);
  const targetPath = staticPropertyPath(target);
  return readPath !== null && targetPath !== null && samePath(readPath, targetPath);
}

function isExactBooleanUpdater(argument: ts.Expression): boolean {
  if (
    !ts.isArrowFunction(argument) ||
    argument.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    argument.parameters.length !== 1 ||
    !ts.isIdentifier(argument.parameters[0]!.name) ||
    ts.isBlock(argument.body)
  ) {
    return false;
  }
  const body = unwrapTransparentExpression(argument.body);
  if (!ts.isPrefixUnaryExpression(body) || body.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const operand = unwrapTransparentExpression(body.operand);
  return ts.isIdentifier(operand) && operand.text === argument.parameters[0]!.name.text;
}

function provenStaticObservablePath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  const path = unwrapTransparentExpression(expression);
  if (
    (!ts.isIdentifier(path) && !ts.isPropertyAccessExpression(path)) ||
    containsElementAccess(path) ||
    staticPropertyPath(path) === null
  ) {
    return null;
  }
  for (
    let current: ts.Expression = path;
    ts.isPropertyAccessExpression(current);
    current = current.expression
  ) {
    if (current.questionDotToken || RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) {
      return null;
    }
  }
  return staticPathHasBinding(path, observableBindings) ? path : null;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
