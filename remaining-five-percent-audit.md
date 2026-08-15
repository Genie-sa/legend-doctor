# Remaining 5% Audit

This file records evidence, decisions, measurements, and rejected approaches for the two-goal closeout.

## System baseline

- Production analyzer: 31 TypeScript modules, 12,094 lines before this closeout's untracked flow module is counted by Git.
- Largest orchestration module: `src/analyze-source.ts` at 3,063 lines; rule families are already separated under `src/rules/`.
- Full real-app scan: 6,070 hooks across 11 app roots: 3,594 `useState`, 2,476 `useEffect`, 76 Legend practice findings.
- Pinned scored corpus after closeout: 2,151 hooks across 197 focused targets and 726 manual labels.
- Final quality: 100% actionable precision (369/369), 95.8% actionable recall (369/385), 13/13 state groups, 76/76 Legend practices.
- Validation: 402/402 tests under strict TypeScript settings.

## Goal 1 findings

The shared analysis foundation is complete enough to stop architectural patching:

- `AnalysisProject` owns one canonical `AnalysisFile` and AST per supported source snapshot.
- The source index and both detector families consume the cached AST; string APIs remain compatibility wrappers.
- Parser recovery is reported at file and function granularity. Recovered regions never claim complete detector coverage.
- Coverage inventories every discovered supported file and 1,608 runtime functions in this repository; omitted targets are rejected.
- The semantic context is opt-in per explicit tsconfig shard, keeps cached AST identity, accepts transitive imports, rejects foreign AST nodes, and fails closed for unowned files.
- Bounded state-flow coverage is now observable per file and runtime function as complete, unknown, or not requested; unsupported control flow no longer disappears behind a generic “lowering skipped” status.
- No parser replacement, public CFG, SSA, or general data-flow layer was added.

## Full-app action inventory

| App | Hooks | `useState` | `useEffect` | Practices |
| --- | ---: | ---: | ---: | ---: |
| Tree Map | 652 | 547 | 105 | 0 |
| Tree Wallet | 217 | 135 | 82 | 0 |
| Memoria src | 269 | 158 | 111 | 24 |
| Memoria app | 13 | 1 | 12 | 0 |
| Legend Music | 51 | 32 | 19 | 44 |
| Excalidraw | 183 | 80 | 103 | 0 |
| Expensify | 2,952 | 1,498 | 1,454 | 0 |
| Formbricks | 1,086 | 817 | 269 | 0 |
| Outline | 618 | 326 | 292 | 0 |
| Genie Courses | 29 | 0 | 29 | 5 |
| Open WebUI RN | 0 | 0 | 0 | 3 |

Across full apps the tool emits 406 `use-observable`, 15 `move-state-down`, 62 `use-ref`, 96 `use-unmount`, 38 `use-mount`, six `use-observe-effect`, and 2,768/1,245 conservative state/effect reviews.

## Remaining 21 labeled opportunities

The misses do not form one last universal rule:

| Family | Labels | Independent shapes | Decision |
| --- | ---: | ---: | --- |
| Keyed/derived selection models | 3 | 2 apps | Defer; existing keyed proof is already specialized and these need broader summary/payload contracts. |
| Legend Music multi-surface state machines | 6 | 4 runtime clusters | Defer; alternate platform branches and async finalizers require whole-cluster ownership proof. |
| Strict subtree ownership | 2 | 2 | Defer; parent reset/unmount correlation and throttled effect ownership are different proofs. |
| Async/controlled leaf edges | 4 | 4 | Defer; transition callback provenance, companion writes, and conditional lifetime differ. |
| Effect keep classification | 4 | 4 | Defer; no five-case actionable family and React timing already remains safe under review. |
| One-hop observable mirror | 1 | 1 | Defer; requires cross-file hook summary, not a name heuristic. |
| Cohesive leaf keep | 1 | 1 | Deliberate abstention boundary. |

This is the stop signal: closing all 21 now would require at least six unrelated proof families. That would optimize the score, not the product.

## Final `useEffect` cohort audit

The last broad review cohort contained eight effects whose callback is passed by identifier instead of written inline. Five resolve locally and three are imported. The cases split across async state loading, imperative map geometry, shared navigation cleanup, notification lifecycle work, and committed-ref layout reporting.

Five representative effects are now pinned in the real-world corpus. Two would gain a more precise `keep-effect`, but that is non-actionable classification value and only four cases fit the proposed immutable-local-binding proof. The detector was therefore reverted under the five-example/high-value gate. Async work, imports, aliases, mutable bindings, function declarations, and lookalike hooks remain review without adding marginal machinery.

## Goal 2 selected proof

Keep one bounded synchronous co-write proof because it replaces duplicated branch reasoning in four detector consumers and has cross-app impact. It must remain structural and fail closed for unsupported control flow; no symbolic predicate engine.

Current intended full-app action deltas versus `main`:

- Expensify: one `review-state` → `use-observable` (`startPermissionsFlow`).
- Formbricks: two `review-state` → grouped `use-observable` (`selectedSurveyId`, `generatedUrl`).
- Other nine app roots: zero action changes.

Exact per-app phase impact:

| App root | Goal 1: cached analysis/coverage | Goal 2: co-write proof | Closeout hardening/final rule set |
| --- | ---: | ---: | ---: |
| Tree Map | 0 | 0 | 0 |
| Tree Wallet | 0 | 0 | 0 |
| Memoria src | 0 | 0 | 0 |
| Memoria app | 0 | 0 | 0 |
| Legend Music | 0 | 0 | 0 |
| Excalidraw | 0 | 0 | 0 |
| Expensify | 0 | +1 `use-observable` | 0 |
| Formbricks | 0 | +2 grouped `use-observable` | 0 |
| Outline | 0 | 0 | 0 |
| Genie Courses | 0 | 0 | 0 |
| Open WebUI RN | 0 | 0 | 0 |

Cold full-app timing showed no measurable regression: Tree Map 2.08s current vs 2.06s `main`; Formbricks 4.38s vs 4.38s; Expensify 9.84s vs 9.75s (single-process noise, not a benchmark claim).

Adversarial gaps found and fixed at the shared boundary: conditional/outside control mismatch, switch fallthrough, constant `&&`/`||`/`??`, generator suspension, correlated guards, and a shared branch made unreachable by an earlier terminating guard.

## Final verification

- TypeScript: pass under strict project settings.
- Unit tests: 402/402.
- Pinned eval: 2,151 hooks, 705/726 labels, 21 declared misses, 13/13 groups, 76/76 practices.
- Hook quality: 100% actionable precision (369/369), 95.8% actionable recall (369/385).
- `use-observable`: 100% precision (310/310), 96.0% recall (310/323).
- State-flow correctness and coverage hardening changed zero findings across all eleven full apps.
- The named-effect experiment was reverted after review; all eleven full-app finding sets remain identical to the accepted baseline.

The work stops here by design. The next improvement should begin only when a new structural family has repeated cross-app evidence; the 21 current misses are not one unfinished rule.
