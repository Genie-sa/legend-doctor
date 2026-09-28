import { findAncestor, visit } from "../../core/ast.js";
import type { HookReturnMember } from "../child-contract/model.js";
import { consumerBindingName } from "./consumer-binding.js";
import { hookBindingReferences } from "./hook-consumer-contract.js";
import { isRuntimeOwner } from "../hook-keyed-cursor-contract/binding-references.js";
import { ownerHasMutableRenderRead } from "../state-proofs/render-purpose.js";
import ts from "typescript";

export type HookMemberReadResult =
  | { readonly kind: "unread"; readonly calls: number }
  | { readonly kind: "unsafe" };

export interface HookMemberReadQuery {
  readonly harness: boolean;
  readonly hookBinding: string;
  readonly member: HookReturnMember;
  readonly sourceFile: ts.SourceFile;
}

const UNSAFE: HookMemberReadResult = { kind: "unsafe" };

/**
 * Proves that no call of one hook binding in a file reads a returned member. Production calls must
 * destructure the result without binding the member, or discard it, inside an owner whose render
 * refreshes no mutable read. A test or story harness must never name the member at all.
 */
export function hookMemberReadResult(query: HookMemberReadQuery): HookMemberReadResult {
  const calls = hookBindingReferences(query.sourceFile, query.hookBinding);
  if (calls === "unsafe") {
    return UNSAFE;
  }
  if (query.harness) {
    return calls.length === 0 || harnessNeverNamesMember(query.sourceFile, query.member)
      ? { calls: 0, kind: "unread" }
      : UNSAFE;
  }
  return calls.every((call) => callLeavesMemberUnread(call, query.member))
    ? { calls: calls.length, kind: "unread" }
    : UNSAFE;
}

function callLeavesMemberUnread(call: ts.CallExpression, member: HookReturnMember): boolean {
  const owner = findAncestor(call, isRuntimeOwner);
  if (!owner || ownerHasMutableRenderRead(owner)) {
    return false;
  }
  const { parent } = call;
  if (ts.isExpressionStatement(parent)) {
    return true;
  }
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === call &&
    !ts.isIdentifier(parent.name) &&
    consumerBindingName(parent.name, member) === null
  );
}

/** A harness that never spells a property member's name cannot read it, however it reaches the hook. */
export function harnessNeverNamesMember(
  sourceFile: ts.SourceFile,
  member: HookReturnMember,
): boolean {
  if (member.kind !== "property") {
    return false;
  }
  let named = false;
  visit(sourceFile, (node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === member.name) {
      named = true;
    }
  });
  return !named;
}
