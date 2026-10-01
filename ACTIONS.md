# Actions

A `change` finding carries a proven edit; a `style` finding offers an equivalent form without a proven render or lifecycle saving, so `--actionable` hides it and counts it under `hidden.practices`. The finding carries the exact edit. Each link shows the before and after in
[EXAMPLES.md](EXAMPLES.md).

### React state

| Action                                                                       | Removes                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| [`delete-unused-state`](EXAMPLES.md#delete-unused-state)                     | An unused state cell and its updates                     |
| [`delete-derived-state`](EXAMPLES.md#calculate-derived-values-during-render) | Effect-driven derived state and its extra render         |
| [`delete-effect`](EXAMPLES.md#calculate-derived-values-during-render)        | An effect left empty after derived state is removed      |
| [`move-state-down`](EXAMPLES.md#move-local-state-into-its-only-child)        | A parent render caused by one child's local state        |
| [`use-observable`](EXAMPLES.md#keep-owner-lifetime-and-subscribe-in-a-leaf)  | A broad owner render while keeping the required lifetime |
| [`use-ref`](EXAMPLES.md#replace-render-free-state-with-a-ref)                | A render for a value used only by commands or cleanup    |
| [`use-value`](EXAMPLES.md#remove-a-react-mirror)                             | Duplicate React ownership of an existing Legend value    |

### Effects

| Action                                                                               | Removes                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [`move-to-event`](EXAMPLES.md#move-event-owned-work-to-the-event)                    | A second transition caused by an event-following effect     |
| [`use-observe-effect`](EXAMPLES.md#react-to-an-observable-without-rendering)         | A component render used only to run an external reaction    |
| [`use-mount`](EXAMPLES.md#keep-empty-dependency-lifecycle-effects)                   | Nothing; never emitted, the effect stays `keep-effect`      |
| [`use-unmount`](EXAMPLES.md#keep-empty-dependency-lifecycle-effects)                 | Nothing; never emitted, the effect stays `keep-effect`      |
| [`persist-observable`](EXAMPLES.md#persist-an-observable-instead-of-writing-storage) | A hand-written storage write for a value Legend can persist |

### Legend reads

| Action                                                                              | Removes                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`narrow-use-value-subscription`](EXAMPLES.md#narrow-a-field-subscription)          | Updates from unread sibling fields                                             |
| [`peek-unrendered-use-value`](EXAMPLES.md#drop-a-subscription-no-render-reads)      | Renders for a value that only initializers or event commands read              |
| [`split-use-value-leaves`](EXAMPLES.md#split-unrelated-leaves)                      | One broad subscription across unrelated leaves                                 |
| [`move-use-value-down`](EXAMPLES.md#split-unrelated-leaves)                         | An observable update rendering a broad parent                                  |
| [`move-use-value-into-child`](EXAMPLES.md#split-unrelated-leaves)                   | A parent render used only to pass one value                                    |
| [`pass-observable-to-use-value`](EXAMPLES.md#remove-selector-work-and-legacy-names) | Missing tracking or redundant hooks for eager reads; selector syntax is style  |
| [`select-primitive-projection`](docs/plain-primitive-projection.md)                 | Renders for raw value changes that leave a row's equality comparison unchanged |
| [`replace-legacy-use-value`](EXAMPLES.md#remove-selector-work-and-legacy-names)     | Deprecated `useSelector` or `use$` usage                                       |
| [`use-peek-for-snapshot`](EXAMPLES.md#use-a-non-tracking-snapshot)                  | An `observer` render dependency from a `useState` initializer; elsewhere style |

### Legend tracking

| Action                                                                                         | Removes                                                     |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`use-value-for-render-read`](EXAMPLES.md#subscribe-to-a-render-read)                          | A render read that never subscribes                         |
| [`snapshot-mutated-use-value`](EXAMPLES.md#select-a-copy-when-a-memo-keys-on-a-mutated-value)  | A useMemo result left stale by an in-place write            |
| [`use-computed-for-parent-reads`](EXAMPLES.md#re-render-a-memo-child-that-reads-parent-values) | A `<Memo>` child frozen on its first render's parent values |

### Legend writes

| Action                                                               | Removes                                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`narrow-observable-write`](EXAMPLES.md#write-the-changed-path)      | A parent clone and broad publication                                       |
| [`toggle-observable`](EXAMPLES.md#toggle-directly)                   | Boolean updater ceremony                                                   |
| [`assign-observable-fields`](EXAMPLES.md#publish-one-logical-update) | Per-write reruns of one non-React tracker that reads several written paths |
| [`batch-observable-writes`](EXAMPLES.md#publish-one-logical-update)  | Per-write reruns of one non-React tracker that reads several written paths |

### Legend ownership

| Action                                                                            | Removes                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`reuse-observable-reference`](EXAMPLES.md#reuse-the-observable-you-already-have) | A wrapper node identical to its source observable |

### Keep and review

These carry no edit. A `keep` finding preserves code that is already correct; a review names the proof it lacks.
`--actionable` and `--disposition candidate` show a review only when a yes/no answer would convert it, and count the
rest under `hidden.abstentions`.

| Action                                                                 | Means                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`keep-state`](EXAMPLES.md#keep-small-local-state-in-react)            | React state is already the smallest render boundary; an observable would only add machinery |
| [`keep-effect`](EXAMPLES.md#keep-an-effect-while-changing-its-storage) | The effect's React timing, cleanup, or ownership must stay as written                       |
| `review-state`, `review-effect`                                        | An unsafe guess; `abstentionReason` names the missing proof ([REPORT.md](REPORT.md))        |
