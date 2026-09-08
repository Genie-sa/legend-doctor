import type { AbstentionReason, HookFinding, ReviewGuidance } from "../core/types.js";

const NEXT_CHECK = {
  "async-command-origin-unresolved":
    "Trace every pending command to its invocation, including component wrappers. Prove event-only execution while preserving the async interval.",
  "atomic-transition-unproven":
    "Inspect every companion write, branch, await, and exception path. Establish which cells must publish together and where batch boundaries belong.",
  "binding-shape-unsupported":
    "Inspect the hook result binding and its consumers. This binding shape is not modeled; add a structural binding proof before recommending an edit.",
  "callback-timing-unresolved":
    "Inspect deferred reads and registrations. Establish whether each read needs a render snapshot, a command-entry snapshot, or the current value.",
  "child-contract-unresolved":
    "Load and inspect the receiving component and every forwarding wrapper. Identify its render reads, effects, callback captures, and prop identity requirements.",
  "effect-callback-unresolved":
    "Resolve the effect callback declaration and its captured inputs before analyzing its lifecycle.",
  "effect-causal-owner-unresolved":
    "Identify the event or external lifecycle that owns this effect. Preserve its scheduling until the replacement has a causal and timing proof.",
  "effect-write-ownership-unresolved":
    "Inspect the effect's reads, dependencies, writes, and cleanup. Prove which write targets can move without changing its schedule.",
  "lifecycle-equivalence-unproven":
    "Check mount, replay, dependency changes, and cleanup. Establish the intended lifecycle before choosing a Legend hook.",
  "mount-identity-unproven":
    "Trace keys, conditional returns, and repeated children. Keep state ownership and the same child mount identity when introducing a subscriber.",
  "no-proven-optimization":
    "Measure owner renders and locate an independent leaf or lifecycle cost. There is no demonstrated optimization to apply yet.",
  "ownership-flow-unresolved":
    "Follow escaped values and setters into hooks, objects, spreads, and callbacks. Include the missing source and prove every consumer's timing and ownership.",
  "paired-draft-effect-preserved":
    "Resolve the paired state migration first. Preserve this synchronization effect's dependency timing and change only the agreed write targets.",
  "react-commit-sensitive":
    "Inspect transition, layout, imperative-handle, and commit-sensitive consumers. Preserve React scheduling until equivalence is proven.",
  "render-cut-unproven":
    "Identify all direct and transitive render consumers, including mutable reads refreshed by the owner. Prove a smaller subscription removes an owner render.",
  "state-type-unresolved":
    "Resolve whether the state can hold a callable value. Preserve lazy initialization and function-value semantics before changing ownership.",
} as const satisfies Readonly<Record<AbstentionReason, string>>;

function kindFor(finding: HookFinding, reason: AbstentionReason): ReviewGuidance["kind"] {
  const status = finding.assumption?.status;
  if (status === "rejected") {
    return "declined";
  }
  if (status === "stale") {
    return "recheck";
  }
  if (status === "open") {
    return "confirm";
  }
  if (finding.waitsOn?.length) {
    return "dependency";
  }
  return fallbackKind(reason);
}

function fallbackKind(reason: AbstentionReason): ReviewGuidance["kind"] {
  if (
    reason === "binding-shape-unsupported" ||
    reason === "effect-callback-unresolved" ||
    reason === "state-type-unresolved"
  ) {
    return "unsupported";
  }
  return reason === "no-proven-optimization" ? "no-proven-benefit" : "investigate";
}

function nextFor(
  finding: HookFinding,
  kind: ReviewGuidance["kind"],
  reason: AbstentionReason,
): string {
  if (kind === "declined") {
    return "The recorded answer rejected this conversion. Preserve the current behavior; revisit only with new evidence or an intentional design change.";
  }
  if (kind === "dependency") {
    return "Resolve the question ids in waitsOn, then rescan this effect with those answers.";
  }
  return finding.assumption?.question ?? NEXT_CHECK[reason];
}

/** Add triage detail after assumptions and dependent effects have resolved. Actions stay unchanged. */
export function withReviewGuidance(finding: HookFinding): HookFinding {
  if (finding.action !== "review-state" && finding.action !== "review-effect") {
    return finding;
  }
  const reason = finding.abstentionReason;
  const kind = kindFor(finding, reason);
  const memberBlockers =
    finding.assumption?.members?.flatMap((member) =>
      member.nextBlocker ? [member.nextBlocker] : [],
    ) ?? [];
  return {
    ...finding,
    review: {
      blockers: [...new Set([reason, ...(finding.assumption?.facts ?? []), ...memberBlockers])],
      kind,
      next: nextFor(finding, kind, reason),
    },
  };
}
