import type { HookImports } from "../../core/imports.js";
import type ts from "typescript";

export interface TrackingScan {
  readonly fileName: string;
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}
