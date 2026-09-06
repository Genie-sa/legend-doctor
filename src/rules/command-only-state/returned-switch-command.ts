import {
  bindingDeclarationCount,
  callRootIdentifier,
  collectBindingNames,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { nearestNestedFunction, visit } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import ts from "typescript";

const MINIMUM_COMMAND_SWITCH_CLAUSES = 2;

const GUARDED_FALLBACK_BRANCH_STATEMENTS = 2;

export function stateFeedsReturnedSwitchCommand(state: StateCandidate): boolean {
  if (bindingDeclarationCount(state.owner, state.valueName) !== 1) {
    return false;
  }
  const callback = returnedSwitchCommandCallback(state);
  const name = callback && localCallableName(callback);
  if (!name || bindingDeclarationCount(state.owner, name) !== 1) {
    return false;
  }
  const references = identifierReads(state.owner, name);
  return references.length === 1 && isDirectReturnedObjectMember(references[0]!, state.owner);
}

function identifierReads(owner: RuntimeFunctionLike, name: string): readonly ts.Identifier[] {
  const reads: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      reads.push(node);
    }
  });
  return reads;
}

function returnedSwitchCommandCallback(state: StateCandidate): ts.ArrowFunction | null {
  const reads = identifierReads(state.owner, state.valueName);
  const read = reads.length === 1 ? reads[0]! : null;
  const callback = read ? nearestNestedFunction(read, state.owner) : null;
  if (
    !read ||
    !callback ||
    !ts.isArrowFunction(callback) ||
    !ts.isBlock(callback.body) ||
    callback.body.statements.length !== 1 ||
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return null;
  }
  return isCommandOnlySwitch(callback.body.statements[0]!, read, state) ? callback : null;
}

function isCommandOnlySwitch(
  statement: ts.Statement,
  read: ts.Identifier,
  state: StateCandidate,
): boolean {
  return (
    ts.isSwitchStatement(statement) &&
    unwrapTransparentExpression(statement.expression) === read &&
    statement.caseBlock.clauses.length >= MINIMUM_COMMAND_SWITCH_CLAUSES &&
    statement.caseBlock.clauses.some(ts.isDefaultClause) &&
    statement.caseBlock.clauses.every((clause) => switchClauseIsCommandOnly(clause, state))
  );
}

function switchClauseIsCommandOnly(clause: ts.CaseOrDefaultClause, state: StateCandidate): boolean {
  let commands = 0;
  for (const statement of clause.statements) {
    if (ts.isBreakStatement(statement)) {
      continue;
    }
    if (!isImportedCommandStatement(statement, state)) {
      return ts.isDefaultClause(clause) && guardedFallbackIsCommandOnly(clause, state);
    }
    commands += 1;
  }
  return commands === 1;
}

function guardedFallbackIsCommandOnly(clause: ts.DefaultClause, state: StateCandidate): boolean {
  const [guard, fallback, exit, ...extra] = clause.statements;
  if (
    extra.length > 0 ||
    !guard ||
    !ts.isIfStatement(guard) ||
    guard.elseStatement ||
    !fallback ||
    !isImportedCommandStatement(fallback, state) ||
    !exit ||
    !ts.isBreakStatement(exit)
  ) {
    return false;
  }
  const condition = unwrapTransparentExpression(guard.expression);
  if (!ts.isIdentifier(condition) || !ownerParameterNames(state.owner).has(condition.text)) {
    return false;
  }
  const branch = guard.thenStatement;
  return (
    ts.isBlock(branch) &&
    branch.statements.length === GUARDED_FALLBACK_BRANCH_STATEMENTS &&
    isImportedCommandStatement(branch.statements[0]!, state) &&
    ts.isReturnStatement(branch.statements[1]!) &&
    branch.statements[1]!.expression === undefined
  );
}

function isImportedCommandStatement(statement: ts.Statement, state: StateCandidate): boolean {
  if (!ts.isExpressionStatement(statement)) {
    return false;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  return ts.isCallExpression(expression) && callRootIsImported(expression, state);
}

function ownerParameterNames(owner: RuntimeFunctionLike): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of owner.parameters) {
    collectBindingNames(parameter.name, names);
  }
  return names;
}

function callRootIsImported(call: ts.CallExpression, state: StateCandidate): boolean {
  const root = callRootIdentifier(call.expression);
  if (!root || bindingDeclarationCount(state.owner, root) !== 0) {
    return false;
  }
  return state.call.getSourceFile().statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) {
      return false;
    }
    const clause = statement.importClause;
    if (clause?.name?.text === root) {
      return true;
    }
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      return bindings.name.text === root;
    }
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => element.name.text === root)
    );
  });
}

function localCallableName(callback: ts.ArrowFunction): string | null {
  const declaration = callback.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === callback &&
    ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : null;
}

function isDirectReturnedObjectMember(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  const property = reference.parent;
  if (
    !ts.isShorthandPropertyAssignment(property) &&
    !(ts.isPropertyAssignment(property) && property.initializer === reference)
  ) {
    return false;
  }
  const object = property.parent;
  const returned = ts.isObjectLiteralExpression(object) ? object.parent : null;
  return (
    returned !== null &&
    ts.isReturnStatement(returned) &&
    returned.expression === object &&
    nearestNestedFunction(reference, owner) === null
  );
}
