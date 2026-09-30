import type { InstalledLegendState } from "../core/types.js";

/** Toolchain facts that decide which rules apply to one analyzed file. */
export interface FileCapabilities {
  /** Every React renderer in the file's workspace creates only concurrent roots. */
  readonly concurrentRoot: boolean;
  /** A Babel config above the file lists `@legendapp/state/babel`. */
  readonly legendBabel: boolean;
  readonly legendState: InstalledLegendState | null;
  /** The file's nearest package or bundler config enables the React Compiler. */
  readonly reactCompiler: boolean;
}

export const NO_CAPABILITIES: FileCapabilities = {
  concurrentRoot: false,
  legendBabel: false,
  legendState: null,
  reactCompiler: false,
};

export async function filesWhere(
  files: readonly string[],
  predicate: (file: string) => Promise<boolean>,
): Promise<ReadonlySet<string>> {
  const verdicts = await Promise.all(
    files.map(async (file) => ({ file, holds: await predicate(file) })),
  );
  return new Set(verdicts.filter((verdict) => verdict.holds).map((verdict) => verdict.file));
}
