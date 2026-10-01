import type { ReplayCommit } from "../contracts.js";

const unusedPhaseConfigs = {
  cases: [
    {
      expected: "excluded",
      file: "components/MomentCard.tsx",
      line: 49,
      rationale: "Wraps MomentCard in React.memo, a memo boundary.",
      source: "export function MomentCard({",
    },
    {
      action: "peek-unrendered-use-value",
      expected: "enforced",
      file: "components/MomentCard.tsx",
      line: 59,
      rationale:
        "allPhaseConfigs feeds only the unused _phaseConfig const, so every phaseConfigs$ write re-rendered every card for nothing; the DnDProvider overlay copies have no ancestor subscribed to phaseConfigs$. phaseConfigs$ is a plain observable persisted by an eager syncObservable, so no load waits on this subscription.",
      source: "use$(phaseConfigs$)",
    },
  ],
  commit: "4b383b6a05b1e82ef35d3bc268a33bb2231f2895",
  parent: "2db0828de8926292789df175dcbf35002537b41c",
  repository: "zenborg",
  root: "src",
} as const satisfies ReplayCommit;

/** The zenborg maintainer's drag-performance commit that drops an unread subscription, classified against its parent tree. */
export const zenborgReplayCommits: readonly ReplayCommit[] = [unusedPhaseConfigs];
