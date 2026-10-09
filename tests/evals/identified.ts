import type { SourceLocation } from "../../src/core/types.js";

/** Gives hand-built findings the `id` every reported finding carries. */
export function identified<Finding extends { readonly location: SourceLocation }>(
  findings: readonly Finding[],
): (Finding & { id: string })[] {
  return findings.map((finding, index) => ({
    ...finding,
    id: `${finding.location.file}::${index}`,
  }));
}
