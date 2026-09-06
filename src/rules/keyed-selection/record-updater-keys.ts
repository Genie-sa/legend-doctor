import { isPureExpression, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import ts from "typescript";

const RECORD_UPDATER_OBJECT_PROPERTY_COUNT = 2;

const RECORD_UPDATER_STATEMENT_COUNT = 3;

export function exactRecordEntryUpdaterKey(call: ts.CallExpression): ts.Expression | null {
  const updater = recordUpdaterFunction(call);
  if (!updater) {
    return null;
  }
  const { body, previous } = updater;
  return ts.isBlock(body)
    ? deletedRecordEntryKey(body, previous)
    : mergedRecordEntryKey(body, previous);
}

interface RecordUpdater {
  body: ts.ConciseBody;
  previous: string;
}

function recordUpdaterFunction(call: ts.CallExpression): RecordUpdater | null {
  if (call.arguments.length !== 1) {
    return null;
  }
  const updater = unwrapTransparentExpression(call.arguments[0]!);
  if (
    (!ts.isArrowFunction(updater) && !ts.isFunctionExpression(updater)) ||
    updater.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name)
  ) {
    return null;
  }
  return { body: updater.body, previous: updater.parameters[0]!.name.text };
}

function mergedRecordEntryKey(body: ts.Expression, previous: string): ts.Expression | null {
  const object = unwrapTransparentExpression(body);
  if (
    !ts.isObjectLiteralExpression(object) ||
    object.properties.length !== RECORD_UPDATER_OBJECT_PROPERTY_COUNT
  ) {
    return null;
  }
  const [spread, entry] = object.properties;
  if (
    !spread ||
    !ts.isSpreadAssignment(spread) ||
    !isIdentifierNamed(unwrapTransparentExpression(spread.expression), previous) ||
    !entry ||
    !ts.isPropertyAssignment(entry) ||
    !ts.isComputedPropertyName(entry.name) ||
    !isPureExpression(entry.name.expression) ||
    !isPureExpression(entry.initializer)
  ) {
    return null;
  }
  return entry.name.expression;
}

function deletedRecordEntryKey(body: ts.Block, previous: string): ts.Expression | null {
  if (body.statements.length !== RECORD_UPDATER_STATEMENT_COUNT) {
    return null;
  }
  const [cloneStatement, deleteStatement, returnStatement] = body.statements;
  if (
    !cloneStatement ||
    !ts.isVariableStatement(cloneStatement) ||
    (cloneStatement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
    cloneStatement.declarationList.declarations.length !== 1 ||
    !deleteStatement ||
    !ts.isExpressionStatement(deleteStatement) ||
    !ts.isDeleteExpression(deleteStatement.expression) ||
    !returnStatement ||
    !ts.isReturnStatement(returnStatement) ||
    !returnStatement.expression
  ) {
    return null;
  }
  const clone = cloneStatement.declarationList.declarations[0]!;
  const deleted = unwrapTransparentExpression(deleteStatement.expression.expression);
  if (
    !ts.isIdentifier(clone.name) ||
    !clonesPreviousRecord(clone, previous) ||
    !ts.isElementAccessExpression(deleted) ||
    !isIdentifierNamed(unwrapTransparentExpression(deleted.expression), clone.name.text) ||
    !deleted.argumentExpression ||
    !isPureExpression(deleted.argumentExpression) ||
    !isIdentifierNamed(unwrapTransparentExpression(returnStatement.expression), clone.name.text)
  ) {
    return null;
  }
  return deleted.argumentExpression;
}

function clonesPreviousRecord(clone: ts.VariableDeclaration, previous: string): boolean {
  const cloneValue = clone.initializer && unwrapTransparentExpression(clone.initializer);
  return (
    cloneValue !== undefined &&
    ts.isObjectLiteralExpression(cloneValue) &&
    cloneValue.properties.length === 1 &&
    ts.isSpreadAssignment(cloneValue.properties[0]!) &&
    isIdentifierNamed(unwrapTransparentExpression(cloneValue.properties[0]!.expression), previous)
  );
}

function isIdentifierNamed(node: ts.Expression, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}
