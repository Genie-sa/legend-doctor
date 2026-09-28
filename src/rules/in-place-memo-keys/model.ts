import type { HookImports } from "../../core/imports.js";
import type { InPlaceObservableWrite } from "../../project/source-components/observable-in-place-writes.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type ts from "typescript";

export interface InPlaceMemoKeyScan {
  /** Dotted observable paths whose declared initial value is an array literal. */
  readonly arrayPaths: ReadonlySet<string>;
  readonly fileName: string;
  readonly imports: HookImports;
  readonly inPlaceWrites: ReadonlyMap<string, readonly InPlaceObservableWrite[]>;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

/**
 * A member path the memo callback reads below the useValue result. A content read also depends
 * on everything below the path, because the callback computes its result from those contents.
 */
export interface MemoRead {
  readonly consumesContents: boolean;
  readonly path: readonly string[];
}

/** `const name = useValue(source)`, where the hook returns the tracked raw value itself. */
export interface RawValueBinding {
  readonly call: ts.CallExpression;
  readonly name: string;
  readonly owner: RuntimeFunctionLike;
  readonly sourcePath: readonly string[];
  readonly sourceText: string;
}

/** A write under the useValue source, relative to the value the hook returns. */
export interface RelativeWrite {
  readonly path: readonly string[];
  readonly write: InPlaceObservableWrite;
}

export interface StaleMemo {
  readonly call: ts.CallExpression;
  readonly otherDependencies: readonly string[];
  readonly reads: readonly MemoRead[];
  readonly writes: readonly RelativeWrite[];
}

/** A raw useValue binding with the in-place writes that reach below its source. */
export interface WrittenBinding {
  readonly binding: RawValueBinding;
  readonly writes: readonly RelativeWrite[];
}
