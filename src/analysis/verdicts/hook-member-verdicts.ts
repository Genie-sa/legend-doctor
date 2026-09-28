import {
  hookReturnMembers,
  hookStateValueIsOnlyReturned,
} from "../../rules/hook-consumer-contract/hook-consumer-contract.js";
import { isCustomHookOwner, runtimeFunctionName } from "../ast-helpers.js";
import type { ClassifiedState } from "../model.js";
import type { HookReturnMember } from "../../rules/child-contract/model.js";
import type { StateClassificationContext } from "./classification-context.js";
import { unusedStateVerdict } from "./intrinsic-verdicts.js";

/**
 * A hook state published under one property that no call site of the hook binds is unused state:
 * the local deletion proof applies once the return property is the value's only read, and the
 * closed-world consumer proof shows that dropping the property changes no reader.
 */
export function hookUnreadMemberVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const property = returnedOnlyProperty(context);
  const unused =
    property &&
    unusedStateVerdict({
      ...context,
      usage: { ...context.usage, directRenderNodes: [], localRenderReads: 0 },
    });
  const calls =
    unused &&
    context.childContracts?.hookStateUnreadMemberCalls(property.hookName, property.member);
  if (!property || !unused || !calls) {
    return null;
  }
  const { hookName, member } = property;
  const sites = `${calls} call ${calls === 1 ? "site" : "sites"}`;
  return {
    ...unused,
    message: `${unused.message} Also remove \`${member.name}\` from the object \`${hookName}\` returns; no source binding of \`${hookName}\` reads it (${sites} checked), so no reader observes its writes.`,
  };
}

interface ReturnedProperty {
  readonly hookName: string;
  readonly member: Extract<HookReturnMember, { kind: "property" }>;
}

/** The property a custom hook publishes its state under, when returning it is the state's only read. */
function returnedOnlyProperty({
  childContracts,
  state,
  usage,
}: StateClassificationContext): ReturnedProperty | null {
  const hookName = runtimeFunctionName(state.owner);
  const members = hookReturnMembers(state);
  return childContracts &&
    hookName !== null &&
    isCustomHookOwner(state.owner) &&
    members?.value.kind === "property" &&
    members.setter === null &&
    hookStateValueIsOnlyReturned(state) &&
    usage.localRenderReads === 1 &&
    usage.directRenderNodes.length === 1
    ? { hookName, member: members.value }
    : null;
}
