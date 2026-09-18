# Outline pending-command diagnostic audit

Pin: `bae9790355385b2b2987123eeb3978c6c06e6ed6`.
Target: `outline-document-copy`, `app/components/DocumentExplorer/DocumentCopy.tsx:27`.

The earlier `callback-timing-unresolved` expectation was incorrect. That diagnostic asks whether deferred reads may replace captured render snapshots with current observable values. `copying` has no such reads: its only reads are the Button's disabled expression and conditional label at lines 112–113. Its writes are `setCopying(true)` at 50 and the `finally` reset at 64. The default parameter at 43 reads a different state, `selectedPath`; neither that parameter nor the async body reads `copying`.

The command reaches `DocumentExplorer.onSubmit` at 72 and `Button.onClick` through an adapter at 112. The pinned Explorer invokes `onSubmit` through `submitNode` (262) and keyboard Enter (399). Those source paths support the opportunity, but a complete structural event-origin proof must also resolve every forwarding and registration boundary. Merely observing a callback name or a valid true/false interval does not establish this. The existing `async-command-origin-unresolved` diagnostic accurately asks for the missing evidence. The label remains `enforced: false`, with desired action `use-observable`; no automatic migration or detector proof is broadened.

## Regression risks

| Risk | Protected contract                                                         | Trigger and independent oracle                                                                                                                                           | Evidence                                       |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| O1   | Do not invent deferred reads of the pending flag                           | An async command defaults another value, writes the pending flag, and has two JSX origins. The review must ask about both invocation origins, not `peek()` or snapshots. | `async-origin-diagnostics.test.ts`, first test |
| O2   | Retain snapshot review when the flag really is read by a deferred callback | An opaque hook callback reads pending after a setter. The review must identify the captured pending value rather than claim only command origins are missing.            | Same file, second test                         |
| O3   | A stale non-enforced diagnostic label still fails scoring                  | The exact pinned Outline corpus fails before the label correction and passes afterward, with unchanged analyzer actions.                                                 | Isolated partial-corpus run                    |

No implementation changed. The focused tests distinguish the two diagnostic contracts; the corpus failure is the red case for the corrected gold label. Native timing and a new event-origin proof are outside this diagnostic-label correction.

## Validation

- A separate TypeScript output directory compiled successfully without replacing the shared build.
- Both new regressions and the existing review-guidance tests passed (nine tests).
- Changing only the isolated compiled origin diagnostic to the old snapshot diagnostic made the first regression fail; the compiled file was restored immediately.
- The pinned Outline partial corpus exited 1 before the label correction, solely for this diagnostic mismatch, and exited 0 afterward. Labeled actionable precision/recall stayed 22/22 and 22/26; the opportunity remains unimplemented and non-enforced.
- Doctor scans before and after produced identical hook actions and abstention reasons. Full seven-app verification belongs to the combined phase; this label/test-only correction changes no detector output.
