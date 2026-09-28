import { isRuntimeFunctionLike, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

interface GateWalk {
  readonly owner: RuntimeFunctionLike;
  readonly visited: Set<ts.Node>;
}

/** Conditions that decide whether the owner's render includes `element`, or null when unknown. */
export function renderGates(
  element: ts.Node,
  owner: RuntimeFunctionLike,
): readonly ts.Node[] | null {
  return gatesFrom(element, { owner, visited: new Set() });
}

function gatesFrom(child: ts.Node, walk: GateWalk): ts.Node[] | null {
  const { parent } = child;
  if (parent === walk.owner) {
    return [];
  }
  if (isRuntimeFunctionLike(parent) || ts.isSourceFile(parent)) {
    return null;
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
    return heldElementGates(parent, walk);
  }
  const outer = gatesFrom(parent, walk);
  return outer && [...enclosingConditions(parent, child), ...outer];
}

/** An element held in a local renders wherever the local is read, under each read's gates. */
function heldElementGates(declaration: ts.VariableDeclaration, walk: GateWalk): ts.Node[] | null {
  if (!ts.isIdentifier(declaration.name) || walk.visited.has(declaration)) {
    return null;
  }
  walk.visited.add(declaration);
  const readGates = ownerLevelReferences(walk.owner, declaration.name).map((reference) =>
    gatesFrom(reference, walk),
  );
  return readGates.includes(null) ? null : readGates.flatMap((gates) => gates ?? []);
}

function enclosingConditions(parent: ts.Node, child: ts.Node): readonly ts.Node[] {
  if (ts.isConditionalExpression(parent) || ts.isIfStatement(parent)) {
    return branchCondition(parent, child);
  }
  if (ts.isBinaryExpression(parent)) {
    return parent.right === child ? [parent.left] : [];
  }
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
    return clauseConditions(parent);
  }
  if (ts.isIterationStatement(parent, false)) {
    return [parent];
  }
  return ts.isBlock(parent) ? earlierExits(parent, child) : [];
}

function branchCondition(
  parent: ts.ConditionalExpression | ts.IfStatement,
  child: ts.Node,
): readonly ts.Node[] {
  const condition = ts.isIfStatement(parent) ? parent.expression : parent.condition;
  return condition === child ? [] : [condition];
}

function clauseConditions(clause: ts.CaseClause | ts.DefaultClause): readonly ts.Node[] {
  const discriminant = clause.parent.parent.expression;
  return ts.isCaseClause(clause) ? [clause.expression, discriminant] : [discriminant];
}

/** Statements before `statement` in its block that can leave the render early. */
function earlierExits(block: ts.Block, statement: ts.Node): readonly ts.Node[] {
  return block.statements
    .filter((sibling) => sibling.end <= statement.pos && exitsRender(sibling))
    .map((sibling) => (ts.isIfStatement(sibling) ? sibling.expression : sibling));
}

function exitsRender(statement: ts.Statement): boolean {
  let exits = false;
  visitSkippingNestedRuntimeFunctions(statement, (node) => {
    exits ||= ts.isReturnStatement(node) || ts.isThrowStatement(node);
  });
  return exits;
}
