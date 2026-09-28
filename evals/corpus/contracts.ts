import type {
  AbstentionReason,
  HookAction,
  LegendPracticeAction,
  LegendPracticeFinding,
} from "../../src/core/types.js";

export interface CorpusTarget {
  application?: string;
  /** Optional broader source index for cross-file proofs when the measured target is focused. */
  contextRoot?: string;
  effects: number;
  id: string;
  root: string;
  states: number;
}

export interface CorpusRepository {
  commit: string;
  contextRoot?: string;
  name: string;
  targets: readonly CorpusTarget[];
  url: string;
}

export interface GoldHookCase {
  abstentionReason?: AbstentionReason;
  action: HookAction;
  /** The review question this finding must ask, named by the conversion a confirmed answer yields. */
  assumption?: { ifConfirmed: HookAction };
  enforced?: boolean;
  file: string;
  hook: "useEffect" | "useState";
  line: number;
  name: string | null;
  rationale: string;
  target: string;
}

export interface GoldStateGroupCase {
  file: string;
  line: number;
  members: readonly string[] | null;
  rationale: string;
  target: string;
}

export interface GoldPracticeCase {
  /** Assert cost classification when manually audited; omitted labels retain action-only matching. */
  disposition?: Exclude<LegendPracticeFinding["disposition"], "candidate">;
  action: LegendPracticeAction;
  file: string;
  line: number;
  rationale: string;
  target: string;
}

export type ReplayAction = HookAction | LegendPracticeAction;

interface ReplayCaseLocation {
  file: string;
  line: number;
  rationale: string;
  /** Text the parent line must contain, so a shifted label fails instead of scoring another hook. */
  source: string;
}

/** An expert edit with a matching analyzer action; only `enforced` cases count toward recall. */
export interface ScoredReplayCase extends ReplayCaseLocation {
  action: ReplayAction;
  /** Other actions that remove the same cost at this location. */
  equivalents?: readonly ReplayAction[];
  expected: "enforced" | "non-enforced";
}

/** An expert edit that removes no render or lifecycle cost a static recommendation could claim. */
export interface ExcludedReplayCase extends ReplayCaseLocation {
  expected: "excluded";
}

export type ReplayCase = ScoredReplayCase | ExcludedReplayCase;

/** One expert commit, scored against the analyzer's report on its first parent. */
export interface ReplayCommit {
  cases: readonly ReplayCase[];
  commit: string;
  /** The scanned "before" tree; CI fetches it by SHA, so it must be the full hash. */
  parent: string;
  repository: string;
  root: string;
}
