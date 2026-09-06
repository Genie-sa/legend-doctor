import type { EffectCandidate, StateCandidate } from "../../analysis/model.js";
import {
  bindingDeclarationCount,
  collectBindingNames,
  isPureExpression,
  localBindingNames,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  importedHookIsUnshadowed,
  localCommittedRefBindings,
} from "./committed-ref-integration.js";
import type { CommittedRefContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import { soleExpressionStatementBody } from "./callback-shape.js";
import ts from "typescript";

const MINIMUM_COMMITTED_GUARD_STATEMENTS = 2;

export function isCommittedPropRefSnapshot(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  const { callback, dependencies, owner } = effect;
  const [dependency] = dependencies?.elements ?? [];
  if (
    !callback ||
    !owner ||
    !ts.isBlock(callback.body) ||
    callback.body.statements.length !== 1 ||
    dependencies?.elements.length !== 1 ||
    !dependency ||
    !ts.isIdentifier(dependency)
  ) {
    return false;
  }
  const refName = dependency.text;
  const [statement] = callback.body.statements;
  const argument =
    statement && parameterBindingNames(owner).has(refName)
      ? refCurrentSetterArgument(statement, stateBySetter)
      : null;
  return (
    argument !== null &&
    ts.isPropertyAccessExpression(argument) &&
    argument.name.text === "current" &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === refName
  );
}

function refCurrentSetterArgument(
  statement: ts.Statement,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): ts.Expression | null {
  if (!ts.isExpressionStatement(statement)) {
    return null;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !stateBySetter.has(expression.expression.text) ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  return unwrapTransparentExpression(expression.arguments[0]!);
}

function parameterBindingNames(owner: RuntimeFunctionLike): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of owner.parameters) {
    collectBindingNames(parameter.name, names);
  }
  return names;
}

export function isExactLatestValueRefMirror(
  effect: EffectCandidate,
  context: CommittedRefContext,
): boolean {
  const { callback, dependencies, owner } = effect;
  const dependency = dependencies?.elements[0] ?? null;
  if (!callback || !owner || (dependencies !== null && dependencies.elements.length !== 1)) {
    return false;
  }
  const mirror = latestValueRefAssignment(callback);
  if (
    !mirror ||
    localBindingNames(callback, null).has(mirror.refName) ||
    !localCommittedRefBindings(owner, context.useRefBindings, context.reactNamespaces).has(
      mirror.refName,
    )
  ) {
    return false;
  }
  const sourceFile = effect.call.getSourceFile();
  return (
    isPureExpression(mirror.source) &&
    (dependency === null ||
      mirror.source.getText(sourceFile) ===
        unwrapTransparentExpression(dependency).getText(sourceFile))
  );
}

interface RefMirrorAssignment {
  readonly refName: string;
  readonly source: ts.Expression;
}

function latestValueRefAssignment(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): RefMirrorAssignment | null {
  const statementExpression = soleExpressionStatementBody(callback);
  const assignment = statementExpression && unwrapTransparentExpression(statementExpression);
  if (
    !assignment ||
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }
  const target = unwrapTransparentExpression(assignment.left);
  if (
    !ts.isPropertyAccessExpression(target) ||
    target.name.text !== "current" ||
    !ts.isIdentifier(target.expression)
  ) {
    return null;
  }
  return {
    refName: target.expression.text,
    source: unwrapTransparentExpression(assignment.right),
  };
}

export function isExactCommittedPreviousValueGuard(
  effect: EffectCandidate,
  context: CommittedRefContext,
): boolean {
  const { callback, dependencies, owner } = effect;
  const ownerBody = owner?.body;
  const [dependency] = dependencies?.elements ?? [];
  if (
    !callback ||
    !owner ||
    !ownerBody ||
    !ts.isBlock(ownerBody) ||
    !ts.isBlock(callback.body) ||
    !isSynchronousParameterlessCallback(callback) ||
    dependencies?.elements.length !== 1 ||
    !dependency ||
    !ts.isIdentifier(dependency) ||
    callback.body.statements.length < MINIMUM_COMMITTED_GUARD_STATEMENTS
  ) {
    return false;
  }
  const refName = committedPreviousValueRefName(callback.body, dependency.text);
  if (!refName || localBindingNames(callback, null).has(refName)) {
    return false;
  }
  const query: SeededRefQuery = {
    context,
    dependencyName: dependency.text,
    owner,
    refName,
  };
  return ownerBody.statements.some((statement) => declaresSeededCommittedRef(statement, query));
}

function isSynchronousParameterlessCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  return (
    callback.parameters.length === 0 &&
    !callback.asteriskToken &&
    !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function committedPreviousValueRefName(body: ts.Block, dependencyName: string): string | null {
  const [guard, commitStatement] = body.statements;
  if (
    !guard ||
    !ts.isIfStatement(guard) ||
    guard.elseStatement ||
    !isBareReturn(guard.thenStatement)
  ) {
    return null;
  }
  const condition = unwrapTransparentExpression(guard.expression);
  if (
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return null;
  }
  const refName = committedRefComparedWithDependency(condition, dependencyName);
  return refName && commitsDependencyToRef(commitStatement, refName, dependencyName)
    ? refName
    : null;
}

function commitsDependencyToRef(
  statement: ts.Statement | undefined,
  refName: string,
  dependencyName: string,
): boolean {
  if (!statement || !ts.isExpressionStatement(statement)) {
    return false;
  }
  const commit = unwrapTransparentExpression(statement.expression);
  if (!ts.isBinaryExpression(commit) || commit.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return false;
  }
  const committedValue = unwrapTransparentExpression(commit.right);
  return (
    committedRefName(commit.left) === refName &&
    ts.isIdentifier(committedValue) &&
    committedValue.text === dependencyName
  );
}

interface SeededRefQuery {
  readonly context: CommittedRefContext;
  readonly dependencyName: string;
  readonly owner: RuntimeFunctionLike;
  readonly refName: string;
}

function declaresSeededCommittedRef(statement: ts.Statement, query: SeededRefQuery): boolean {
  if (
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const)
  ) {
    return false;
  }
  return statement.declarationList.declarations.some((declaration) =>
    isSeededCommittedRefDeclaration(declaration, query),
  );
}

function isSeededCommittedRefDeclaration(
  declaration: ts.VariableDeclaration,
  query: SeededRefQuery,
): boolean {
  const { initializer } = declaration;
  return (
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === query.refName &&
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    isImportedHookCall({
      call: initializer,
      localNames: query.context.useRefBindings,
      namespaceNames: query.context.reactNamespaces,
      canonicalName: "useRef",
    }) &&
    importedHookIsUnshadowed(initializer, query.owner) &&
    initializer.arguments.length === 1 &&
    ts.isIdentifier(initializer.arguments[0]!) &&
    initializer.arguments[0]!.text === query.dependencyName &&
    bindingDeclarationCount(query.owner, query.refName) === 1
  );
}

function isBareReturn(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) {
    return statement.expression === undefined;
  }
  return (
    ts.isBlock(statement) &&
    statement.statements.length === 1 &&
    ts.isReturnStatement(statement.statements[0]!) &&
    statement.statements[0]!.expression === undefined
  );
}

function committedRefComparedWithDependency(
  condition: ts.BinaryExpression,
  dependencyName: string,
): string | null {
  const left = unwrapTransparentExpression(condition.left);
  const right = unwrapTransparentExpression(condition.right);
  if (ts.isIdentifier(left) && left.text === dependencyName) {
    return committedRefName(right);
  }
  if (ts.isIdentifier(right) && right.text === dependencyName) {
    return committedRefName(left);
  }
  return null;
}

function committedRefName(expression: ts.Expression): string | null {
  const target = unwrapTransparentExpression(expression);
  return ts.isPropertyAccessExpression(target) &&
    target.name.text === "current" &&
    ts.isIdentifier(target.expression)
    ? target.expression.text
    : null;
}
