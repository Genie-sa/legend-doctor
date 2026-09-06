import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type ts from "typescript";

export interface ObservableOwnershipScan {
  readonly fileName: string;
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

export type LegendFactory = "observable" | "useObservable";

export function callLocation(
  call: ts.CallExpression,
  scan: ObservableOwnershipScan,
): LegendPracticeFinding["location"] {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(scan.sourceFile),
  );
  return { column: character + 1, file: scan.fileName, line: line + 1 };
}
