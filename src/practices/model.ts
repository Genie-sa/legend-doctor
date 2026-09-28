import type { ChildContractResolver } from "../rules/child-contract/model.js";
import type { FileCapabilities } from "../project/capabilities.js";
import type { HookImports } from "../core/imports.js";
import type { ObservableInPlaceWrites } from "../project/source-components/observable-in-place-writes.js";
import type { SubscriptionInventory } from "../core/subscriptions.js";
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
  subscriptionInventory?: SubscriptionInventory[] | undefined;
  importedObservablePrimitivePaths?: ReadonlySet<string>;
  importedObservablePlainSeedPaths?: ReadonlySet<string>;
  capabilities: FileCapabilities;
  childContracts: ChildContractResolver | null;
  fileName: string;
  /** Dotted paths of imported observables whose initial value is an array literal; a root array is its bare name. */
  importedObservableArrayPaths: ReadonlySet<string>;
  /** Per imported exact object-literal observable, the top-level keys that hold data rather than functions. */
  importedObservableDataKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  importedObservableFactories: ReadonlySet<string>;
  importedObservableKeys: ReadonlyMap<string, ReadonlySet<string>>;
  importedObservables: ReadonlySet<string>;
  /** In-place writes anywhere in the project, keyed by the local name of the written observable. */
  observableInPlaceWrites: ObservableInPlaceWrites;
  sourceFile: ts.SourceFile;
}

export interface TransactionScan {
  /** React already coalesces the writes into one render, so batching changes only non-React observers. */
  concurrentRoot: boolean;
  fileName: string;
  imports: HookImports;
  observableBindings: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
}

export interface TransactionRun {
  conditionalWrites: ObservableWrite[];
  writes: ObservableWrite[];
}
