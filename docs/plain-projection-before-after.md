# PR #18: before/after evidence

PR: https://github.com/Genie-sa/legend-doctor/pull/18

- Actual PR base tested: `57c8020e70d718eabe57472f1dc9e618d0901f6a` (`main`).
- Implementation head tested: `85a8b16613b1aabce0570701afe4e655e1140a2d`.
- Original audit base: `378977306448c0fc3d0326dbc986f0f6e082b622`.

`git diff 3789773..57c8020 --stat` shows only `README.md` (six insertions, one deletion); analyzer, tests, dependencies, corpus targets, pins, and scoring are unchanged. Nevertheless, the actual PR base was built and tested separately. This evidence update changes documentation only; the PR description records its final head SHA, avoiding a self-referential commit hash in this document.

## A missed recommendation becomes a proven instruction

Run this source through `analyzeLegendPractices({ sourceText, fileName: "fixture.tsx" })` at both revisions:

```tsx
import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";
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

| Case                                                           | Base                | Implementation head                                     |
| -------------------------------------------------------------- | ------------------- | ------------------------------------------------------- |
| Source above                                                   | No practice finding | One `select-primitive-projection`, `certain` / `change` |
| Same source with `useValue as useSelected` and a matching call | No practice finding | Same action; exact replacement calls `useSelected`      |
| Replace comparison operand with `hidden()`                     | No practice finding | No practice finding; hidden dependency/purity unknown   |

The new instruction replaces the two const declarations at the original hook position with:

```tsx
const selected = useValue(() => active$.get() === trackId);
```

It retains inline prop captures and rejects cases outside the closed proof. The source is never automatically modified. This demonstrates a previously missed opportunity; it does not claim an existing real-app migration was safe.

## Same runtime scenario, before and after the recommended edit

Executed by `tests/runtime/plain-primitive-projection.test.ts` using Node 22.23.2, React 19.2.8, Legend State 3.0.0-beta.48, and jsdom 26.1.0. Both variants mount 500 keyed rows and change the active ID from 0 to 1. Mount work is excluded. The raw version uses direct observable inputs, so its callback-selector count is zero; this does not mean the raw hook performs no internal selection work.

| Mode       | Raw subscription renders | Projected renders | Raw callback-selector executions | Projected callback-selector executions |
| ---------- | ------------------------ | ----------------- | -------------------------------- | -------------------------------------- |
| Normal     | 500                      | 2                 | 0                                | 502                                    |
| StrictMode | 1,000                    | 4                 | 0                                | 504                                    |

The same test changes row props without changing the observable, verifies the new selection and retained DOM identity, changes the ID again, and confirms no renders after unmount. No selector durations, render durations, native layouts, native device timings, or constant-time performance were measured or claimed.

Counterfactual controls in `tests/runtime/plain-projection-boundaries.test.ts` run in both modes:

- Changing only a hidden observable leaves the original helper-based result `true`, but an unsafe selector migration makes it `false`.
- Changing a raw ID while its boolean remains false refreshes the original effect and click snapshot; an unsafe `peek` migration suppresses that effect and leaves the click snapshot stale (`1` versus `0`).

These negative controls substantiate the rejection boundary. They are not migration recommendations.

## Quality and corpus results

| Check                                                   | Actual PR base               | Implementation head           |
| ------------------------------------------------------- | ---------------------------- | ----------------------------- |
| `npm run check`                                         | Pass; 978 tests              | Pass; 1,035 tests             |
| Lint / formatting / typecheck / build / package dry run | Pass                         | Pass                          |
| Seven pinned applications                               | 1,236 hooks / 237 targets    | 1,236 hooks / 237 targets     |
| Full corpus exit                                        | 1: seven existing mismatches | 1: identical seven mismatches |

Complete finding-record comparisons include both actions and dispositions, rather than only aggregate totals:

| Application             | Findings before | Findings after | Action deltas | Disposition deltas |
| ----------------------- | --------------- | -------------- | ------------- | ------------------ |
| Legend Music            | 102             | 102            | All zero      | All zero           |
| Excalidraw              | 186             | 186            | All zero      | All zero           |
| Expensify               | 345             | 345            | All zero      | All zero           |
| Formbricks              | 422             | 422            | All zero      | All zero           |
| Outline                 | 150             | 150            | All zero      | All zero           |
| Open WebUI React Native | 8               | 8              | All zero      | All zero           |
| Hoalu                   | 92              | 92             | All zero      | All zero           |

Remaining failures are the Outline DocumentCopy abstention-reason mismatch; four missing relocation expectations (Legend Music PlaybackArea twice, VisualizerWindow once, and Hoalu expense-filter-dropdown); and two unexpected Legend Music relocation practices (GeneralSettings and VisualizerWindow). No labels, pins, or scoring requirements were weakened.

There are no enforced real-corpus migrations for this new action. Playlist's callback-dependent array projection remains non-enforced research; TrackItem's existing selectors remain controls. See [the risk ledger](plain-projection-test-ledger.md) and [the proof boundary](plain-primitive-projection.md) for limitations, including the normal React JSX-transform assumption and unverified compatibility with unknown runtime versions.

## Reproduction

Use isolated checkouts for the two SHAs, install the lockfile dependencies, and run `npm run check`. Import each build's `dist/src/practices/analyze-legend-practices.js` for the fixture above. At the implementation head, run:

```sh
node --test dist/tests/runtime/plain-primitive-projection.test.js \
  dist/tests/runtime/plain-projection-boundaries.test.js
node dist/evals/run.js \
  --repo legend-music=/Users/alialdhamen/dev/legend-doctor-corpus/legend-music \
  --repo excalidraw=/Users/alialdhamen/dev/legend-doctor-corpus/excalidraw \
  --repo expensify=/Users/alialdhamen/dev/legend-doctor-corpus/expensify \
  --repo formbricks=/Users/alialdhamen/dev/legend-doctor-corpus/formbricks \
  --repo outline=/Users/alialdhamen/dev/legend-doctor-corpus/outline \
  --repo open-webui-react-native=/Users/alialdhamen/dev/legend-doctor-corpus/open-webui-react-native \
  --repo hoalu=/Users/alialdhamen/dev/legend-doctor-corpus/hoalu
```

Run the same corpus command in the actual base checkout. Substitute local checkout paths as needed; the evaluator verifies pins. Exact local logs, probes, complete finding records, deltas, and mutation outputs are retained under `/Users/alialdhamen/.codex/artifacts/plain-primitive-projection-2026-09-19/`.
