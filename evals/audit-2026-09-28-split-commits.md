# Split-commit audit — September 28, 2026

Detector change: a `useState` that would earn `use-observable` becomes a review (`atomic-transition-unproven`) when the
workspace's renderer may commit the converted observable apart from a rendered React state written in the same
transition. Analysis baseline: `551d436`. No pin or target changed.

## Runtime evidence

One cell converted to a `useObservable` read through `useValue` in a leaf, the other kept in `useState`, measured with
a `Profiler` outside `act` once the awaited work settles. Each cell lists the commits with both values in React state,
then with one converted; `split` means the converted cell commits alone first.

| Transition                                                  | React DOM 19.2, `createRoot` | React DOM 18.3.1, `createRoot` | React DOM 18.3.1, `ReactDOM.render` |
| ----------------------------------------------------------- | ---------------------------- | ------------------------------ | ----------------------------------- |
| Both writes in one stretch after an `await`                 | 1, then 1                    | 1, then 2 (split)              | 2, then 2                           |
| Awaited local helper writes, caller's `finally` writes next | 1, then 2 (split)            | 1, then 2 (split)              | 2, then 2                           |
| `then` callback writes, chained `finally` writes next       | 1, then 2 (split)            | 1, then 2 (split)              | 2, then 2                           |
| Rethrowing helper writes in `catch`, caller's `catch` next  | 1, then 2 (split)            | 1, then 2 (split)              | 2, then 2                           |
| React write resumes first, observable a microtask later     | 1, then 1                    | 1, then 2 (split)              | 2, then 2                           |

A React host event handler that writes both cells commits once on every renderer, converted or not.

The React 19 column is `tests/runtime/split-commit-order.test.ts`, with and without StrictMode. React commits a
`useSyncExternalStore` notification on the sync lane in a microtask, and a setter called outside a React event on the
default lane. React 19 renders every lane pending at that flush together, so writes in one stretch commit once; a write
that a promise settlement resumes after the flush misses it. React 18 renders the sync lane alone, so it also splits
one stretch. A legacy root renders every update as it happens, so the conversion changes nothing.

## Proof

`findSplitCommitCompanions` reuses the execution units and the synchronous call reach. Two writes share a command when
the functions that synchronously run them intersect; a `then`, `catch`, or `finally` callback belongs to the command
that registered it. A write is settled when it follows a suspension in its function or runs in such a callback.

- Another stretch: both writes are settled, in different functions. On React 19 a companion is exempt when the
  converted write's function awaited it in an earlier stretch, since the sync-lane flush renders it too.
- Same stretch: only when a workspace package's React minimum is below 19, and never for a write a React host event
  runs before its command suspends.
- A companion must reach a render, an effect, or unknown code. A cluster that converts together drops the members it
  writes in the same stretch.

The review asks whether any reader needs both values in the same commit, and confirming it restores `use-observable`.
The rule is conservative: it abstains on every settled co-write across functions even when the two promises are
unrelated, which is what turns the extra junto and gptme findings below into reviews.

## Relabeled

| Target                        | Line | State                | Was              | Now                                     |
| ----------------------------- | ---: | -------------------- | ---------------- | --------------------------------------- |
| `formbricks-webhook-settings` |   55 | `endpointAccessible` | `use-observable` | review, confirm yields `use-observable` |
| `formbricks-webhook-settings` |   56 | `hittingEndpoint`    | `use-observable` | review, confirm yields `use-observable` |
| `formbricks-add-webhook`      |   56 | `hittingEndpoint`    | `use-observable` | review, confirm yields `use-observable` |

Each endpoint command writes these cells in its final stretch, and the awaiting submit or creation command writes
`isUpdatingWebhook` or `creatingWebhook` as soon as it resumes. React 19 commits the converted cells a microtask earlier.

## Deltas

Pinned: excalidraw `App.tsx:767` and formbricks `DeleteAccountModal/index.tsx:40` become unlabeled reviews besides the
three relabels; every other pinned application has a zero delta.

The audited false positives become reviews: junto `WorkSurfaces.tsx:485` and `ProvidersSettingsSection.tsx:36`
(React 19), and gptme `TaskCreationDialog.tsx:44` and `ServerApiKeySettings.tsx:39` (React 18 `createRoot`, one
stretch). The conservative rule also reviews gptme `SetupWizard.tsx:163`, junto `WorkSurfaces.tsx:479`, `480`, and
`482`, and `NotificationSettingsSection.tsx:81` and `82`. Every other candidate application has a zero delta.
