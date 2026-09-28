import { directObservableReadPath, isUseValueCall } from "./observable-paths.js";
import { nearestNestedFunction, visit } from "../../core/ast.js";
import type { ObservableReadScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isPlainFunction } from "../state-proofs/event-roots.js";
import { runsOutsideRender } from "./render-exclusion.js";
import ts from "typescript";

type PlainFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

type RenderReadFacts = Pick<ObservableReadScan, "imports" | "observableBindings">;

/** Every ref, `peek()`, or untracked `get()` access that runs while `owner` renders. */
export function untrackedRenderReads(
  owner: RuntimeFunctionLike,
  facts: RenderReadFacts,
): readonly ts.Expression[] {
  const reads: ts.Expression[] = [];
  visit(owner.body, (node) => {
    if (isUntrackedRead(node, owner, facts) && !runsOutsideRender(node, owner, facts.imports)) {
      reads.push(node);
    }
  });
  return reads;
}

function isUntrackedRead(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  facts: RenderReadFacts,
): node is ts.Expression {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "current") {
    return true;
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const method = node.expression.name.text;
  return (
    method === "peek" ||
    (method === "get" && node.arguments.length === 0 && !isTrackedSelectorRead(node, owner, facts))
  );
}

/**
 * A proven observable's `get()` directly in the synchronous inline selector of a `useValue`, `use$`,
 * or `useSelector` call: that hook tracks the read and rerenders the owner itself when it changes.
 * Reads after an `await` or `yield` run outside the tracking context.
 */
function isTrackedSelectorRead(
  read: ts.CallExpression,
  owner: RuntimeFunctionLike,
  facts: RenderReadFacts,
): boolean {
  const selector = nearestNestedFunction(read, owner);
  const call = selector?.parent;
  return Boolean(
    selector &&
    call &&
    ts.isCallExpression(call) &&
    call.arguments[0] === selector &&
    isPlainFunction(selector) &&
    isSynchronous(selector) &&
    isUseValueCall(call, facts.imports) &&
    directObservableReadPath(read, facts.observableBindings),
  );
}

export function isSynchronous(callback: PlainFunction): boolean {
  return (
    !callback.asteriskToken &&
    !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}
