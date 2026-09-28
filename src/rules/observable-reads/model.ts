import type { ChildContractResolver } from "../child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { InstalledLegendState } from "../../core/types.js";
import type { ObservableFieldFacts } from "./field-writes.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type ts from "typescript";

export type JsxSubtree = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

export type HookCallback = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

export interface ObservableReadScan {
  readonly primitivePaths?: ReadonlySet<string>;
  /** Primitive leaves seeded by a literal, so a read never activates a lazy source. */
  readonly plainSeedPaths?: ReadonlySet<string>;
  readonly imports: HookImports;
  /** Null when no installed or locked Legend State version was resolved. */
  readonly installedLegendState: InstalledLegendState | null;
  readonly observableBindings: ReadonlySet<string>;
  readonly observableFields: ObservableFieldFacts;
  readonly childContracts: ChildContractResolver | null;
  readonly sourceFile: ts.SourceFile;
  readonly fileName: string;
}

export interface UseValueDeclaration {
  readonly declaration: ts.VariableDeclaration;
  readonly call: ts.CallExpression;
  readonly localName: string;
  readonly observable: ts.Expression;
  readonly owner: RuntimeFunctionLike;
}

export interface NarrowCandidate {
  readonly declaration: ts.VariableDeclaration;
  /** The subscription callee as the source spells it: `useValue`, `use$`, `useSelector`, or an alias. */
  readonly hook: string;
  readonly observable: ts.Expression;
}

export interface RawValueReadScan {
  readonly candidate: NarrowCandidate;
  readonly localName: string;
  readonly owner: RuntimeFunctionLike;
  readonly paths: readonly (readonly string[])[];
  readonly optionalReferences: readonly ts.Identifier[];
}
