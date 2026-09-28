import {
  collectBindingNames,
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import {
  isRuntimeFunctionLike,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { jsxElementCountIn } from "../../rules/state-proofs/jsx-subtrees.js";
import ts from "typescript";

interface ScopedDeclaration {
  readonly declaration: ts.Node;
  readonly scope: ts.Node;
}

const declarationsByScope = new WeakMap<ts.Node, ReadonlyMap<string, ts.Node>>();

const sourcesByDeclaration = new WeakMap<ts.Node, Map<string, readonly ts.Node[]>>();

/**
 * Upper bound on the JSX elements an extracted leaf renders: the subtree plus the code behind every
 * owner-local binding it reaches, transitively, including each later assignment to that binding. A
 * render helper the subtree calls runs on each leaf render whether it moves into the leaf with the
 * state or is handed down from the owner, so its elements never count toward the owner's saving.
 * Owner parameters and module bindings sit outside the owner's own element count and are skipped.
 */
export function extractedJsxElementCount(subtree: ts.Node, owner: RuntimeFunctionLike): number {
  return extractedRenderRoots([subtree], owner).reduce(
    (total, root) => total + jsxElementCountIn(root),
    0,
  );
}

/** The outermost regions extracted leaves render: the subtrees and the owner code they reach. */
export function extractedRenderRoots(
  subtrees: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): readonly ts.Node[] {
  const roots = reachedRenderRoots(subtrees, owner);
  return roots.filter((root) => !roots.some((other) => other !== root && nodeWithin(root, other)));
}

function reachedRenderRoots(
  subtrees: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): readonly ts.Node[] {
  const roots = new Set<ts.Node>(subtrees);
  for (const root of roots) {
    for (const reference of valueReferences(root)) {
      for (const source of ownerBindingSources(reference, root, owner)) {
        roots.add(source);
      }
    }
  }
  return [...roots];
}

function valueReferences(root: ts.Node): readonly ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(root, (node) => {
    if (
      ts.isIdentifier(node) &&
      !isNonValueIdentifier(node) &&
      !isDeclarationName(node) &&
      !isIntrinsicJsxTagName(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function isIntrinsicJsxTagName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    (ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
    parent.tagName === node &&
    /^[a-z]/u.test(node.text)
  );
}

/**
 * A binding scoped inside the scanned root has every write inside it as well, so the root already
 * covers it; owner parameters and bindings declared above the owner sit outside its element count.
 */
function ownerBindingSources(
  reference: ts.Identifier,
  root: ts.Node,
  owner: RuntimeFunctionLike,
): readonly ts.Node[] {
  const scoped = scopedDeclaration(reference, owner);
  if (!scoped || nodeWithin(scoped.scope, root) || isOwnerParameter(scoped.declaration, owner)) {
    return [];
  }
  return bindingSources(scoped.declaration, reference.text, owner);
}

function scopedDeclaration(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): ScopedDeclaration | null {
  for (let scope: ts.Node = reference.parent; ; scope = scope.parent) {
    const declaration = scopeDeclarations(scope).get(reference.text);
    if (declaration) {
      return { declaration, scope };
    }
    if (scope === owner) {
      return null;
    }
  }
}

function isOwnerParameter(declaration: ts.Node, owner: RuntimeFunctionLike): boolean {
  return ts.isParameter(declaration) && declaration.parent === owner;
}

function isConstDeclaration(declaration: ts.Node): boolean {
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/** The declaration of a binding and every assignment that can give it a later value. */
function bindingSources(
  declaration: ts.Node,
  name: string,
  owner: RuntimeFunctionLike,
): readonly ts.Node[] {
  const byName = sourcesByDeclaration.get(declaration) ?? new Map<string, readonly ts.Node[]>();
  sourcesByDeclaration.set(declaration, byName);
  const cached = byName.get(name);
  if (cached) {
    return cached;
  }
  const sources: ts.Node[] = [declaration];
  if (!isConstDeclaration(declaration)) {
    visit(owner.body, (node) => {
      if (!ts.isIdentifier(node) || node.text !== name) {
        return;
      }
      const write = assignedValue(node);
      if (write && scopedDeclaration(node, owner)?.declaration === declaration) {
        sources.push(write);
      }
    });
  }
  byName.set(name, sources);
  return sources;
}

/** The expression that supplies a new value when the identifier is an assignment target. */
function assignedValue(node: ts.Identifier): ts.Node | null {
  let target: ts.Node = node;
  while (
    ts.isParenthesizedExpression(target.parent) ||
    ts.isArrayLiteralExpression(target.parent) ||
    ts.isObjectLiteralExpression(target.parent) ||
    ts.isShorthandPropertyAssignment(target.parent) ||
    ts.isPropertyAssignment(target.parent) ||
    ts.isSpreadElement(target.parent) ||
    ts.isSpreadAssignment(target.parent)
  ) {
    target = target.parent;
  }
  const { parent } = target;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    isAssignmentOperator(parent.operatorToken.kind)
  ) {
    return parent;
  }
  return (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
    parent.initializer === target
    ? parent.expression
    : null;
}

function scopeDeclarations(scope: ts.Node): ReadonlyMap<string, ts.Node> {
  let declarations = declarationsByScope.get(scope);
  if (!declarations) {
    declarations = collectScopeDeclarations(scope);
    declarationsByScope.set(scope, declarations);
  }
  return declarations;
}

function collectScopeDeclarations(scope: ts.Node): ReadonlyMap<string, ts.Node> {
  const declarations = new Map<string, ts.Node>();
  if (isRuntimeFunctionLike(scope)) {
    collectFunctionScope(scope, declarations);
  } else if (ts.isBlock(scope)) {
    collectBlockStatements(scope.statements, declarations);
  } else if (ts.isCaseBlock(scope)) {
    collectBlockStatements(
      scope.clauses.flatMap((clause) => clause.statements),
      declarations,
    );
  } else if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer) &&
    isBlockScoped(scope.initializer)
  ) {
    const source = ts.isForStatement(scope) ? null : scope.expression;
    for (const declaration of scope.initializer.declarations) {
      addBindingNames(declaration.name, source ?? declaration, declarations);
    }
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    addBindingNames(scope.variableDeclaration.name, scope.variableDeclaration, declarations);
  }
  return declarations;
}

function collectFunctionScope(
  scope: RuntimeFunctionLike,
  declarations: Map<string, ts.Node>,
): void {
  if (ts.isFunctionExpression(scope) && scope.name) {
    declarations.set(scope.name.text, scope);
  }
  for (const parameter of scope.parameters) {
    addBindingNames(parameter.name, parameter, declarations);
  }
  if (!scope.body) {
    return;
  }
  visitSkippingNestedRuntimeFunctions(scope.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      !isBlockScoped(node.parent)
    ) {
      addBindingNames(node.name, node, declarations);
    }
  });
}

function collectBlockStatements(
  statements: readonly ts.Statement[],
  declarations: Map<string, ts.Node>,
): void {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement) && isBlockScoped(statement.declarationList)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, declaration, declarations);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      declarations.set(statement.name.text, statement);
    }
  }
}

function isBlockScoped(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.BlockScoped) !== 0;
}

function addBindingNames(
  binding: ts.BindingName,
  declaration: ts.Node,
  declarations: Map<string, ts.Node>,
): void {
  const names = new Set<string>();
  collectBindingNames(binding, names);
  for (const name of names) {
    declarations.set(name, declaration);
  }
}
