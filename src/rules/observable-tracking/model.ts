import type { ChildContractResolver } from "../child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { InstalledLegendState } from "../../core/types.js";
import type ts from "typescript";

export interface TrackingScan {
  readonly childContracts: ChildContractResolver | null;
  readonly fileName: string;
  readonly imports: HookImports;
  /** Null when no installed or locked Legend State version was resolved. */
  readonly installedLegendState: InstalledLegendState | null;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}
