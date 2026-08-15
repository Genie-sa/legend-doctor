# Remaining 5% Audit

This file records evidence, decisions, measurements, and rejected approaches for the two-goal closeout.

## System baseline

- Production analyzer: 32 TypeScript modules and 12,770 lines.
- Largest orchestration module: `src/analyze-source.ts` at 3,087 lines; rule families are separated under `src/rules/`.
- Full real-app scan: 6,147 hooks across 12 app roots: 3,647 `useState`, 2,500 `useEffect`, 77 Legend practice findings.
- Pinned scored corpus after closeout: 2,233 hooks across 199 focused targets and 744 manual labels.
- Final quality: 100% actionable precision (369/369), 93.9% actionable recall (369/393), 13/13 state groups, 77/77 Legend practices.
- Validation: 420/420 tests under strict TypeScript settings.

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
| Hoalu | 77 | 53 | 24 | 1 |

Across full apps the tool emits 401 `use-observable`, 16 `move-state-down`, 57 `use-ref`, 97 `use-unmount`, 40 `use-mount`, six `use-observe-effect`, and 2,830/1,256 conservative state/effect reviews. The safety closeout also removed the only automatic `move-to-event` recommendation.

## Opportunity-only audit: 21 labeled opportunities

The misses do not form one last universal rule:

| Family | Labels | Independent shapes | Decision |
| --- | ---: | ---: | --- |
| Keyed/derived selection models | 3 | 1 app root | Defer; existing keyed proof is already specialized and these need broader summary/payload contracts. |
| Legend Music multi-surface state machines | 6 | 4 runtime clusters | Defer; alternate platform branches and async finalizers require whole-cluster ownership proof. |
| Strict subtree ownership | 2 | 2 | Defer; parent reset/unmount correlation and throttled effect ownership are different proofs. |
| Async/controlled leaf edges | 4 | 4 | Defer; transition callback provenance, companion writes, and conditional lifetime differ. |
| Effect keep classification | 4 | 4 | Defer; no five-case actionable family and React timing already remains safe under review. |
| One-hop observable mirror | 1 | 1 | Defer; requires cross-file hook summary, not a name heuristic. |
| Cohesive leaf keep | 1 | 1 | Deliberate abstention boundary. |

This is the stop signal: closing all 21 now would require at least six unrelated proof families. That would optimize the score, not the product.

The later safety closeout added eight declared misses rather than weakening the eval: three manually verified Expensify modal opportunities whose callback provenance is not locally proven, one Tree Map event-reset opportunity behind a custom component contract, and four Formbricks leaf opportunities in owners that also use React transitions. The current corpus therefore has 29 non-enforced opportunities.

## Final `useEffect` cohort audit

The last broad review cohort contained eight effects whose callback is passed by identifier instead of written inline. Five resolve locally and three are imported. The cases split across async state loading, imperative map geometry, shared navigation cleanup, notification lifecycle work, and committed-ref layout reporting.

Five representative effects are now pinned in the real-world corpus. Two would gain a more precise `keep-effect`, but that is non-actionable classification value and only four cases fit the proposed immutable-local-binding proof. The detector was therefore reverted under the five-example/high-value gate. Async work, imports, aliases, mutable bindings, function declarations, and lookalike hooks remain review without adding marginal machinery.

## Earlier architecture Goal 2 selected proof

The earlier architecture closeout kept one bounded synchronous co-write proof because it replaced duplicated branch reasoning in four detector consumers and had cross-app impact. It remained structural and failed closed for unsupported control flow; no symbolic predicate engine was added.

Earlier accepted Goal 2 action deltas versus the then-current `main`:

- Expensify: one `review-state` → `use-observable` (`startPermissionsFlow`).
- Formbricks: two `review-state` → grouped `use-observable` (`selectedSurveyId`, `generatedUrl`).
- Other nine app roots: zero action changes.

Exact per-app phase impact:

| App root | Goal 1: cached analysis/coverage | Goal 2: co-write proof | Closeout hardening/final rule set |
| --- | ---: | ---: | ---: |
| Tree Map | 0 | 0 | -2 automatic actions |
| Tree Wallet | 0 | 0 | 0 |
| Memoria src | 0 | 0 | 0 |
| Memoria app | 0 | 0 | 0 |
| Legend Music | 0 | 0 | 0 |
| Excalidraw | 0 | 0 | 0 |
| Expensify | 0 | +1 `use-observable` | -9 automatic actions |
| Formbricks | 0 | +2 grouped `use-observable` | -4 automatic actions |
| Outline | 0 | 0 | -1 automatic action |
| Genie Courses | 0 | 0 | 0 |
| Open WebUI RN | 0 | 0 | 0 |

Cold full-app timing showed no measurable regression: Tree Map 2.08s current vs 2.06s `main`; Formbricks 4.38s vs 4.38s; Expensify 9.84s vs 9.75s (single-process noise, not a benchmark claim).

Adversarial gaps found and fixed at the shared boundary: conditional/outside control mismatch, switch fallthrough, constant `&&`/`||`/`??`, generator suspension, correlated guards, and a shared branch made unreachable by an earlier terminating guard.

## Final verification

- TypeScript: pass under strict project settings.
- Unit tests: 420/420.
- Pinned eval: 2,233 hooks, 715/744 labels, 29 declared misses, 13/13 groups, 77/77 practices.
- Hook quality: 100% actionable precision (369/369), 93.9% actionable recall (369/393).
- `use-observable`: 100% precision (307/307), 93.9% recall (307/327).
- Bounded state-flow correctness changed zero findings. Final React commit, callback-contract, and atomicity hardening demoted sixteen uncertain automatic actions to review.
- Before that safety closeout, reverting the named-effect experiment restored all eleven finding sets to their accepted baseline.

Hook opportunity expansion stops here by design. A new hook rule should begin only when a structural family has repeated cross-app evidence; the 29 current misses are not one unfinished rule.

## Legend-native continuation

Hoalu added 77 hooks and one proven transaction to the corpus without creating a new hook miss. Its queue code also exposed a general rewrite-safety bug: replacing a cloned `.set()` with direct mutation can change the identity and contents observed through a snapshot alias that is read afterward.

The narrow-write rule now abstains whenever that old snapshot remains observable after the write, including later reads, aliases, and nested-function captures. Hoalu's unsafe recommendation disappeared (two practice findings became one), while hook output stayed unchanged. The other eleven app roots had zero hook or practice action changes. This is the intended continuation after hook expansion: improve Legend advice only when the transformation itself is proven equivalent.

## Two-goal product re-audit

The final product pass started from all 2,768 full-app `review-state` findings. Of those, 2,760 exposed parseable evidence suitable for automated stratification.

### Goal 1: find one repeated, valuable family

The most common exact signature was zero local render reads, zero effect reads, zero deferred reads, one value transport, one or two setter calls, and zero effect writes. It produced 136 cases across seven app roots:

| App root | Cases |
| --- | ---: |
| Expensify | 82 |
| Formbricks | 20 |
| Tree Map | 13 |
| Outline | 9 |
| Memoria src | 7 |
| Excalidraw | 4 |
| Tree Wallet | 1 |

Evidence counts were only a candidate generator. A manual audit covered 25 representative cases across five apps and found 10 positive state rows, representing nine migration units. They separated into three different proofs:

- Async pending state rendered by one leaf: four positives across two apps.
- Modal or payload state that must migrate as an atomic model: three units across three apps.
- Hot producer state rendered by one leaf: two units across two apps.

None reaches the acceptance gate of five equivalent positives across three apps. The negative cases depend on owner-level derivation, companion writes, mount identity, form adapters, route invalidation, mutation lifecycle, or already-cohesive leaf ownership.

Two controlled relaxations tested whether the gap was merely conservative thresholds:

1. Lowering the literal-boolean leaf threshold changed only three Expensify findings. Two owners were already tiny boundaries, so the change did not prove meaningful work removal. It was reverted.
2. A sole-child pass-through proof first changed 34 findings, then eight after strict lifetime and ownership gates. A real Expensify counterexample still performed substantial hooks and memoized work above its only child. `keep-state` would hide a possible render cut, while `move-state-down` would overreach the child contract. It was reverted.

There is a repeatable sole-child `keep-state` classification cohort, but it is deliberately not automated: it offers no optimization, and the number of returned JSX elements does not prove that the owner has no expensive work.

### Goal 2: ship only a proof that clears the gate

No new opportunity detector shipped. The only new detector is a conservative React commit-sensitivity boundary that turns uncertain actions into explicit reviews. This is the measured result, not an incomplete implementation.

- The named-effect cohort contained eight cases. Five resolved locally, four fit one proof, and only two improved a non-actionable `keep-effect` classification. The experiment was reverted.
- The remaining 21 labels contain 16 actionable opportunities split across at least five proof families. Closing them now would require broader flow, cross-file ownership, lifecycle, or atomicity analysis.
- All 420 tests pass after reverting the experiments and completing the safety closeout.
- At the end of the opportunity-only re-audit, the pinned eval remained 2,151 hooks, 705/726 labels, 21 declared misses, 13/13 groups, and 76/76 Legend practices. The later safety closeout produced 701/730 with 29 explicit misses; the subsequent Hoalu expansion produced the current 715/744 result without adding a miss.

Exact app impact from the opportunity-only re-audit:

| App root | Hook action delta | Practice delta |
| --- | ---: | ---: |
| Tree Map | 0 | 0 |
| Tree Wallet | 0 | 0 |
| Memoria src | 0 | 0 |
| Memoria app | 0 | 0 |
| Legend Music | 0 | 0 |
| Excalidraw | 0 | 0 |
| Expensify | 0 | 0 |
| Formbricks | 0 | 0 |
| Outline | 0 | 0 |
| Genie Courses | 0 | 0 |
| Open WebUI RN | 0 | 0 |

The correct product conclusion is narrow: no examined **high-value actionable** hook family clears the five-case, three-app, structural-proof gate. Hook detection is therefore at its practical optimum under the current proof model. The next higher-value research lane is Legend-native code quality—narrow `useValue` subscriptions, correct `get()` versus `peek()`, direct child writes, and safe batching—while retaining the same cross-app evidence and precision requirements.

## Safety closeout

The final adversarial pass corrected sixteen automatic recommendations that lacked a complete React-semantics proof:

- Tree Map: one owner-scoped image preview with a companion React-state transaction and one reset effect behind an opaque custom callback now remain review.
- Expensify: nine states involving fresh callback refs, repeated focus management, transition/commit cadence, or opaque deferred callback ownership now remain review.
- Formbricks: four otherwise valid leaf opportunities now remain review because their owners also use React transitions and the analyzer intentionally avoids a partial transition call graph.
- Outline: one input focus state now remains review because its owner creates merged callback refs.
- The other seven app roots changed zero hook actions. All eleven app roots changed zero Legend practice actions.

The shared rules now fail closed when an optimization could change any of these boundaries:

- atomic companion React-state writes;
- `startTransition` / `useTransition` priority;
- every-commit effects and fresh callback-ref lifecycles;
- collection callbacks on an unproven or shadowed array type;
- parser-recovered file facts;
- opaque JSX option or registrar callbacks.

This was a safety phase, not a recall phase. It added no app, component, or state-name matcher. The commit-sensitive proof is isolated in `src/rules/react-commit-sensitivity.ts` so the main analyzer remains orchestration rather than another rule bucket.

## Lifecycle callback closeout

The final run extended the same commit boundary across proven React `useEffect`, `useLayoutEffect`, and
`useInsertionEffect` callbacks. It resolves namespace calls, imported aliases, named functions, immutable aliases, and
`useCallback` bindings while ignoring local lookalikes.

Compared with the preceding private release, the 12 full app roots changed 16 hook actions and zero Legend practice
actions:

- Nine command-only states moved from review to `use-ref`; their lifecycle hook and dependency timing remain React-owned.
- Seven commit-sensitive states moved from `keep-state` to explicit review because their render ownership is not proven.
- Excalidraw changed one action, Expensify eight, Formbricks one, and Outline six. The other eight roots changed zero.

The scored corpus remains 2,233 hooks, 715/744 labels, 29 declared misses, 13/13 groups, and 77/77 practices. Actionable
precision remains 100% (369/369), actionable recall 93.9% (369/393), and `use-ref` is 9/9 for both precision and recall.
