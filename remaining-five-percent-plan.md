# Remaining 5%: Two-Goal Plan

## Outcome

Finish the current analyzer phase without case-by-case patches:

1. Make the analysis foundation honest, shared, and measurable.
2. Close only high-value detection gaps backed by repeated real-world evidence.

## Goal 1 — Trustworthy analysis foundation

- [x] Establish a clean baseline: architecture, changed files, tests, evals, runtime, and output deltas.
- [x] Finish `AnalysisProject` / cached `AnalysisFile` integration.
- [x] Make diagnostics, coverage, and semantic ownership fail closed.
- [x] Remove or reject scaffolding that does not earn its complexity.
- [x] Prove default detector outputs remain stable unless a change is explicitly labeled and audited.

Exit criteria:

- Every discovered supported file and runtime function has an honest coverage outcome.
- Cached AST identity is shared by the source index and both detector families.
- Recovered or unsupported analysis never claims full proof.
- Semantic facts are available only for Program-owned nodes.
- Full tests and pinned eval pass; exact per-app impact is reported.

## Goal 2 — General, high-value detection closure

- [x] Inventory all remaining labeled misses and review cohorts by structural reason.
- [x] Rank families by frequency, safety, performance value, and implementation cost.
- [x] Implement at most two shared proofs; require repeated evidence across independent apps.
- [x] Add positive, near-negative, and adversarial fixtures before enabling each proof.
- [x] Simplify the final diff and document the intentional remaining misses.

Exit criteria:

- No rule is justified by a filename, component name, state name, or single app.
- Each enabled proof has at least five equivalent real examples or a stronger semantic invariant.
- Actionable precision remains 100% on enforced labels.
- Recall improvement and exact per-app deltas are reported.
- Remaining misses are categorized as deliberate limits, not an open-ended backlog.

## Stop conditions

- Do not add a proof that needs a general data-flow subsystem for fewer than five equivalent wins.
- Do not use owner line count, state names, prop names, or app allowlists as correctness evidence.
- Do not change React effect timing, cleanup, mount identity, transaction atomicity, or async snapshot semantics.
- Do not optimize a leaf that already owns the full semantic update boundary.

## Status

Both goals complete. One shared synchronous co-write proof survived the evidence gate; the remaining low-frequency edge families are documented and intentionally deferred.

## Errors encountered

- The first state-flow fixture patch referenced helper names from a scratch harness instead of this repository's `functionAndCalls` helper. TypeScript rejected the tests before execution; the fixtures were corrected to reuse the existing helper.
