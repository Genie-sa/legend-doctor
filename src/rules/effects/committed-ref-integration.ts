import {
  bindingDeclarationCount,
  containsCallExpression,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { visit, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { CommittedRefContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { calleeRootIdentifier } from "./callback-shape.js";
import { isImportedHookCall } from "../../core/imports.js";
import ts from "typescript";

interface RefIntegrationScope {
  readonly derivedBindings: Set<string>;
  integratesCommittedRef: boolean;
  readonly refs: ReadonlySet<string>;
}

export function callbackIsCommittedRefIntegration(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: CommittedRefContext,
): boolean {
  if (!owner.body) {
    return false;
  }
  const refs = localCommittedRefBindings(owner, context.useRefBindings, context.reactNamespaces);
  if (refs.size === 0) {
    return false;
  }
  const scope: RefIntegrationScope = {
    derivedBindings: new Set<string>(),
    integratesCommittedRef: false,
    refs,
  };
  if (ts.isBlock(callback.body)) {
    return (
      statementsAreRefIntegration(callback.body.statements, scope) && scope.integratesCommittedRef
    );
  }
  return expressionIsRefIntegration(callback.body, scope) && scope.integratesCommittedRef;
}

function isCommittedRefRead(child: ts.Node, refs: ReadonlySet<string>): boolean {
  if (
    !ts.isPropertyAccessExpression(child) ||
    child.name.text !== "current" ||
    !ts.isIdentifier(child.expression) ||
    !refs.has(child.expression.text)
  ) {
    return false;
  }
  const { parent } = child;
  const directAssignment =
    ts.isBinaryExpression(parent) &&
    parent.left === child &&
    isAssignmentOperator(parent.operatorToken.kind);
  const directUpdate =
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === child;
  return !directAssignment && !directUpdate;
}

function readsCommittedRef(node: ts.Node, refs: ReadonlySet<string>): boolean {
  let reads = false;
  visit(node, (child) => {
    if (!reads && isCommittedRefRead(child, refs)) {
      reads = true;
    }
  });
  return reads;
}

function callResultIsRefDerived(value: ts.CallExpression, scope: RefIntegrationScope): boolean {
  const receiver =
    ts.isPropertyAccessExpression(value.expression) ||
    ts.isElementAccessExpression(value.expression)
      ? value.expression.expression
      : null;
  return (
    receiver !== null &&
    expressionIsRefDerived(receiver, scope) &&
    value.arguments.every((argument) => !containsCallExpression(argument))
  );
}

function expressionIsRefDerived(expression: ts.Expression, scope: RefIntegrationScope): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return scope.derivedBindings.has(value.text);
  }
  if (ts.isPropertyAccessExpression(value)) {
    return (
      (value.name.text === "current" &&
        ts.isIdentifier(value.expression) &&
        scope.refs.has(value.expression.text)) ||
      expressionIsRefDerived(value.expression, scope)
    );
  }
  if (ts.isElementAccessExpression(value)) {
    return (
      expressionIsRefDerived(value.expression, scope) &&
      (!value.argumentExpression || !containsCallExpression(value.argumentExpression))
    );
  }
  return ts.isCallExpression(value) && callResultIsRefDerived(value, scope);
}

function expressionIsRefIntegration(
  expression: ts.Expression,
  scope: RefIntegrationScope,
): boolean {
  if (
    !ts.isCallExpression(expression) ||
    (!readsCommittedRef(expression, scope.refs) && !expressionIsRefDerived(expression, scope))
  ) {
    return false;
  }
  let safe = true;
  visit(expression, (node) => {
    if (
      safe &&
      ts.isCallExpression(node) &&
      !readsCommittedRef(node, scope.refs) &&
      !expressionIsRefDerived(node, scope)
    ) {
      safe = false;
    }
  });
  if (safe) {
    scope.integratesCommittedRef = true;
  }
  return safe;
}

function statementsAreRefIntegration(
  statements: readonly ts.Statement[],
  scope: RefIntegrationScope,
): boolean {
  const inheritedBindings = new Set(scope.derivedBindings);
  const safe =
    statements.length > 0 &&
    statements.every((statement) => statementIsRefIntegration(statement, scope));
  scope.derivedBindings.clear();
  for (const binding of inheritedBindings) {
    scope.derivedBindings.add(binding);
  }
  return safe;
}

function constDeclarationsAreRefDerived(
  statement: ts.VariableStatement,
  scope: RefIntegrationScope,
): boolean {
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
    return false;
  }
  for (const declaration of statement.declarationList.declarations) {
    if (
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      !expressionIsRefDerived(declaration.initializer, scope)
    ) {
      return false;
    }
    scope.derivedBindings.add(declaration.name.text);
  }
  return true;
}

function statementIsRefIntegration(statement: ts.Statement, scope: RefIntegrationScope): boolean {
  if (ts.isBlock(statement)) {
    return statementsAreRefIntegration(statement.statements, scope);
  }
  if (ts.isReturnStatement(statement)) {
    return statement.expression === undefined;
  }
  if (ts.isVariableStatement(statement)) {
    return constDeclarationsAreRefDerived(statement, scope);
  }
  if (ts.isIfStatement(statement)) {
    return (
      !containsCallExpression(statement.expression) &&
      statementIsRefIntegration(statement.thenStatement, scope) &&
      (!statement.elseStatement || statementIsRefIntegration(statement.elseStatement, scope))
    );
  }
  return (
    ts.isExpressionStatement(statement) && expressionIsRefIntegration(statement.expression, scope)
  );
}

export function localCommittedRefBindings(
  owner: RuntimeFunctionLike,
  useRefBindings: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>,
): ReadonlySet<string> {
  const refs = new Set<string>();
  if (!owner.body) {
    return refs;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isImportedHookCall({
        call: node.initializer,
        localNames: useRefBindings,
        namespaceNames: reactNamespaces,
        canonicalName: "useRef",
      }) &&
      importedHookIsUnshadowed(node.initializer, owner) &&
      bindingDeclarationCount(owner, node.name.text) === 1
    ) {
      refs.add(node.name.text);
    }
  });
  return refs;
}

export function importedHookIsUnshadowed(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const root = calleeRootIdentifier(call.expression);
  return root !== null && bindingDeclarationCount(owner, root.text) === 0;
}
