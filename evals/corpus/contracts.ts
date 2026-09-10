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
