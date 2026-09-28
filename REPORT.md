# Report reference

Field-level detail for the JSON report. Read [README.md](README.md) first.

Version-gate consumers with `schemaVersion`, currently `4`.

Grouped state findings may also include additive `transitions` evidence. `writes` lists direct
setter calls with state names, line/column positions, handler identities, and enclosing control
contexts. `relations` refers to zero-based write indices in the same handler. `coexecution: proven`
means a shared synchronous path exists; it does **not** mean all executions are one atomic update.
`disproven` includes separate suspension phases and mutually exclusive/unreachable paths; `unknown`
retains an explicit proof gap. No relation is inferred between different handlers.

Only `fusion: adjacent-literals` identifies adjacent replacements of distinct fields with literal
values that can form one `assign`. `preserve-source` means retain evaluation order, branches, and
exception/suspension boundaries; it does not authorize moving those expressions into an object
literal. Group reviews name unresolved pairs by exact source location. These are bounded source
facts, not a complete migration plan or new permission to convert a review finding. Transported
setters still depend on the existing child-contract proofs and are not listed as direct writes.

Schema 4 removes the unused `diagnostics.semantic` field. Coverage schema 2 reports only `parser`, `lowering`,
and `detector`: no detector consumed the former semantic stage. The experimental `createSemanticContext`,
`AnalysisContextOptions.configFilePath`, and semantic context types have been removed.

Important fields:

| Field          | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `status`       | `ok` or `error`                                                             |
| `root`         | Base directory for every finding path                                       |
| `analyzer`     | Tool `version` and compiled `build`                                         |
| `findings`     | React state and effect findings                                             |
| `practices`    | Legend State practice findings                                              |
| `hidden`       | Findings removed by filters                                                 |
| `capabilities` | Legend State version and exports, React Compiler status, and disabled rules |
| `scope`        | Active scope flag and loaded context file count                             |

Compare reports only when `analyzer.build` matches.

`capabilities.legendState` is `null` when no version is known. Otherwise, `source` says where the version came from:

| `source`    | Meaning                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `installed` | The nearest installed `@legendapp/state`; `useValueExport` and `syncExport` are read from its declarations and export map. |
| `lockfile`  | Nothing is installed, and the nearest lockfile pins exactly one version; its exports come from the published release.      |

A lockfile version newer than the verified releases reports `unknown` exports and gates no rule.

`capabilities.disabledRules` lists each rule the resolved toolchain switched off, with its `rule`, `reason`,
`detail`, and the number of analyzed `files` that skipped it. A disabled rule reports nothing, so a missing
finding is not a clean file.

| `disabledRules` reason     | Rules                                               | Meaning                                                                                                        |
| -------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `legend-v2-tracking`       | `plain-primitive-projection`, `observable-tracking` | `@legendapp/state` 2.x can auto-track render `get()` calls through an app-wide setting the analyzer cannot see |
| `react-compiler`           | `observable-clone-writes`                           | The React Compiler memoizes by reference, so in-place observable writes would leave memoized consumers stale   |
| `sync-export-missing`      | `browser-storage-persistence`                       | The resolved package has no `sync` entry point; storage-writing effects stay `keep-effect`                     |
| `use-value-export-missing` | `legacy-use-value`                                  | The resolved `@legendapp/state/react` entry point does not export `useValue`                                   |

Every `review-state` and `review-effect` finding has an `abstentionReason`. It names the main fact or safety rule that
blocked a proven edit.

| `abstentionReason`                  | Missing proof or preserved constraint                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `async-command-origin-unresolved`   | An async command's pending writes have a proven leaf boundary, but not an event-only origin        |
| `atomic-transition-unproven`        | Companion writes may need to publish together; which cells and batch boundaries is unproven        |
| `binding-shape-unsupported`         | The hook result is bound in a shape the analyzer does not model                                    |
| `callback-timing-unresolved`        | A deferred read may need a render snapshot, a command-entry snapshot, or the current value         |
| `child-contract-unresolved`         | A receiving component or forwarding wrapper has unproven render reads, effects, captures, or props |
| `effect-callback-unresolved`        | The effect callback declaration or its captured inputs cannot be resolved                          |
| `effect-causal-owner-unresolved`    | The event or external lifecycle that owns the effect is unknown, so its scheduling stays           |
| `effect-write-ownership-unresolved` | The effect's writes cannot be proven to move without changing its schedule                         |
| `lifecycle-equivalence-unproven`    | Mount, replay, dependency-change, or cleanup behavior may differ under a Legend hook               |
| `mount-identity-unproven`           | A new subscriber could change keys, conditional returns, or a child's mount identity               |
| `no-proven-optimization`            | No independent leaf or lifecycle cost is demonstrated, so no edit is proposed                      |
| `ownership-flow-unresolved`         | A value or setter escapes into hooks, objects, spreads, or callbacks the analyzer cannot follow    |
| `paired-draft-effect-preserved`     | A synchronization effect paired with a state migration keeps its dependency timing                 |
| `react-commit-sensitive`            | A transition, layout, imperative-handle, or other commit-sensitive consumer needs React scheduling |
| `render-cut-unproven`               | No smaller subscription is proven to remove an owner render                                        |
| `state-type-unresolved`             | The state may hold a callable value, so lazy initialization and function semantics are at risk     |

Every review also carries `review: { kind, blockers, next }`. This is additive guidance in schema 4;
the action and disposition remain authoritative. `blockers` combines the current reason, question facts,
and any group members' known next blockers. It is not an exhaustive list of every missing proof.

| `review.kind`       | Next step                                                                       |
| ------------------- | ------------------------------------------------------------------------------- |
| `confirm`           | Research and answer the attached open question.                                 |
| `recheck`           | Re-read changed source before renewing a stale answer.                          |
| `declined`          | Preserve the current behavior; the recorded answer rejected the conversion.     |
| `dependency`        | Resolve the question ids in `waitsOn`, then rescan.                             |
| `unsupported`       | Resolve a binding, callback, or callable-state shape the analyzer cannot model. |
| `no-proven-benefit` | Establish a render or lifecycle saving before proposing a migration.            |
| `investigate`       | Follow `review.next`; no supported yes/no answer currently yields an edit.      |

`async-command-origin-unresolved` means an async pending interval and leaf boundary are proven, but
the command's event origin is not. This differs from `callback-timing-unresolved`, which concerns
captured-value reads. Eligible direct JSX event references and inline adapters receive an event-origin
question; known direct render calls do not. Confirming it preserves the existing async command and
changes its pending writes and subscriber boundary. Old answers keyed to the former reason do not
silently confirm this new question.

Use an unfiltered scan to inventory all review kinds. `--actionable` still hides reviews without a
confirmable question; guidance does not override that filter or make a review actionable.

## Answer a review question

When one yes/no fact is all that blocks a `review-state` finding, the finding also carries an `assumption`:

| Field         | Meaning                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| `id`          | Stable across line shifts: report file, owner, state name, blocker                           |
| `question`    | The concrete fact to confirm, naming the states, targets, or read sites involved             |
| `facts`       | The blockers a "yes" assumes away; one, or two when a second blocker stands behind the first |
| `research`    | Distinct checks with `file`, first `line`, all `lines`, and the full source-site `total`     |
| `ifConfirmed` | The action a confirmed answer produces; the tool re-ran its proofs with that fact assumed    |
| `fingerprint` | Digest of the owner's source; an answer recorded for a different digest is reported `stale`  |
| `renderCost`  | JSX elements the owner renders per update of this state                                      |
| `updateSites` | Setter call sites; `renderCost × updateSites` is the `priority` used by `report.questions`   |
| `status`      | `open`, `confirmed`, `rejected`, or `stale`                                                  |

A question is asked only when the hypothetical run yields a conversion, so every "yes" has a concrete instruction.
`report.questions` lists the open ones by `rank`. A group reports the first converting member's action in
`ifConfirmed` and the number that convert in `convertingCount`; individual outcomes remain in `members`.
Repeated research instructions list every relevant line and a full site count, including multiple sites on one line. A step without `lines` or `total` describes one site at `line`.
Record answers in `<root>/.legend-doctor/confirmations.json`, which
every scan of that root reads, or in any file passed with `--confirm`:

```json
{
  "confirmations": [
    {
      "id": "src/panel.tsx::Panel::open::atomic-transition-unproven",
      "fingerprint": "8444a887430f",
      "answer": "yes",
      "note": "both writes sit in fail(); Drawer renders open directly (drawer.tsx:12)"
    },
    {
      "id": "src/panel.tsx::Panel::filter::render-cut-unproven",
      "fingerprint": "4f22f4aca655",
      "answer": "no"
    }
  ]
}
```

```bash
legend-doctor <root>
```

Or let the tool write the entry, fingerprint included, and report the scan that honours it in one command:

```bash
legend-doctor <root> --answer "src/panel.tsx::Panel::open::atomic-transition-unproven=yes" --note "both writes sit in fail()"
```

A `review-effect` finding can carry the same block: an empty-dependency setup effect asks whether `useMount`'s once-only
semantics are intended. An effect whose verdict waits on a React state instead lists that state's open question ids in
`waitsOn`, so the answer that settles the state settles the effect.

When assuming the first blocker away still leaves a review verdict, the tool assumes the next one too and asks both
facts in one question; the id then joins both reasons with `+`, and `facts` lists them in order. Two facts is the cap.

States a handler writes together share one question and one id, `file::Owner::{a,b}::atomic-transition-unproven`.
Its `members` list says what a "yes" does to each: members whose standalone proof already passes convert together under
one cluster instruction written with `assign`, and a member another blocker still holds is re-examined without the
co-write blocker and gets its next question on the same scan.

A confirmed individual question turns its finding into `ifConfirmed` with disposition `change`; a group converts only the members whose outcome is actionable. The answer is recorded in each converted finding's evidence. Such a finding also carries `verification`: the conversion rests on an answer rather than a proof, so the
recipe names the jsdom harness exported as `legend-doctor/runtime` (`mountDom`, `count`), the before/after comparison
to run, and the render-count and DOM expectations that must hold; a failed comparison means the answer was wrong. A rejected id keeps the review verdict and stops the question from being asked again. When the owner's code
changes, the fingerprint no longer matches: the answer is reported `stale`, not applied, and the question is asked
again. The report's `confirmations` block counts applied, rejected, and stale answers, names the file they came from,
and lists ids no finding produced.

Failures are also valid JSON. They include `status: "error"`, a stable `reason`, a useful `message`, and
sometimes a `next` command.

## Machine-applicable edits

A practice finding carries `edits` when syntax alone determines its instruction. The field is additive in schema 4
and absent otherwise; `message` describes the same change and stays authoritative.

| Field          | Meaning                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `file`         | The finding's `location.file`, relative to `root`                                            |
| `start`, `end` | 1-based `line` and `column` in UTF-16 code units; `end` is exclusive, equal positions insert |
| `newText`      | The replacement text                                                                         |

Positions refer to the scanned source. Collect the edits you intend to apply to one file, drop exact duplicates,
and apply them from the end of the file backwards, or rescan between findings. Edits never overlap. Each
finding's edits stand alone, and findings that share an import rewrite carry identical copies of it. Every
named-import `replace-legacy-use-value` finding in a file carries the whole file's migration, because renaming
the shared binding for one call would strand the others. Likewise, when a file's `use-computed-for-parent-reads`
findings cover every use of its `Memo` import, each carries every rename and the import swap.

| Edited action                   | Edit                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pass-observable-to-use-value`  | `useValue(() => x$.get())` or `useValue(x$.get())` becomes `useValue(x$)`                                                          |
| `use-peek-for-snapshot`         | `x$.get()` becomes `x$.peek()`                                                                                                     |
| `use-value-for-render-read`     | A direct render initializer `x$.get()` becomes `useValue(x$)`                                                                      |
| `narrow-use-value-subscription` | `const { a: b } = useValue(x$)` becomes `const b = useValue(x$.a)`                                                                 |
| `replace-legacy-use-value`      | Callees become `useValue`, a direct selector collapses, legacy specifiers leave the import                                         |
| `select-primitive-projection`   | `const v = useValue(x$)`, read only as `v === id`, becomes `useValue(() => x$.get() === id)`; the comparisons read the new binding |
| `use-computed-for-parent-reads` | `<Memo>` becomes `<Computed>`; `Computed` replaces the `Memo` specifier when no other `Memo` remains, and otherwise joins it       |

`use$`, `useSelector`, their aliases, and namespace calls from `@legendapp/state/react` are subscription hooks
like `useValue`. Messages and edits keep the callee the source calls, so `use$(x$.get())` becomes `use$(x$)` and
leaves the rename to `replace-legacy-use-value`; that finding's edits still compose because an in-place edit never
touches the callee. A new subscription uses the hook the file already imports, preferring `useValue`; when none is
imported, the edit adds `useValue` beside a retained `@legendapp/state/react` specifier, or `useSelector` when the
installed or locked Legend State exports no `useValue`. The field is omitted when the edit would drop a comment or
a type assertion, when a render read follows an early return or sits in JSX, a branch, or an iteration callback,
when only a new import declaration would bring the hook into scope, when a render read would reuse a legacy
binding that the file's legacy migration removes, when a destructure is annotated or its call has type arguments,
when a legacy binding is referenced other than by a reported call, and when a `Memo` import swap would touch the
specifier another rule adds `useValue` beside. Hoisting instructions, `move-*`, `split-*`, and batching stay prose.

The unit suite applies each supported edit and typechecks the result against the installed `@legendapp/state`
and React types. The corpus eval applies every emitted edit in memory, per finding and per file, and fails when a
result does not parse.

## Compact provenance

`materiality: "compact"` means compact mode changed the finding's action or made a new conversion confirmable.
Kept findings and outcomes already available in broad mode are untagged. This comparison includes consumer-size
thresholds for hook-owned state. Compact mode evaluates both policies on the same parsed source; it adds analysis
work but does not reread or reparse files.

## Coordinated subscriptions (version 1)

`subscriptionAnalysis` is an additive section of schema 4. Its own `version` is `1`.

- `inventory` records each recognized imported `useValue` call in eligible scanned files, including its
  `use$` and `useSelector` aliases. Each entry contains its source location, binding, observable, classified
  reads, derivations, and a `status`. Unresolved entries have explicit `reasons`; they are not findings.
- Each read has a `kind` that says when the owner evaluates it.
- A `useValue(() => …)` selector whose every tracked read is a proven `path$.get()` also carries
  `selector: { tracks, result }`. `tracks` lists the tracked paths, and `result` is the value `useValue`
  compares to decide a re-render. `observable` is set only when the selector tracks exactly one path. A
  selector that cannot be proven names its blocker in `reasons`.
- `coverage` counts those three statuses and their total. This is subscription inventory coverage, separate
  from hook coverage and manually labeled corpus recall. It does not count hidden subscriptions inside
  arbitrary custom hooks or unrecognized imports.
- `plans` groups actionable subscription cuts by owner. Overlapping JSX boundaries merge into one child.
  Each plan lists subscriptions, complete derivation chains, child locations, remaining parent inputs,
  implementation steps, and behavioral verification. Define new children at module scope and retain their
  mount slots. Keep observable creation and atomic writes in their existing owner.
- `impact.basis: "static-jsx"` ranks by owner JSX elements outside the proposed children. These are source
  counts, not render counts, elapsed time, or a promised speedup. `rank` starts at 1.
- `impact.basis: "provided-runtime-measurement"` identifies externally supplied before/after costs.
  Measurements do not bypass detector proofs or create findings.
- `rejectedMeasurements` reports malformed, stale, duplicate, or unmatched measurement entries.

| Inventory `status` | Meaning                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `planned`          | A practice finding at this call carries a coordinated cut listed in `plans`          |
| `other-action`     | A practice finding at this call proposes an edit other than a subscription cut       |
| `unresolved`       | No finding at this call; `reasons` names every blocker the inventory could establish |

| Read `kind`         | Where the owner evaluates the read                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `render`            | A pure expression in the returned JSX, or a render gate that selects the returned JSX           |
| `render-callback`   | A synchronous array callback or IIFE inside the returned JSX, run once per item                 |
| `memo`              | An owner-level `useMemo` callback or dependency list, rerun only when dependencies change       |
| `derivation`        | A pure `const` or `useMemo` projection whose own reads are followed in turn                     |
| `effect`            | A React effect callback or its dependency list                                                  |
| `event-or-callback` | An event handler or other callback that runs outside render, or a `useCallback` dependency list |
| `unknown`           | A position the analyzer cannot classify, such as a `key` or `ref` value or an impure slot       |

A render gate is the condition of a conditional JSX child slot, of a conditional returned output, or of an
early `return` of JSX or `null`. Its inputs are render-owned values with no call or write. A gate also
decides what mounts, so a cut keeps it together with the complete conditional slot, and an owner-level
gate leaves no smaller boundary to extract. A JSX tag name chosen by a gate stays `unknown`.

| Selector `result` | What `useValue` compares                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| `boolean`         | A proven boolean, such as a comparison or negation                         |
| `primitive`       | A proven primitive, such as a number, string, or template literal          |
| `unknown`         | A value that may be an object or array, or a tracked path of unproven type |

| Inventory reason                         | Blocker                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `destructured-result`                    | The result is bound to a destructuring pattern                                                     |
| `effect-consumer`                        | A React effect reads the value                                                                     |
| `event-or-callback-consumer`             | An event handler or other deferred callback reads the value                                        |
| `excluded-by-report-filter`              | A report filter hid the finding at this call, so its plan is withheld                              |
| `memo-consumer`                          | A `useMemo` callback or dependency list reads the value                                            |
| `no-render-consumer`                     | Neither the returned JSX nor a render callback inside it reads the value                           |
| `observable-binding-not-proven`          | The argument is neither a proven observable path nor a selector function                           |
| `overlapping-parent-subscription`        | Another subscription in the owner already tracks this path or an ancestor                          |
| `owner-commit-or-snapshot-work`          | A render snapshot, or an effect, cache, or ref that a subscription-only render could redo          |
| `owner-not-proven`                       | The call is bound to a name, but no enclosing component or hook body is proven                     |
| `render-callback-consumer`               | A synchronous callback inside the returned JSX reads the value once per item                       |
| `returned-result`                        | The result is returned, so its consumers live outside this owner                                   |
| `selector-calls-unproven-function`       | The selector calls something other than a tracked `get()`, a known global, or a snapshot method    |
| `selector-function-not-proven`           | The selector takes parameters or is async or a generator                                           |
| `selector-observable-binding-not-proven` | A `get()` receiver is not rooted in a proven observable binding                                    |
| `selector-read-not-proven`               | The selector reads an observable without a tracked `get()`, such as `peek()` or a bare node member |
| `selector-syntax-not-proven`             | The selector uses syntax outside the modeled subset, such as an assignment or a loop               |
| `selector-tracks-no-observable`          | The selector is proven but tracks no observable                                                    |
| `shadowed-or-reassigned-binding`         | The binding is not a `const`, or it or a derivation shares its name with another owner binding     |
| `stable-material-render-cut-not-proven`  | No specific blocker was found, but no stable cut removes a material part of the owner render       |
| `unsupported-value-flow`                 | A read sits in a position the analyzer cannot classify                                             |
| `use-value-options`                      | The call has no argument or passes options                                                         |
| `wrapped-result`                         | The result is wrapped in another expression before it is bound                                     |

Inventory `reasons` describe the binding. `ruleGates` says why a binding-scoped practice rule made no finding
there: each entry names the rule's `action` and the first `gate` it failed. It is empty when a finding sits at
the call. Expert replay prints the targeted rule's gate in each miss line.

| `peek-unrendered-use-value` gate | The rule abstained because                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `binding-not-owner-level-const`  | The result is not bound to an identifier `const` directly in the owner body                  |
| `subscription-call-not-proven`   | The call, after transparent wrappers, is not a one-argument hook on a proven observable path |
| `plain-seed-not-proven`          | The path is not seeded with plain data, so the subscription may activate a lazy source       |
| `read-not-snapshot-safe`         | A read is not a hook initial value or a synchronous event-rooted command                     |
| `fallback-not-rewritable`        | The `?? fallback` is not inert, or reads would repeat a fallback that is not invariant       |
| `render-reads-untracked-state`   | The render reads a ref, `peek()`, or an untracked `get()` that may need the forced rerender  |

A practice finding with a coordinated cut also has `subscription` metadata. Report filters remove matching
plans and mark filtered inventory entries `excluded-by-report-filter`, so ignored actions do not reappear
as implementation instructions. Filtering away any part of a plan also removes its runtime measurement;
measurements of a complete edit cannot rank a partial edit.

To attach runtime evidence, create `<analysis-root>/.legend-doctor/subscription-measurements.json`:

```json
[
  {
    "planId": "copy plans[i].id from the baseline report",
    "fingerprint": "copy plans[i].fingerprint from the baseline report",
    "scenario": "toggle the setting ten times with unrelated UI mounted",
    "samples": 10,
    "before": { "ownerRenders": 10, "siblingRenders": 30 },
    "after": { "ownerRenders": 0, "siblingRenders": 0 },
    "behaviorEquivalent": true
  }
]
```

Record equal interaction samples before and after in the same runtime configuration, excluding initial
mounts. Verify visible values, drafts, callback snapshots, identity, effect cleanup, and atomic updates
before setting `behaviorEquivalent`. The analyzer trusts this supplied assertion; it does not run the app.
Attach the evidence when scanning the **baseline source**: the fingerprint hashes the owner's source text,
so a scan of the edited owner rejects it as stale. External modules and runtime settings are not included
in that fingerprint; repeat measurements when either changes. Programmatic `analyzePath` callers may pass
`subscriptionMeasurements` instead of creating the file.

Optional cost fields extend each `before` / `after` object without changing version 1:

| Field                | Unit and scope                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `selectorExecutions` | Total callback selector invocations, including invocations during renders                                  |
| `selectorDurationMs` | Summed elapsed milliseconds inside those callbacks                                                         |
| `scenarioDurationMs` | Total elapsed milliseconds for the complete interaction sequence, through the recorded completion boundary |

Counts must be nonnegative safe integers. Durations must be finite nonnegative numbers. Each optional
field must appear on **both** sides; zero is a measurement, absence means unmeasured. Values are totals
across `samples`, not averages. Scenario time already includes selector work: do not add these durations.
Selector timing adds instrumentation overhead; use identical instrumentation before and after. A render
reduction can coexist with more selector work or a slower scenario, so none is a total-benefit score.

Any new cost field requires an `environment` object alongside `scenario`:

```json
{
  "runtime": "exact JS engine/harness, React and Legend State versions",
  "platform": "OS/version and device model, or jsdom and host details",
  "configuration": "build mode, StrictMode, instrumentation, warmup, and completion boundary"
}
```

All three strings must be nonblank. Record the same configuration for both runs, including identical
inputs, update sequence and sample definition in `scenario`. Record native architecture and renderer
when applicable. This is caller-supplied provenance, not independently verified environment detection.
Measurements from changed dependencies or configuration must be recollected even if the fingerprint matches.

Legacy render-only measurements retain the same ranking policy: positive savings first, unmeasured static
plans next, and zero/negative savings last; measured groups use owner-plus-sibling renders saved per sample.
With provenance, that ordering applies only if every attached measurement has exactly matching environment
strings and scenario. Mixed legacy/provenance or incompatible environments/scenarios retain their evidence
but rank the **whole batch** by static JSX cut. `impact.basis` describes attached evidence, not a claim of
cross-environment comparability. Selector counts and milliseconds never enter the render-ranking score. Render-count sums and
per-sample comparisons use exact integer arithmetic, including near the safe-integer input boundary.

`npm run eval:runtime` includes a 100-row selector contract probe. It records actual callback executions
and monotonic-clock durations, excluding mount, and checks visible selection under normal and StrictMode
rendering. The pinned normal-mode contract is 100 raw row renders versus 2 selected row renders, with 102
selector executions in the selected version. These jsdom durations are diagnostics, not benchmark thresholds.
Existing keyed-selection contracts additionally check controlled drafts and host identity through reorder.

### Native validation setup and remaining limitation

This repository has no React Native application, native build configuration, device runner, or React Native
dependency. jsdom cannot validate native focus, host prop delivery, layout, keyboard behavior, or device
performance. No native harness was executed and no native recommendation is justified by these measurements.
Use an existing native application's device test setup for this bounded contract before extending native rules:

1. Pin and record the application's React Native, React, Legend State, Hermes/JSC, architecture and renderer
   versions. Add an isolated screen with two routes: the original owner-controlled host props, and the proposed
   stable module-scope reactive leaf. Use the installed `@legendapp/state/react-native` `$TextInput` and `$View`
   exports only after checking that version's API. beta.48 maps `$TextInput`'s `$value` to `onChangeText`.
2. Give both routes the same initial state and keyed rows. Include a controlled text input, a toggled host prop
   such as `editable`, a layout-changing view, an unrelated sibling, and a reorder control. Expose test IDs,
   mount/unmount counters, current text, focus/blur events, ref identity, and `onLayout`/`measure` results.
3. Run on iOS and Android with the application's device runner (for example its existing Detox or Maestro
   configuration): focus and type a draft; toggle the reactive prop; change layout; reorder rows; type again;
   remove and remount the row. Assert text, editability, focus, keyboard continuity, callback snapshots and
   layout agree between routes. Assert no unintended mount/ref changes, and exactly the expected cleanup on
   removal. Native `measure` must complete before recording the layout assertion; do not substitute jsdom.
4. First establish behavior in a development contract run with StrictMode on and off. Then collect repeated
   production/profile-device scenarios with equal warmup and instrumentation, recording selector work and
   total scenario duration separately. Define completion explicitly (including native commit/layout where
   measured); a JS `act` return alone is not a native completion signal. Record native profiler data separately
   if frame, commit, layout or UI-thread claims are needed. Never infer those costs from JS selector timing.

Closed `const` aliases/defaults and supported `useMemo` projections move with their subscriptions. Memo
identity and dependencies remain intact. Owner effects, `useMemo`/`useCallback` caches, and `ref` values do
not block when every dependency (or the ref itself) keeps its identity on a subscription-only render:
literals and explicitly typed primitive props, other `useValue` results, `useRef` and `useObservable`
handles, `useState` tuple members, zero-argument calls to an imported hook whose body only returns
`useContext(X)`, and caches whose own dependencies qualify. Such work is not redone when the cut removes
the owner render. Render-time `.current`, `get()` and `peek()` reads, inline or computed callback refs,
missing/unstable or unresolved dependencies, callback snapshots, overlapping parent subscriptions,
repeated render callbacks, and unsupported expressions remain conservative blockers. General selector
relocation is not implied by inventory coverage.

### Imported source coverage

With `--coverage`, `coverage.sourceContext` lists each target file's `requestedProofs` and
`unavailable` runtime import/re-export edges reachable through indexed source. Each edge names the
`importer`, `specifier`, selected `resolvedFile` when present, and one reason:

| Unavailable `reason` | Meaning                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `module-unresolved`  | TypeScript did not select a module under the current installation and configuration           |
| `declaration-only`   | TypeScript selected a declaration file, which cannot supply implementation behavior           |
| `source-not-indexed` | The selected implementation is outside the source index or was rejected after parser recovery |

Paths are relative to the scan root. Installed dependencies and package export conditions retain their
normal precedence; this diagnostic never substitutes a same-named workspace implementation.
`requestedProofs` names file-level source-symbol queries used by current consumers (such as observable,
observable-factory, component, and callback contracts). An unavailable edge can block these proofs;
it does not establish that any particular recommendation was missed. Known framework API contracts
may still work without implementation source. Detector stage `analyzed` describes execution, not
complete imported semantics. Empty `unavailable` does not prove export compatibility or successful
symbol proofs. Type-only, side-effect-only, dynamic imports and CommonJS require edges are outside
this static symbol-edge inventory. Ordinary reports and action scoring are unchanged.

## Helper tracking reviews

`review-helper-tracking` practices have `disposition: candidate`. They identify a direct local helper
called from an imported `useValue`, `useObserve`, `useObserveEffect`, or `observe` selector. The
selector must have independent direct reads. A direct parent read already covers a helper's child
read; a helper's broader parent read can introduce sibling dependencies beyond a direct child read.
Evidence lists helper reads, writes, and synchronous `batch` boundaries.
Additional dependencies can repeat selector work; the review does not establish React render savings,
a measured execution count, or permission to replace shared helper reads with `peek`.

This first phase abstains on imported helpers, call chains, recursion, mutable or shadowed dispatch,
async/generator functions, parameter defaults, conditional or abrupt control flow, unproven helper
initialization, and unresolved calls. Nested
callback bodies do not inherit tracking merely by lexical containment. Separate reaction arguments
remain separate. These limits can miss opportunities; absence of a review is not proof of no tracking.

Use `--disposition candidate` to inspect these reviews. `--actionable` hides them and counts them under
`hidden.practices`. They are listed separately from optimization precision in corpus output.
