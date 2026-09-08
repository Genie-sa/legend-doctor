import type { AnalysisReport, HookFinding } from "../../src/core/types.js";
import type { GoldHookCase } from "../corpus/contracts.js";

export interface TargetResult {
  application: string;
  report: AnalysisReport;
  repository: string;
  root: string;
}

export interface Evaluation {
  failures: string[];
  hooks: number;
  targets: Map<string, TargetResult>;
}

export interface ActionScore {
  correct: number;
  expected: number;
  predicted: number;
}

export interface Tally {
  labels: number;
  matches: number;
  predictions: number;
}

export interface PracticeScore extends Tally {
  knownMisses: number;
}

export interface HookPair {
  finding: HookFinding;
  gold: GoldHookCase;
}

export interface SourceLocation {
  file: string;
  line: number;
}

export interface HookScore {
  actualActionable: number;
  /** Review labels that expect a confirmable question, and how many findings asked the expected one. */
  assumptions: { labeled: number; matched: number };
  byAction: Map<string, ActionScore>;
  correctActionable: number;
  expectedActionable: number;
  knownMisses: number;
  labeled: number;
  matched: number;
}
