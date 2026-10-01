import { isNonValueIdentifier, localBindingNames } from "../../core/analysis-ast.js";
import type { CommittedRefContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { localCommittedRefBindings } from "./committed-ref-integration.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export function capturesOwnerSnapshot(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: CommittedRefContext,
): boolean {
  const ownerLocals = localBindingNames(owner, callback);
  const callbackLocals = localBindingNames(callback, null);
  const committedRefs = localCommittedRefBindings(
    owner,
    context.useRefBindings,
    context.reactNamespaces,
  );
  let captures = false;
  visit(callback.body, (node) => {
    if (
      !captures &&
      ts.isIdentifier(node) &&
      ownerLocals.has(node.text) &&
      !committedRefs.has(node.text) &&
      !callbackLocals.has(node.text) &&
      !isNonValueIdentifier(node)
    ) {
      captures = true;
    }
  });
  return captures;
}
