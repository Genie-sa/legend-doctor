import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { InstalledLegendState } from "../../core/types.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type ts from "typescript";

export const KNOWN_GLOBAL_OBJECTS = new Set([
  "console",
  "Date",
  "Math",
  "JSON",
  "Promise",
  "globalThis",
]);

export interface CommittedRefContext {
  readonly reactNamespaces: ReadonlySet<string>;
  readonly useRefBindings: ReadonlySet<string>;
}

export interface EffectClassificationContext extends CommittedRefContext {
  readonly childContracts: ChildContractResolver | null;
  readonly imports: HookImports;
  readonly legendState: InstalledLegendState | null;
  readonly moduleScopeBindings: ReadonlySet<string>;
  readonly stateBySetter: ReadonlyMap<string, StateCandidate>;
  readonly stateByValue: ReadonlyMap<string, StateCandidate>;
  readonly usageBySetter: ReadonlyMap<string, StateUsage>;
  readonly useObservableBindings: ReadonlySet<string>;
  readonly useValueBindings: ReadonlySet<string>;
}

export interface InlineEffectContext extends EffectClassificationContext {
  readonly hasCleanup: boolean;
}

export interface DependencyEffectScope {
  readonly command: ts.CallExpression;
  readonly dependencies: ts.ArrayLiteralExpression;
  readonly effectCallback: ts.ArrowFunction | ts.FunctionExpression;
  readonly moduleScopeBindings: ReadonlySet<string>;
  readonly owner: RuntimeFunctionLike;
}

export interface EffectCallSurvey {
  readonly calls: readonly ts.CallExpression[];
  readonly commands: readonly ts.CallExpression[];
  readonly hasOtherMutation: boolean;
}
