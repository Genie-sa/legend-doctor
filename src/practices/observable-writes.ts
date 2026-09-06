import {
  containsElementAccess,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import type { HookImports } from "../core/imports.js";
import type { ObservableWrite } from "./model.js";
import { expressionIsObservablePath } from "./observable-paths.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

interface SetCall {
  argument: ts.Expression;
  call: ts.CallExpression;
  receiver: ts.Expression;
}

function setCallStatement(statement: ts.Statement): SetCall | null {
  if (!ts.isExpressionStatement(statement)) {
    return null;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return null;
  }
  const [argument] = expression.arguments;
  if (
    expression.expression.name.text !== "set" ||
    expression.arguments.length !== 1 ||
    !argument ||
    containsAwaitOrYield(argument)
  ) {
    return null;
  }
  return { argument, call: expression, receiver: expression.expression.expression };
}

export function observableWrite(
  statement: ts.Statement,
  observableBindings: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
): ObservableWrite | null {
  const setCall = setCallStatement(statement);
  if (!setCall || containsElementAccess(setCall.receiver)) {
    return null;
  }
  const { receiver } = setCall;
  const root = rootIdentifier(receiver);
  if (!root || !expressionIsObservablePath(receiver, observableBindings)) {
    return null;
  }
  const field = ts.isPropertyAccessExpression(receiver) ? receiver : null;
  return {
    argument: setCall.argument,
    call: setCall.call,
    parentPath: field ? field.expression.getText(sourceFile) : null,
    path: receiver.getText(sourceFile),
    property: field?.name.text ?? null,
    root: root.text,
  };
}

function containsAwaitOrYield(node: ts.Node): boolean {
  let found = false;
  visit(node, (current) => {
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) {
      found = true;
    }
  });
  return found;
}

export function isInsideBatch(call: ts.CallExpression, imports: HookImports): boolean {
  for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) {
      continue;
    }
    const { expression } = current;
    if (ts.isIdentifier(expression) && imports.batch.has(expression.text)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      imports.legendNamespaces.has(expression.expression.text) &&
      expression.name.text === "batch"
    ) {
      return true;
    }
  }
  return false;
}
