# Plain primitive projection proof

`select-primitive-projection` moves a raw `useValue` read and its plain strict equality comparison into one inline selector. It does not introduce `useObservable`, and it does not modify the computed-memo rule.

```tsx
const active$ = observable<string>("a");
function Row({ trackId }: { trackId: string }) {
  const id = useValue(active$);
  const selected = id === trackId;
  return <div data-selected={selected} />;
}
export function App() {
  return <Row trackId="a" />;
}
```

The recommendation replaces the two declarations at the original hook position with:

```tsx
const selected = useValue(() => active$.get() === trackId);
```

The selector stays inline: each parent render supplies the current primitive prop. A boolean equality result partitions a broad string or number domain; two different unequal inputs leave the result equal. This establishes a possible suppressed render, not a workload frequency or timing estimate.

The first version accepts only a module-level private function referenced exclusively through component JSX tags. Its body contains exactly the raw const, the projected const, and inert host JSX. The observable is a same-file module const created by the imported `observable` factory with a string/number literal initializer and either no generic or a matching broad primitive generic. The comparison is `===` or `!==`, with the raw name on the left and a literal or directly destructured, explicitly typed primitive prop on the right. Raw references are confined to the projection. There are no computed property reads, helper calls, options, assertions, or arbitrary computations.

Exported/wrapped components, observer ownership, imported observable provenance, finite unions, boolean sources, property paths, custom hooks, callback/effect snapshots, render-side operations, and other body statements are outside this phase. Skipping a render can otherwise alter effect timing or refresh a closure differently even when the visible boolean stays equal. Unsupported shapes receive no new finding, rather than an unsafe migration instruction.

The separate observer runtime control demonstrates different subscription ownership; it does not authorize a detector recommendation in observer components. Already projected selectors are analyzer negative controls.

`evals/research/plain-primitive-projection.json` records manually audited Legend Music evidence at its corpus pin. Playlist's array-length projection enters a callback dependency and remains explicitly non-enforced. TrackItem already selects booleans. These research labels are not loaded into scored totals and assert no safe real-app migration.

The jsdom runtime contract mounts 500 rows, excludes mount renders, changes the active ID, changes row props while preserving keys/DOM identity, changes the ID again, and verifies cleanup. Normal mode: 500 raw renders versus 2 projected renders with 502 selector executions. StrictMode: 1,000 versus 4 renders with 504 selector executions. Selection still visits all rows. These are pinned React/Legend DOM observations, not native device timing.

JSX ownership assumes the normal React JSX transform, as does the existing React analysis pipeline. Explicit `@jsx`, `@jsxImportSource`, `@jsxRuntime`, and `@jsxFrag` pragmas abstain. Namespace JSX, namespace hook/factory calls, keys, refs, spreads, custom elements, and component children are unsupported. Project-wide custom JSX factory configuration is not represented by the current capability model; this phase does not add that metadata.

## Validation at the research baseline

Starting commit: `378977306448c0fc3d0326dbc986f0f6e082b622`. Typecheck, lint, formatting, build, package dry run, and all 1,035 unit/runtime tests passed. Doctor ran before editing and after validation; both runs reported zero findings on the analyzer's own source (329 then 330 files).

The full seven-app pinned corpus ran before and after. Both runs inventoried 1,236 hooks across 237 targets and exited 1 with the identical seven pre-existing mismatches recorded in the research report. No pins, scoring policy, or enforced labels were weakened. A separate starting-commit build and final build produced identical complete hook/practice finding records for every application:

| Application             | Findings before → after | Action/disposition deltas |
| ----------------------- | ----------------------- | ------------------------- |
| Legend Music            | 102 → 102               | All zero                  |
| Excalidraw              | 186 → 186               | All zero                  |
| Expensify               | 345 → 345               | All zero                  |
| Formbricks              | 422 → 422               | All zero                  |
| Outline                 | 150 → 150               | All zero                  |
| Open WebUI React Native | 8 → 8                   | All zero                  |
| Hoalu                   | 92 → 92                 | All zero                  |

The new action has no real-corpus enforced migration in this bounded phase. Its actionable evidence is the structural fixture suite and pinned runtime contract; the real-app labels preserve research boundaries.

The emitted replacement preserves the resolved named hook alias (for example `useSelected`), including when a different module binding is named `useValue`.

See [the test risk ledger](plain-projection-test-ledger.md) for covered failure modes, counterfactual evidence, and residual limitations.
