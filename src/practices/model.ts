import type { ChildContractResolver } from "../rules/child-contract/model.js";
import type { FileCapabilities } from "../project/capabilities.js";
import type { HookImports } from "../core/imports.js";
import type ts from "typescript";

export interface ObservableWrite {
  argument: ts.Expression;
  call: ts.CallExpression;
  parentPath: string | null;
  path: string;
  property: string | null;
  root: string;
}

export interface LegendPracticesRequest {
  capabilities: FileCapabilities;
  childContracts: ChildContractResolver | null;
  fileName: string;
  /** Dotted paths of imported observables whose initial value is an array literal; a root array is its bare name. */
  importedObservableArrayPaths: ReadonlySet<string>;
  importedObservableFactories: ReadonlySet<string>;
  importedObservableKeys: ReadonlyMap<string, ReadonlySet<string>>;
  importedObservables: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
}

export interface TransactionScan {
  fileName: string;
  imports: HookImports;
  observableBindings: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
}

export interface TransactionRun {
  conditionalWrites: ObservableWrite[];
  writes: ObservableWrite[];
}
