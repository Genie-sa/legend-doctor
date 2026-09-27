import type { InstalledLegendState } from "../core/types.js";

/** Toolchain facts that decide which rules apply to one analyzed file. */
export interface FileCapabilities {
  /** Every React renderer in the file's workspace creates only concurrent roots. */
  readonly concurrentRoot: boolean;
  readonly legendState: InstalledLegendState | null;
  /** The file's nearest package or bundler config enables the React Compiler. */
  readonly reactCompiler: boolean;
}

export const NO_CAPABILITIES: FileCapabilities = {
  concurrentRoot: false,
  legendState: null,
  reactCompiler: false,
};
