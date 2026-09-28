import type { HookImports } from "../../core/imports.js";
import type ts from "typescript";

export interface MemoCaptureScan {
  readonly fileName: string;
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

/**
 * How a value captured from the owner's render can differ on the owner's next render. `binding`
 * names the declaration the change originates from, which a derived value reaches through its initializer.
 */
export type ValueChange =
  /** The owner re-renders when this hook's value changes: a Legend subscription, React state, or an external store. */
  | {
      readonly binding: string;
      readonly hook: string;
      readonly kind: "subscribed";
      readonly line: number;
    }
  /** A prop, an unproven hook or call result, or a reassignable variable, which a parent render may replace. */
  | {
      readonly binding: string;
      readonly kind: "render-scoped";
      readonly line: number;
      readonly source: string;
    };

export interface CapturedRead {
  readonly change: ValueChange;
  readonly line: number;
  readonly name: string;
}

export interface MemoElement {
  readonly closingTag: ts.JsxTagNameExpression;
  readonly element: ts.JsxElement;
  readonly openingTag: ts.JsxTagNameExpression;
}

export interface StaleMemo {
  readonly memo: MemoElement;
  readonly ownerName: string | null;
  readonly reads: readonly CapturedRead[];
}
