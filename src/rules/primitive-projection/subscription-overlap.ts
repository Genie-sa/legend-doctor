import {
  RESERVED_OBSERVABLE_MEMBERS,
  isUseValueCall,
} from "../observable-reads/observable-paths.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RenderOwner } from "../observable-tracking/render-owners.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isReactEffectCall } from "../react-commit-sensitivity/effect-lifecycle.js";
import ts from "typescript";

const IMPERATIVE_HANDLE_DEPENDENCY_INDEX = 2;

/**
 * Something else in the owner renders on the same observable changes: another subscription hook,
 * or, inside `observer`, a render `get()`, that names this path, an ancestor, or a descendant.
 */
export interface OwnedSubscription {
  readonly call: ts.CallExpression;
  readonly owner: RenderOwner;
  readonly path: readonly string[];
}

export function ownerTracksRelatedPath(
  { call: subscription, owner, path }: OwnedSubscription,
  imports: HookImports,
): boolean {
  let related = false;
  visit(owner.owner.body, (node) => {
    if (related || !ts.isCallExpression(node) || node === subscription) {
      return;
    }
    const tracking =
      (isUseValueCall(node, imports) &&
        findAncestor(node, isRuntimeFunctionLike) === owner.owner) ||
      (owner.tracked && isGetCall(node) && !isInside(node, subscription));
    related = tracking && mentionsRelatedPath(node, path);
  });
  return related;
}

function isGetCall(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "get";
}

function isInside(node: ts.Node, ancestor: ts.Node): boolean {
  return node.pos >= ancestor.pos && node.end <= ancestor.end;
}

function mentionsRelatedPath(call: ts.CallExpression, path: readonly string[]): boolean {
  const [root] = path;
  let related = false;
  visit(call, (node) => {
    if (related || !ts.isIdentifier(node) || node.text !== root || isMemberName(node)) {
      return;
    }
    const mentioned = memberChain(node);
    const shorter = Math.min(mentioned.length, path.length);
    related = mentioned.slice(0, shorter).every((part, index) => part === path[index]);
  });
  return related;
}

function isMemberName(node: ts.Identifier): boolean {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
}

/** `root.a.b` up to the first optional, computed, or observable-method member. */
function memberChain(root: ts.Identifier): readonly string[] {
  const chain = [root.text];
  let current: ts.Expression = root;
  let { parent } = current;
  while (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === current &&
    !parent.questionDotToken &&
    !RESERVED_OBSERVABLE_MEMBERS.has(parent.name.text)
  ) {
    chain.push(parent.name.text);
    current = parent;
    ({ parent } = current);
  }
  return chain;
}

/**
 * An effect without a dependency list runs after every commit, so a skipped render would skip one
 * of its runs. Effects with dependencies cannot read the projection's raw value, which is confined.
 */
export function hasEveryRenderEffect(owner: RenderOwner, imports: HookImports): boolean {
  let found = false;
  visit(owner.owner.body, (node) => {
    if (
      found ||
      !ts.isCallExpression(node) ||
      findAncestor(node, isRuntimeFunctionLike) !== owner.owner
    ) {
      return;
    }
    const dependencyIndex = effectDependencyIndex(node, imports);
    const dependencies = dependencyIndex === null ? null : node.arguments[dependencyIndex];
    found =
      dependencyIndex !== null && (!dependencies || !ts.isArrayLiteralExpression(dependencies));
  });
  return found;
}

/** Where a React effect-like hook takes its dependency list, or null for any other call. */
function effectDependencyIndex(call: ts.CallExpression, imports: HookImports): number | null {
  if (isReactEffectCall(call, imports)) {
    return 1;
  }
  const handle = isImportedHookCall({
    call,
    canonicalName: "useImperativeHandle",
    localNames: imports.useImperativeHandle,
    namespaceNames: imports.reactNamespaces,
  });
  return handle ? IMPERATIVE_HANDLE_DEPENDENCY_INDEX : null;
}
