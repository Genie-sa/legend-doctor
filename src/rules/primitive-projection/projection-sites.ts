import { bindingDeclarationCount, isAssignmentOperator } from "../../core/analysis-ast.js";
import type { RenderFunction } from "../observable-tracking/render-owners.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

/** One read of the raw value: an equality comparison against the render's identity operand. */
export interface ProjectionSite {
  readonly comparison: ts.BinaryExpression;
  /** The raw value is the comparison's left operand. */
  readonly rawOnLeft: boolean;
}

export interface ProjectionSites {
  readonly operand: ts.Expression;
  readonly operator: ts.EqualityOperator;
  readonly sites: readonly [ProjectionSite, ...ProjectionSite[]];
}

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const LITERAL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.TrueKeyword,
]);

/**
 * Every read of `raw` is one side of the same equality comparison against the same operand, so
 * the render depends on the raw value only through that comparison's boolean.
 */
export function projectionSites(owner: RenderFunction, raw: ts.Identifier): ProjectionSites | null {
  if (bindingDeclarationCount(owner, raw.text) !== 1) {
    return null;
  }
  const [first, ...rest] = ownerLevelReferences(owner, raw).map((reference) =>
    comparisonSite(reference),
  );
  if (!first || rest.some((site) => site === null)) {
    return null;
  }
  const others = rest.filter((site) => site !== null);
  const operand = siteOperand(first);
  const operator = first.comparison.operatorToken.kind;
  const uniform = others.every(
    (site) =>
      site.comparison.operatorToken.kind === operator &&
      siteOperand(site).getText() === operand.getText(),
  );
  return uniform && isEqualityOperator(operator)
    ? { operand, operator, sites: [first, ...others] }
    : null;
}

export function siteOperand(site: ProjectionSite): ts.Expression {
  return site.rawOnLeft ? site.comparison.right : site.comparison.left;
}

function comparisonSite(reference: ts.Identifier): ProjectionSite | null {
  let side: ts.Expression = reference;
  while (ts.isParenthesizedExpression(side.parent)) {
    side = side.parent;
  }
  const comparison = side.parent;
  return ts.isBinaryExpression(comparison) &&
    EQUALITY_OPERATORS.has(comparison.operatorToken.kind) &&
    (comparison.left === side || comparison.right === side)
    ? { comparison, rawOnLeft: comparison.left === side }
    : null;
}

function isEqualityOperator(kind: ts.SyntaxKind): kind is ts.EqualityOperator {
  return EQUALITY_OPERATORS.has(kind);
}

/**
 * The operand has one value for the whole render: a literal, or a property path rooted in a
 * parameter, an earlier owner `const`, or a module constant. The selector closes over it, so the
 * value it compares on a later observable change is the one the render compared.
 */
export function isRenderStableOperand(
  operand: ts.Expression,
  owner: RenderFunction,
  hookStatement: ts.Statement,
): boolean {
  if (ts.isParenthesizedExpression(operand)) {
    return isRenderStableOperand(operand.expression, owner, hookStatement);
  }
  if (LITERAL_KINDS.has(operand.kind) || isNegativeNumber(operand)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(operand)) {
    return isRenderStableOperand(operand.expression, owner, hookStatement);
  }
  return ts.isIdentifier(operand) && isStableIdentifier(operand, owner, hookStatement);
}

function isNegativeNumber(operand: ts.Expression): boolean {
  return (
    ts.isPrefixUnaryExpression(operand) &&
    operand.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(operand.operand)
  );
}

function isStableIdentifier(
  identifier: ts.Identifier,
  owner: RenderFunction,
  hookStatement: ts.Statement,
): boolean {
  const declarations = bindingDeclarationCount(owner, identifier.text);
  if (declarations === 0) {
    return identifier.text === "undefined" || isModuleConstant(identifier);
  }
  return (
    declarations === 1 &&
    (isUnassignedParameter(identifier.text, owner) ||
      isEarlierOwnerConst(identifier.text, owner, hookStatement))
  );
}

function isUnassignedParameter(name: string, owner: RenderFunction): boolean {
  const names = new Set<string>();
  for (const parameter of owner.parameters) {
    visit(parameter.name, (node) => {
      if (ts.isIdentifier(node) && isBindingName(node)) {
        names.add(node.text);
      }
    });
  }
  return names.has(name) && !isAssignedIn(owner, name);
}

function isBindingName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (ts.isBindingElement(parent) || ts.isParameter(parent)) && parent.name === node;
}

function isEarlierOwnerConst(
  name: string,
  owner: RenderFunction,
  hookStatement: ts.Statement,
): boolean {
  const { body } = owner;
  if (!body || !ts.isBlock(body)) {
    return false;
  }
  const hookIndex = body.statements.indexOf(hookStatement);
  return body.statements
    .slice(0, hookIndex)
    .some((statement) => constStatementDeclares(statement, name));
}

function constStatementDeclares(statement: ts.Statement, name: string): boolean {
  if (
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const)
  ) {
    return false;
  }
  return statement.declarationList.declarations.some((declaration) =>
    bindingNames(declaration.name).has(name),
  );
}

function isDeclaredBinding(node: ts.Identifier): boolean {
  const { parent } = node;
  return (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node;
}

/** One module-level `const`, import, function, class, or enum declaration binds the name. */
function isModuleConstant(identifier: ts.Identifier): boolean {
  const sourceFile = identifier.getSourceFile();
  const declarations = sourceFile.statements.filter((statement) =>
    moduleStatementDeclares(statement, identifier.text),
  );
  const [declaration] = declarations;
  return (
    declarations.length === 1 &&
    declaration !== undefined &&
    (!ts.isVariableStatement(declaration) ||
      (declaration.declarationList.flags & ts.NodeFlags.Const) !== 0)
  );
}

function moduleStatementDeclares(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) =>
      bindingNames(declaration.name).has(name),
    );
  }
  if (ts.isImportDeclaration(statement)) {
    return importNames(statement).has(name);
  }
  return (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name
  );
}

function bindingNames(name: ts.BindingName): ReadonlySet<string> {
  const names = new Set<string>();
  visit(name, (node) => {
    if (ts.isIdentifier(node) && isDeclaredBinding(node)) {
      names.add(node.text);
    }
  });
  return names;
}

function importNames(statement: ts.ImportDeclaration): ReadonlySet<string> {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) {
    return new Set();
  }
  return new Set([...(clause.name ? [clause.name.text] : []), ...namedImports(clause)]);
}

function namedImports(clause: ts.ImportClause): readonly string[] {
  const bindings = clause.namedBindings;
  if (!bindings) {
    return [];
  }
  return ts.isNamespaceImport(bindings)
    ? [bindings.name.text]
    : bindings.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) => element.name.text);
}

function isAssignedIn(owner: ts.Node, name: string): boolean {
  let assigned = false;
  visit(owner, (node) => {
    assigned ||=
      (ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind) &&
        ts.isIdentifier(node.left) &&
        node.left.text === name) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        ts.isIdentifier(node.operand) &&
        node.operand.text === name);
  });
  return assigned;
}
