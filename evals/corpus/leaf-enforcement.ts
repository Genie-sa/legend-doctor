import type { GoldHookCase } from "./contracts.js";

const UNENFORCED_LEAF_TARGETS: ReadonlySet<string> = new Set([
  "expensify-biometrics-test",
  "formbricks-edit-membership-role",
]);

export function withLeafEnforcement(hookCase: GoldHookCase): GoldHookCase {
  if (!UNENFORCED_LEAF_TARGETS.has(hookCase.target)) {
    return hookCase;
  }
  const { action, ...rest } = hookCase;
  return { action, enforced: false, ...rest };
}
