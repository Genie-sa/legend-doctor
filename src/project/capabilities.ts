/** Toolchain facts that decide which rules apply to one analyzed file. */
export interface FileCapabilities {
  /** A Babel config above the file lists `@legendapp/state/babel`. */
  readonly legendBabel: boolean;
  /** The file's nearest package or bundler config enables the React Compiler. */
  readonly reactCompiler: boolean;
}

export const NO_CAPABILITIES: FileCapabilities = {
  legendBabel: false,
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
