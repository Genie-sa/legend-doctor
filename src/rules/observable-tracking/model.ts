import type { ChildContractResolver } from "../child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type ts from "typescript";

export interface TrackingScan {
  readonly childContracts: ChildContractResolver | null;
  readonly fileName: string;
  readonly imports: HookImports;
  /** `@legendapp/state/babel` wraps element children of `Computed`, `Memo`, and `Show` in a function. */
  readonly legendBabel: boolean;
  readonly observableBindings: ReadonlySet<string>;
  /** The project's React Compiler config covers this file. */
  readonly reactCompiler: boolean;
  readonly sourceFile: ts.SourceFile;
}
