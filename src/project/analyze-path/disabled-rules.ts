import type { DisabledRule } from "../../core/types.js";

/** Counts one more analyzed file for each rule a file-level gate turned off. */
export function recordDisabledRules(
  disabledRules: Map<string, DisabledRule>,
  disabled: readonly Omit<DisabledRule, "files">[],
): void {
  for (const rule of disabled) {
    const key = `${rule.rule}\0${rule.reason}`;
    const entry = disabledRules.get(key) ?? { ...rule, files: 0 };
    disabledRules.set(key, { ...entry, files: entry.files + 1 });
  }
}
