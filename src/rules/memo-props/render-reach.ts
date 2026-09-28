import {
  findAncestor,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
} from "../../core/ast.js";
import {
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingDeclaration } from "./identity-model.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

/** Owner-scope bindings a set of render roots reads, directly or through the locals they use. */
export interface RenderReach {
  readonly bindings: ReadonlySet<string>;
  /** Why the reach cannot be closed, such as a reassignable local; null when it is complete. */
  readonly blocker: string | null;
}

interface ReachWalk {
  readonly bindings: Set<string>;
  blocker: string | null;
  readonly expanded: Set<ts.Node>;
  readonly owner: RuntimeFunctionLike;
  readonly pending: ts.Node[];
}

export function bindingKey(declaration: ts.Node, name: string): string {
  return `${declaration.pos}:${name}`;
}

/** Every owner binding the roots read, following each local's initializer, body, and writes. */
export function renderReach(roots: readonly ts.Node[], owner: RuntimeFunctionLike): RenderReach {
  const walk: ReachWalk = {
    bindings: new Set(),
    blocker: null,
    expanded: new Set(),
    owner,
    pending: [...roots],
  };
  for (let node = walk.pending.pop(); node; node = walk.pending.pop()) {
    visit(node, (candidate) => reachCandidate(candidate, walk));
  }
  return { bindings: walk.bindings, blocker: walk.blocker };
}

function reachCandidate(candidate: ts.Node, walk: ReachWalk): void {
  if (
    !ts.isIdentifier(candidate) ||
    isNonValueIdentifier(candidate) ||
    isDeclarationName(candidate)
  ) {
    return;
  }
  const declaration = bindingDeclaration(lexicalBinding(candidate));
  if (!declaration || !nodeWithin(declaration, walk.owner)) {
    return;
  }
  walk.bindings.add(bindingKey(declaration, candidate.text));
  expand(declaration, walk);
}

function expand(declaration: ts.Node, walk: ReachWalk): void {
  if (walk.expanded.has(declaration)) {
    return;
  }
  walk.expanded.add(declaration);
  walk.blocker ??= mutableOwnerBinding(declaration, walk.owner);
  walk.pending.push(...declarationSources(declaration, walk.owner));
}

function mutableOwnerBinding(declaration: ts.Node, owner: RuntimeFunctionLike): string | null {
  const list = ts.isVariableDeclaration(declaration) ? declaration.parent : null;
  const reassignable =
    list !== null &&
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) === 0 &&
    nearestNestedFunction(declaration, owner) === null;
  return reassignable ? "a reassignable local feeds the element" : null;
}

/** What determines a local's value: its initializer or body, and every in-place write to it. */
function declarationSources(declaration: ts.Node, owner: RuntimeFunctionLike): readonly ts.Node[] {
  if (isRuntimeFunctionLike(declaration)) {
    return [ts.isCallExpression(declaration.parent) ? declaration.parent : declaration];
  }
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return [];
  }
  const writes = ts.isIdentifier(declaration.name)
    ? ownerLevelReferences(owner, declaration.name).flatMap((reference) => {
        const statement = mutatingStatement(reference);
        return statement ? [statement] : [];
      })
    : [];
  return [declaration.initializer, ...writes];
}

/** The statement that writes through a local, as in `style.color = x` or `items.push(x)`. */
function mutatingStatement(reference: ts.Identifier): ts.Statement | null {
  const target = memberChainTop(reference);
  return target !== reference && isWriteTarget(target)
    ? findAncestor(target, ts.isStatement)
    : null;
}

function memberChainTop(reference: ts.Identifier): ts.Node {
  let current: ts.Node = reference;
  while (
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function isWriteTarget(target: ts.Node): boolean {
  const { parent } = target;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === target &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isCallExpression(parent) && parent.expression === target) ||
    ts.isDeleteExpression(parent)
  );
}
