import type { InstalledLegendState } from "../core/types.js";

/** Toolchain facts that decide which rules apply to one analyzed file. */
export interface FileCapabilities {
  readonly legendState: InstalledLegendState | null;
  /** The file's nearest package or bundler config enables the React Compiler. */
  readonly reactCompiler: boolean;
}

export const NO_CAPABILITIES: FileCapabilities = { legendState: null, reactCompiler: false };
