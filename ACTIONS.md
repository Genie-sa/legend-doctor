# Actions

A `change` finding carries a proven edit; a `style` finding offers an equivalent form without a proven render or lifecycle saving. The finding carries the exact edit. Each link shows the before and after in
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
| `review-state`, `review-effect`                                              | An unsafe guess; the report names the missing proof      |

### Effects

| Action                                                                               | Removes                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [`move-to-event`](EXAMPLES.md#move-event-owned-work-to-the-event)                    | A second transition caused by an event-following effect     |
| [`use-observe-effect`](EXAMPLES.md#react-to-an-observable-without-rendering)         | A component render used only to run an external reaction    |
| [`use-mount`](EXAMPLES.md#express-proven-lifecycle-intent)                           | Equivalent one-time setup ceremony                          |
| [`use-unmount`](EXAMPLES.md#express-proven-lifecycle-intent)                         | Equivalent teardown ceremony                                |
| [`persist-observable`](EXAMPLES.md#persist-an-observable-instead-of-writing-storage) | A hand-written storage write for a value Legend can persist |

### Legend reads

| Action                                                                                   | Removes                                                                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`narrow-use-value-subscription`](EXAMPLES.md#narrow-a-field-subscription)               | Updates from unread sibling fields                                            |
| [`split-use-value-leaves`](EXAMPLES.md#split-unrelated-leaves)                           | One broad subscription across unrelated leaves                                |
| [`move-use-value-down`](EXAMPLES.md#split-unrelated-leaves)                              | An observable update rendering a broad parent                                 |
| [`move-use-value-into-child`](EXAMPLES.md#split-unrelated-leaves)                        | A parent render used only to pass one value                                   |
| [`pass-observable-to-use-value`](EXAMPLES.md#remove-selector-work-and-legacy-names)      | Missing tracking or redundant hooks for eager reads; selector syntax is style |
| [`derive-computed-observable`](EXAMPLES.md#compute-a-derived-primitive-as-an-observable) | Renders for input changes that leave a memo unchanged                         |
| [`replace-legacy-use-value`](EXAMPLES.md#remove-selector-work-and-legacy-names)          | Deprecated `useSelector` or `use$` usage                                      |
| [`use-peek-for-snapshot`](EXAMPLES.md#use-a-non-tracking-snapshot)                       | Tracking in a proven non-tracking command                                     |

### Legend tracking

| Action                                                                                     | Removes                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| [`use-value-for-render-read`](EXAMPLES.md#subscribe-to-a-render-read)                      | A render read that never subscribes                          |
| [`pass-observable-to-reactive-input`](EXAMPLES.md#pass-the-observable-to-a-reactive-input) | A snapshot frozen in an input that tracks on its own         |
| [`split-use-value-result`](EXAMPLES.md#split-a-selector-that-only-builds-a-literal)        | Aggregate result allocation (style; no proven render saving) |

### Legend writes

| Action                                                               | Removes                                          |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| [`narrow-observable-write`](EXAMPLES.md#write-the-changed-path)      | A parent clone and broad publication             |
| [`toggle-observable`](EXAMPLES.md#toggle-directly)                   | Boolean updater ceremony                         |
| [`assign-observable-fields`](EXAMPLES.md#publish-one-logical-update) | Separate publications to sibling fields          |
| [`batch-observable-writes`](EXAMPLES.md#publish-one-logical-update)  | Separate publications across related observables |

### Legend ownership

| Action                                                                                                 | Removes                                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [`reuse-observable-reference`](EXAMPLES.md#reuse-the-observable-you-already-have)                      | A wrapper node identical to its source observable    |
| [`snapshot-computed-initializer`](EXAMPLES.md#snapshot-an-initial-value-instead-of-writing-a-computed) | Writes that a computed initializer silently replaces |

`review-helper-tracking` is a candidate review, not an optimization instruction. It names extra
observable dependencies reached through one synchronous local helper. Establish intended triggers
and selector execution cost before changing snapshot boundaries.
