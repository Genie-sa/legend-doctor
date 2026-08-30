import ts from "typescript";

import {
  bindingDeclarationCount,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { visit } from "../ast.js";
import type { EffectCandidate } from "../analyze-source.js";
import type { RuntimeFunctionLike } from "../ast.js";

export function isDependencyDrivenBrowserStorageEffect(effect: EffectCandidate): boolean {
  const { callback, dependencies, owner } = effect;
  if (
    !callback ||
    !ts.isBlock(callback.body) ||
    !dependencies?.elements.length ||
    !owner ||
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    callback.asteriskToken
  ) {
    return false;
  }
  let storageMutations = 0;
  const statementIsSafe = (statement: ts.Statement): boolean => {
    if (ts.isBlock(statement)) {
      return statement.statements.every(statementIsSafe);
    }
    if (ts.isIfStatement(statement)) {
      return (
        isSafeStorageExpression(statement.expression, owner) &&
        statementIsSafe(statement.thenStatement) &&
        (!statement.elseStatement || statementIsSafe(statement.elseStatement))
      );
    }
    if (ts.isReturnStatement(statement)) {
      return statement.expression === undefined;
    }
    if (!ts.isExpressionStatement(statement)) {
      return false;
    }
    const expression = unwrapTransparentExpression(
      ts.isVoidExpression(statement.expression)
        ? statement.expression.expression
        : statement.expression,
    );
    if (!ts.isCallExpression(expression) || !isBrowserStorageMutation(expression, owner)) {
      return false;
    }
    if (!expression.arguments.every((argument) => isSafeStorageExpression(argument, owner))) {
      return false;
    }
    storageMutations += 1;
    return true;
  };
  return callback.body.statements.every(statementIsSafe) && storageMutations > 0;
}

function isSafeStorageExpression(expression: ts.Expression, owner: RuntimeFunctionLike): boolean {
  let safe = true;
  visit(expression, (node) => {
    if (!safe) {
      return;
    }
    if (ts.isCallExpression(node)) {
      if (!isPureStorageHelper(node, owner)) {
        safe = false;
      }
      return;
    }
    if (
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind))
    ) {
      safe = false;
    }
  });
  return safe;
}

function isPureStorageHelper(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return false;
  }
  const root = callee.expression.text,
    method = callee.name.text;
  return (
    bindingDeclarationCount(owner, root) === 0 &&
    ((root === "JSON" && method === "stringify") || (root === "Object" && method === "keys"))
  );
}

function isBrowserStorageMutation(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    /^(?:clear|removeItem|setItem)$/u.test(callee.name.text) &&
    isBrowserStorageExpression(callee.expression, owner)
  );
}

function isBrowserStorageExpression(
  expression: ts.Expression,
  runtimeOwner: RuntimeFunctionLike,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return (
      /^(?:localStorage|sessionStorage)$/u.test(value.text) &&
      bindingDeclarationCount(runtimeOwner, value.text) === 0
    );
  }
  if (
    !ts.isPropertyAccessExpression(value) ||
    !/^(?:localStorage|sessionStorage)$/u.test(value.name.text)
  ) {
    return false;
  }
  const qualifier = unwrapTransparentExpression(value.expression);
  if (ts.isIdentifier(qualifier)) {
    return (
      /^(?:globalThis|window)$/u.test(qualifier.text) &&
      bindingDeclarationCount(runtimeOwner, qualifier.text) === 0
    );
  }
  return (
    ts.isPropertyAccessExpression(qualifier) &&
    qualifier.name.text === "window" &&
    ts.isIdentifier(qualifier.expression) &&
    qualifier.expression.text === "globalThis" &&
    bindingDeclarationCount(runtimeOwner, qualifier.expression.text) === 0
  );
}
