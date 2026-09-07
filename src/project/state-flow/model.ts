import type { RuntimeFunctionLike } from "../../core/ast.js";
import type ts from "typescript";

export type FlowProof = "disproven" | "proven" | "unknown";

export type StateFlowCoverage = "complete" | "not-requested" | "unknown";

export type RightExecution = "always" | "maybe" | "never";

export interface ExecutionPath {
  awaitEpoch: number;
  events: { call: ts.CallExpression; epoch: number }[];
  termination: "break" | "return" | "throw" | null;
}

export interface PathResult {
  paths: ExecutionPath[];
  unknown: boolean;
}

export interface ControlArm {
  arm: string;
  control: ts.Node;
  exclusive: boolean;
}

export interface Controls {
  left: readonly ControlArm[];
  right: readonly ControlArm[];
}

export interface ProofSurface {
  controls: Controls;
  fn: RuntimeFunctionLike;
}

export interface Lowering {
  breakable: boolean;
  left: ts.CallExpression;
  right: ts.CallExpression;
}

export interface ClauseRun {
  outputs: ExecutionPath[];
  paths: ExecutionPath[];
  unknown: boolean;
}

export interface ClauseRunInput {
  clauses: readonly ts.CaseOrDefaultClause[];
  lowering: Lowering;
  paths: readonly ExecutionPath[];
  start: number;
}
