import {
  bindingDeclarationCount,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import type { EffectCandidate } from "../analysis/model.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

export type BrowserStorage = "localStorage" | "sessionStorage";

const BROWSER_STORAGE_PATTERN = /^(?:localStorage|sessionStorage)$/u;
const STORAGE_MUTATION_PATTERN = /^(?:clear|removeItem|setItem)$/u;

/** The storages a proven persistence effect writes, in source order without repeats. */
export function browserStoragesWritten(effect: EffectCandidate): readonly BrowserStorage[] {
  const { callback, owner } = effect;
  if (!callback || !owner) {
    return [];
  }
  const storages = new Set<BrowserStorage>();
  visit(callback, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      return;
    }
    const storage = STORAGE_MUTATION_PATTERN.test(node.expression.name.text)
      ? browserStorageName(node.expression.expression, owner)
      : null;
    if (storage) {
      storages.add(storage);
    }
  });
  return [...storages];
}

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
      return isSafeStorageBranch(statement, owner, statementIsSafe);
    }
    if (ts.isReturnStatement(statement)) {
      return statement.expression === undefined;
    }
    if (
      !ts.isExpressionStatement(statement) ||
      !isBrowserStorageMutationStatement(statement, owner)
    ) {
      return false;
    }
    storageMutations += 1;
    return true;
  };
  return callback.body.statements.every(statementIsSafe) && storageMutations > 0;
}

function isSafeStorageBranch(
  statement: ts.IfStatement,
  owner: RuntimeFunctionLike,
  statementIsSafe: (statement: ts.Statement) => boolean,
): boolean {
  return (
    isSafeStorageExpression(statement.expression, owner) &&
    statementIsSafe(statement.thenStatement) &&
    (!statement.elseStatement || statementIsSafe(statement.elseStatement))
  );
}

function isBrowserStorageMutationStatement(
  statement: ts.ExpressionStatement,
  owner: RuntimeFunctionLike,
): boolean {
  const expression = unwrapTransparentExpression(
    ts.isVoidExpression(statement.expression)
      ? statement.expression.expression
      : statement.expression,
  );
  return (
    ts.isCallExpression(expression) &&
    isBrowserStorageMutation(expression, owner) &&
    expression.arguments.every((argument) => isSafeStorageExpression(argument, owner))
  );
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
  const root = callee.expression.text;
  const method = callee.name.text;
  return (
    bindingDeclarationCount(owner, root) === 0 &&
    ((root === "JSON" && method === "stringify") || (root === "Object" && method === "keys"))
  );
}

function isBrowserStorageMutation(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    STORAGE_MUTATION_PATTERN.test(callee.name.text) &&
    browserStorageName(callee.expression, owner) !== null
  );
}

function browserStorageName(
  expression: ts.Expression,
  runtimeOwner: RuntimeFunctionLike,
): BrowserStorage | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return bindingDeclarationCount(runtimeOwner, value.text) === 0
      ? asBrowserStorage(value.text)
      : null;
  }
  if (!ts.isPropertyAccessExpression(value)) {
    return null;
  }
  const storage = asBrowserStorage(value.name.text);
  return storage && isGlobalWindowQualifier(value.expression, runtimeOwner) ? storage : null;
}

function asBrowserStorage(name: string): BrowserStorage | null {
  return isBrowserStorage(name) ? name : null;
}

function isBrowserStorage(name: string): name is BrowserStorage {
  return BROWSER_STORAGE_PATTERN.test(name);
}

function isGlobalWindowQualifier(
  expression: ts.Expression,
  runtimeOwner: RuntimeFunctionLike,
): boolean {
  const qualifier = unwrapTransparentExpression(expression);
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
