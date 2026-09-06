import { EMPTY_BINDINGS, MAX_PROJECTION_HOPS } from "../constants.js";
import {
  bindingDeclarationCount,
  collectBindingNames,
  isDeclarationName,
  isEvaluationInert,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import type { JsxSubtreeNode } from "../../rules/deferred-reveal/jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingReferencesIn } from "../keyed-cursor.js";
import { isSafeProjectionExpression } from "../../rules/deferred-reveal/safe-projections.js";
import { sourceHasRuntimeBinding } from "../../rules/state-proofs/binding-lookup.js";
import ts from "typescript";

interface ProjectionHopScope {
  readonly allowedCalls: ReadonlySet<string>;
  readonly owner: RuntimeFunctionLike;
}

function projectionHopIsSafe(
  declaration: ts.VariableDeclaration,
  current: { readonly depth: number; readonly reference: ts.Identifier },
  { allowedCalls, owner }: ProjectionHopScope,
): boolean {
  return (
    declaration.initializer !== undefined &&
    current.depth < MAX_PROJECTION_HOPS &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    bindingDeclarationCount(owner, declaration.name.text) === 1 &&
    isSafeProjectionExpression({
      expression: declaration.initializer,
      reference: current.reference,
      allowedIdentifierCalls: allowedCalls,
      allowedPropertyCalls: projectionMathCalls(owner),
    })
  );
}

export function terminalRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  roots: readonly ts.Node[],
  allowedCalls: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  if (!owner.body || roots.some((root) => !ts.isIdentifier(root))) {
    return null;
  }
  // SAFETY: the guard above returns null unless every root satisfies ts.isIdentifier.
  const pending = roots.map((root) => ({ depth: 0, reference: root as ts.Identifier }));
  const terminals = walkProjectionHops(pending, { allowedCalls, owner });
  return terminals && terminals.length > 0 ? terminals : null;
}

function walkProjectionHops(
  pending: ProjectionReferenceHop[],
  scope: ProjectionHopScope,
): ts.Identifier[] | null {
  const terminals: ts.Identifier[] = [];
  const visited = new Set<number>();
  for (let current = nextUnvisitedHop(pending, visited); current;) {
    const next = projectionHopReferences(current, scope);
    if (!next) {
      return null;
    }
    pushHopOrTerminal(current, next, { pending, terminals });
    current = nextUnvisitedHop(pending, visited);
  }
  return terminals;
}

function nextUnvisitedHop(
  pending: ProjectionReferenceHop[],
  visited: Set<number>,
): ProjectionReferenceHop | null {
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (markVisited(visited, current.reference)) {
      return current;
    }
  }
  return null;
}

function markVisited(visited: Set<number>, reference: ts.Identifier): boolean {
  const start = reference.getStart();
  if (visited.has(start)) {
    return false;
  }
  visited.add(start);
  return true;
}

interface ProjectionHopFrontier {
  readonly pending: ProjectionReferenceHop[];
  readonly terminals: ts.Identifier[];
}

function pushHopOrTerminal(
  current: ProjectionReferenceHop,
  next: readonly ProjectionReferenceHop[],
  { pending, terminals }: ProjectionHopFrontier,
): void {
  if (next.length === 0) {
    terminals.push(current.reference);
    return;
  }
  pending.push(...next);
}

interface ProjectionReferenceHop {
  readonly depth: number;
  readonly reference: ts.Identifier;
}

function projectionHopReferences(
  current: ProjectionReferenceHop,
  { allowedCalls, owner }: ProjectionHopScope,
): readonly ProjectionReferenceHop[] | null {
  const declaration = findAncestorUntil(current.reference, ts.isVariableDeclaration, owner);
  if (
    !declaration ||
    !declaration.initializer ||
    !nodeWithin(current.reference, declaration.initializer)
  ) {
    return [];
  }
  if (!projectionHopIsSafe(declaration, current, { allowedCalls, owner })) {
    return null;
  }
  const references = owner.body ? bindingReferencesIn(owner.body, declaration) : [];
  if (references.length === 0) {
    return null;
  }
  return references.map((reference) => ({ depth: current.depth + 1, reference }));
}

function projectionMathCalls(owner: RuntimeFunctionLike): ReadonlySet<string> {
  if (sourceHasRuntimeBinding(owner.getSourceFile(), "Math")) {
    return EMPTY_BINDINGS;
  }
  return new Set([
    "Math.abs",
    "Math.ceil",
    "Math.exp",
    "Math.floor",
    "Math.max",
    "Math.min",
    "Math.round",
    "Math.trunc",
  ]);
}

export function localPureProjectionBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        (!ts.isArrowFunction(declaration.initializer) &&
          !ts.isFunctionExpression(declaration.initializer)) ||
        !localProjectionFunctionIsPure(declaration.initializer, sourceFile)
      ) {
        continue;
      }
      bindings.add(declaration.name.text);
    }
  }
  return bindings;
}

function localProjectionFunctionIsPure(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
): boolean {
  if (
    fn.asteriskToken ||
    fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    fn.parameters.length === 0 ||
    fn.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer)
  ) {
    return false;
  }
  const expression = ts.isBlock(fn.body)
    ? fn.body.statements.length === 1 &&
      ts.isReturnStatement(fn.body.statements[0]!) &&
      fn.body.statements[0]!.expression
    : fn.body;
  if (!expression) {
    return false;
  }
  if (
    !isSafeProjectionExpression({
      expression,
      reference: expression,
      allowedIdentifierCalls: EMPTY_BINDINGS,
      allowedPropertyCalls: projectionMathCalls(fn),
    })
  ) {
    return false;
  }

  let safe = true;
  visit(fn.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      identifierIsProjectionParameter(node, fn) ||
      node.text === "Math"
    ) {
      return;
    }
    safe = moduleConstIsEvaluationInert(sourceFile, node.text);
  });
  return safe;
}

function identifierIsProjectionParameter(
  node: ts.Identifier,
  boundary: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) {
      const names = new Set<string>();
      for (const parameter of current.parameters) {
        collectBindingNames(parameter.name, names);
      }
      if (names.has(node.text)) {
        return true;
      }
    }
    if (current === boundary) {
      return false;
    }
  }
  return false;
}

function moduleConstIsEvaluationInert(sourceFile: ts.SourceFile, name: string): boolean {
  const matches: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        matches.push(declaration);
      }
    }
  }
  const [match] = matches;
  return (
    match !== undefined && match.initializer !== undefined && isEvaluationInert(match.initializer)
  );
}

export function nearestJsxElement(node: ts.Node, boundary: ts.Node): JsxSubtreeNode | null {
  return findAncestorUntil(
    node,
    (candidate): candidate is JsxSubtreeNode =>
      ts.isJsxElement(candidate) ||
      ts.isJsxSelfClosingElement(candidate) ||
      ts.isJsxFragment(candidate),
    boundary,
  );
}
