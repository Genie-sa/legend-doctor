import type { ClassifiedState, StateCandidate, StateUsage } from "./model.js";
import { identifiersNamed, nearestNestedFunction } from "../core/ast.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { isSynchronousRenderCallback } from "../rules/state-proofs/callback-sites.js";
import { lexicalBinding } from "../core/lexical-bindings.js";
import ts from "typescript";

/**
 * React re-runs a render that set its own state before committing it. An observable written at the
 * same point would notify its subscribers during this render instead, so no Legend owner applies.
 */
function stateHasRenderPhaseWrites(state: StateCandidate, usage: StateUsage): boolean {
  return usage.setterCallNodes.some((call) => runsWhileOwnerRenders(call, state.owner));
}

const LOCAL_CALL_DEPTH = 2;

/** Runs in the owner's body or a synchronous render callback, directly or via a local function. */
function runsWhileOwnerRenders(node: ts.Node, owner: RuntimeFunctionLike, depth = 0): boolean {
  let callback = nearestNestedFunction(node, owner);
  while (callback && isSynchronousRenderCallback(callback)) {
    callback = nearestNestedFunction(callback, owner);
  }
  if (!callback) {
    return true;
  }
  return (
    depth < LOCAL_CALL_DEPTH &&
    localCallSites(callback, owner).some((call) => runsWhileOwnerRenders(call, owner, depth + 1))
  );
}

function localCallSites(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
): ts.CallExpression[] {
  const name = boundName(callback);
  if (!name) {
    return [];
  }
  return identifiersNamed(owner.body, name).flatMap((identifier) => {
    const call = identifier.parent;
    if (!ts.isCallExpression(call) || call.expression !== identifier) {
      return [];
    }
    const binding = lexicalBinding(identifier);
    return binding?.kind === "function" && binding.declaration === callback ? [call] : [];
  });
}

function boundName(callback: RuntimeFunctionLike): string | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text ?? null;
  }
  const holder = ts.isCallExpression(callback.parent) ? callback.parent.parent : callback.parent;
  return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : null;
}

/** Deleting the state removes its render-phase write too; every other verdict keeps it in React. */
const SETTLED_ACTIONS: ReadonlySet<ClassifiedState["action"]> = new Set([
  "delete-derived-state",
  "delete-unused-state",
  "keep-state",
]);

export function renderPhaseWriteOverride(
  state: StateCandidate,
  usage: StateUsage,
  action: ClassifiedState["action"],
): ClassifiedState | null {
  if (SETTLED_ACTIONS.has(action) || !stateHasRenderPhaseWrites(state, usage)) {
    return null;
  }
  return {
    action: "keep-state",
    confidence: "probable",
    message: `Keep \`${state.valueName}\` as React state; \`${state.setterName}\` runs while its owner renders, so React re-renders with the adjusted value before committing. An observable written there would notify its subscribers in the middle of this render.`,
  };
}
