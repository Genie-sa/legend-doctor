import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type ts from "typescript";

export type AsyncLeafStatus = "cohesive" | "isolated" | "unproven";

export type CommandRegion = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

export interface AsyncLeafStatusInputs {
  childContracts: ChildContractResolver | null;
  eventCallbacksByOwner: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
  localComponents: ReadonlySet<string>;
  reactiveMutationAffectedStates: ReadonlySet<StateCandidate>;
  safeCommandStates: ReadonlySet<StateCandidate>;
  sourceComponents: ReadonlySet<string>;
  states: readonly StateCandidate[];
  usageByState: ReadonlyMap<StateCandidate, StateUsage>;
}

export interface PendingCommand {
  alternateResetRegions: readonly CommandRegion[];
  ownerSetters: ReadonlySet<string>;
  pendingStart: ts.CallExpression;
  region: CommandRegion;
}

export const EMPTY_SEEN: ReadonlySet<string> = new Set();

export interface AsyncLeafCallSites {
  boundaries: readonly ts.Node[];
  requiresUnconditionalAwait: boolean;
  returned: ts.Expression;
}
