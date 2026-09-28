# Unseen-app pins — September 28, 2026

Corpus change: three public Legend State applications from the
[unoptimized-app audit](research/unoptimized-legend-apps-2026-09-28.md) are pinned with every `change` finding labeled,
so the false positives it found fail forever once fixed. No detector changed.

| Repository             | Commit     | Target root    | License    | Legend State (lockfile) | Renderer                     |
| ---------------------- | ---------- | -------------- | ---------- | ----------------------- | ---------------------------- |
| `gptme/gptme`          | `f7bb3487` | `webui/src`    | MIT        | `3.0.0-beta.30`         | React DOM 18.3, `createRoot` |
| `equanimitech/zenborg` | `523af6cf` | `src`          | MIT        | `3.0.0-beta.35`         | React 19, Next.js            |
| `skastr0/junto`        | `f30adbb9` | `src/renderer` | Apache-2.0 | `3.0.0-beta.47`         | React 19, Electron           |

Each target is its whole scan root. Junto's is the largest (2,181 files in the whole-app budget scan, 659 hooks) and
scores in about 5 seconds, so no focused targets were needed.

## Labels

Every hook and practice `change` finding on each target is labeled, as are all `style` practices, which fail unlabeled.
Labels were written against `origin/main` at `c478731`.

| Application | Enforced hook actions | Enforced keep/review | Known false-positive hooks | Non-enforced opportunities | Practice `change` | Practice `style` | Known false-positive practices | Research misses |
| ----------- | --------------------: | -------------------: | -------------------------: | -------------------------: | ----------------: | ---------------: | -----------------------------: | --------------: |
| gptme       |                    24 |                    3 |                          8 |                          2 |                 3 |               16 |                              1 |               7 |
| zenborg     |                    10 |                    3 |                          6 |                          1 |                 9 |              115 |                              0 |               4 |
| junto       |                    34 |                    0 |                          9 |                          8 |                 3 |              362 |                              3 |               6 |

Research misses are unscored, like `evals/research/helper-tracking.json`: `evals/research/<app>-misses.json` holds
the audited Legend `Memo`, per-token subscription, row-selector, and stale-memo misses that have no hook to label.

## Known false positives

A known false positive keeps the run green while the fix is pending, and still counts against precision:

- **Hook:** the label records the action the tool should give, with `enforced: false` and a rationale that starts with
  `Known false positive (<class>)`. The fix makes it enforced.
- **Practice:** the label records the emitted action with `enforced: false`. It stops the finding from failing as
  unlabeled, never counts as a match, and the runner prints `Known false-positive Legend practices still emitted: x/y`.
  Once a fix removes the finding, the runner names the label to delete. After deletion, the missing label asserts
  absence: a later `change` or `style` finding there fails. A label with a `disposition` names the correct disposition
  instead, and the runner asks for it to be enforced once the tool emits that one.

| Class                                  | Labels                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaf is the owner                      | gptme `DeleteConversationConfirmationDialog.tsx:35`, `:36`, `:37`, `ExamplesSection.tsx:50`, `TabbedCodeBlock.tsx:28`, `workspace/MarkdownPreviewTabs.tsx:15`; zenborg `AreaColumnSubtoolbar.tsx:27`, `HabitFormDialog.tsx:744`, `PlaceFormDialog.tsx:474`, `:622`; junto `InspectorFields.tsx:298`, `gallery/ActivityMarkGallery.tsx:372`, `:373`, `rts/KindSurface.tsx:241`, `:242`, `rules/ChecksEditor.tsx:83`, `:84` |
| Owner renders anyway                   | zenborg `CircularPhaseSlider.tsx:68`; junto `peek-unrendered-use-value` at `rts/OverseerToggle.tsx:21`, `rts/RtsBottomBar.tsx:993`, `terminal/SeatCollaborationBlock.tsx:57` (style, emitted as change)                                                                                                                                                                                                                   |
| Atomic split after await               | gptme `TaskCreationDialog.tsx:44`; zenborg `SettingsModal.tsx:131`; junto `settings/ProvidersSettingsSection.tsx:36`, `work/WorkSurfaces.tsx:485` (the companion state clears in a later `finally` microtask)                                                                                                                                                                                                             |
| Whole-object consumers                 | gptme `contexts/SettingsContext.tsx:122`                                                                                                                                                                                                                                                                                                                                                                                  |
| `use-value-for-render-read`, not stale | gptme `stores/tasks.ts:79` (`showArchived$` is never written)                                                                                                                                                                                                                                                                                                                                                             |

## Fixed on main before pinning

Several audited false positives no longer reproduce, and their locations are labeled with today's output:

- The 25 gptme `batch-observable-writes` and `assign-observable-fields` findings are candidates since #65 proved the
  `createRoot` call sites concurrent. Unlabeled, any regression to `change` fails.
- gptme `MainLayout.tsx:376` (`use-value-for-render-read`) is no longer emitted.
- The five dead-component states, gptme `ui/carousel.tsx:52`, `:53` and zenborg `PlanAreaCard.tsx:65`, `:66`,
  `PlanHabitItem.tsx:35`, receive `keep-state` since #69 and are enforced.
- junto `rts/CompletedTaskNotify.tsx:28` is a review; its label keeps `keep-effect`, non-enforced.

## Audit verdicts revised

The [split-commit audit](audit-2026-09-28-split-commits.md) runtime table settles the atomic-split class. Writes in one
stretch after an `await` commit once on React 19. A companion written by a later `then` or `finally` splits.

- junto `work/TaskOperatorPanel.tsx:176`, `:177` and `settings/CompanionSettingsSection.tsx:220` clear every co-written
  state in one stretch, so they stay enforced `use-observable` labels.
- junto `work/WorkSurfaces.tsx:479`, `:480`, `:482` and `settings/NotificationSettingsSection.tsx:81`, `:82` are reviewed
  since #73. Their companion writes follow their own awaited call (`refreshList` at line 516, `readDelivery` at line 89)
  and already commit apart. The conversion adds no split, so they are non-enforced `use-observable` opportunities.
- gptme runs React DOM 18, which splits even one stretch. `settings/ServerApiKeySettings.tsx:39` clears the draft and
  `isSaving` together, so it is an enforced `review-state`. `SetupWizard.tsx:163` is non-enforced because the `step`
  co-write the analyzer names is not established.

Two gptme `use-computed-for-parent-reads` changes from #67 are enforced. At `ChatMessage.tsx:578`, the TTS button closes
over `isSpeakingThis` from `useSyncExternalStore`. At `ConversationContent.tsx:1057`, the fork lookup closes over
`absoluteIndex` in rows keyed by virtual index.

## Scan budgets

CI run 36444683516 measured the whole-app scans at gptme 3.9s, zenborg 3.7s, and junto 13.6s. Those are the
baselines in `evals/performance-budgets.ts`; three times each stays under the 60 second floor.
