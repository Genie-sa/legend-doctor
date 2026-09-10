# Legend State contract review

This independent review checked the selector-equality and helper-tracking changes against the published
`@legendapp/state` packages **3.0.0-beta.47** and **3.0.0-beta.48**, plus the official v3 documentation.
It examined the proposed changes relative to Doctor commit
`c7864f639104823f1c868c2da4b529cbce3d9bb0`. The Legend Apps research uses commit
`4744fb8b57026a645379e826fe8ab34861f43017` and beta.47; Doctor's runtime tests use beta.48.

## Authoritative contracts

- [React API](https://legendapp.com/open-source/state/v3/react/react-api/): `useValue` accepts an observable
  or selector, and selector equality controls updates. `useObserve` runs during render;
  `useObserveEffect` starts after mounting. A separate reaction callback is outside its own selector's
  tracking context.
- [Reactivity](https://legendapp.com/open-source/state/v3/usage/reactivity/): synchronous `get()` reads
  establish dependencies; `peek()` does not. Parent reads cover descendant changes. `e.onCleanup`
  owns an observer cleanup. Batching postpones notification; it does not suspend tracking.
- [Performance](https://www.legendapp.com/open-source/state/v3/guides/performance/): batching is useful
  when it prevents repeated work, but this does not prove a saving for every syntactic group of writes.

The installed distribution is the implementation authority for version-specific behavior. These
symbols were read directly, rather than inferred from examples:

| Contract                                 | Published file and symbol      | beta.47 line | beta.48 line |
| ---------------------------------------- | ------------------------------ | -----------: | -----------: |
| Callback versus observable input         | `index.js`, `computeSelector`  |          303 |          308 |
| Synchronous batch execution              | `index.js`, `batch`            |          758 |          763 |
| Dependency capture                       | `index.js`, `updateTracking`   |         1127 |         1132 |
| Tracking scope and subscription creation | `index.js`, `trackSelector`    |         1146 |         1151 |
| Reaction and cleanup ownership           | `index.js`, `observe`          |         1178 |         1183 |
| Shallow tracking option                  | `index.js`, `get`              |         2011 |         2043 |
| Selector hooks and observer fast path    | `react.js`, `useSelector`      |          112 |          138 |
| Render-time observer lifetime            | `react.js`, `useObserve`       |          529 |          569 |
| Effect-time observer lifetime            | `react.js`, `useObserveEffect` |          572 |          614 |

`react.d.ts` declares `UseSelectorOptions extends GetOptions`; `index.d.ts` declares
`GetOptions.shallow`. This option is relevant even though the introductory React documentation
emphasizes Suspense.

## Independent runtime checks

Small Node probes executed the actual packages. Each row below produced the same result on both
versions. Counts include the initial execution, except the shallow-option row, which counts only
notifications after the mutation. These are core-runtime observations, not device or browser timings.

| Experiment                                                                                  | Observed result                           |
| ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Read the direct trigger only, then change an unrelated hidden field                         | 1 execution                               |
| Also call a local synchronous helper reading the hidden field                               | 2 executions                              |
| Read the hidden field inside `batch` in that helper                                         | 2 executions                              |
| Read the hidden field with `peek()`                                                         | 1 execution                               |
| Read it only in a separate `observe` reaction                                               | 1 reaction execution                      |
| Read it only after `await` in an async selector                                             | 1 selector execution                      |
| Register `e.onCleanup`, rerun once, then dispose                                            | 2 cleanups                                |
| Return a function from that observer instead                                                | 0 calls of the returned function          |
| Compare shallow-option callback input with direct observable input on a descendant mutation | Callback: 1 notification; direct input: 0 |
| Compare `async () => state$.obj.get()` with direct `state$.obj`                             | Promise versus plain object               |
| Keep a child observable proxy, then replace its parent's data                               | Child proxy identity retained             |

An additional ancestor test ran on beta.47: a direct `state$.trigger.get()` listener executed once,
while adding a helper's `state$.get()` made it execute twice after changing sibling `hidden`.
Dependency coverage is directional: a parent read covers a child read; a child read does not cover
a parent read.

A separate React DOM 19.2.8/jsdom 26.1.0 check mounted each case and changed a primitive observable
from `0` to `1`. Both Legend versions gave these results. React's `useMemo` was instrumented to count
mount calls, not to replace hook behavior.

| Component context     | Eager `useValue(state$.get())`               | Direct `useValue(state$)`                   |
| --------------------- | -------------------------------------------- | ------------------------------------------- |
| Ordinary component    | 1 render, stale text `0`                     | 2 renders, text `1`                         |
| Wrapped in `observer` | 2 renders, text `1`; 2 mount `useMemo` calls | 2 renders, text `1`; 1 mount `useMemo` call |

Inside `observer`, the eager read already supplies the enclosing observer's subscription. The direct
form removes a redundant inner selector hook in this fixture; it does not repair missing reactivity.
Outside `observer`, the eager read is untracked in this fixture. Findings should distinguish
`useValue`'s own reactive input from subscriptions already established by an enclosing context.

## Issues identified before integration

1. **Shallow options invalidate direct-input equivalence.**
   The reviewed equality worktree accepted
   `useValue(() => state$.obj.get(), { shallow: true })` and called its direct replacement equivalent.
   `computeSelector` invokes the callback without forwarding `GetOptions` to its explicit `get()`.
   A direct observable receives those options. Rewriting therefore drops descendant notifications.
   Unknown or potentially shallow options need an abstention unless their effective tracking mode is
   structurally established.
   The guard must also cover eager inputs: in an `observer` component on beta.47,
   `useValue(state$.obj.get(), { shallow: true })` rendered twice and displayed `1` after a descendant
   mutation; the direct replacement rendered once and retained stale text `0`. The eager read had
   supplied deep tracking to the enclosing observer.
2. **Async selectors are not direct values.**
   The reviewed worktree accepted `useValue(async () => state$.obj.get())`. The replacement changes
   its Promise result to the underlying value. Matching a concise zero-argument `get()` is insufficient;
   the selector must also be synchronous. Both this and the shallow input were accepted before these
   phases, but the new equivalence claim made them necessary review corrections.
3. **The observer fast path changes subscription ownership.**
   Inside `observer`, a direct observable input without Suspense is read by the enclosing observer.
   A callback input still uses its own selector hooks. Consequently, a blanket assertion that every
   replacement preserves the same subscription and equality boundary is too strong. Explain the
   retained selected value and avoid an unmeasured render claim.
4. **Ancestor overlap was treated symmetrically.**
   Helper tracking suppressed a parent read whenever the caller read one child, missing an additional
   dependency on siblings. The corresponding test endorsed both directions. Only caller-parent to
   helper-child subsumption follows the actual runtime behavior.
5. **A throwing helper cannot establish the claimed successful subscription.**
   The reviewed helper summary accepted `state$.hidden.get(); throw 1;` as complete and emitted a
   dependency candidate. `trackSelector` does not reach subscription setup when execution throws.
   Exceptional control flow must make the summary incomplete.

## Integrated recheck

After the integration fixes, an independent analyzer check against the rebuilt branch passed all
**15 expected results**:

- Callback shallow options and eager shallow options both abstain.
- Async direct selectors, async literal selectors, prototype-setting literal properties and reordered
  literal evaluation abstain.
- A synchronous direct selector remains `style`; a no-options eager input remains `change` with
  wording that accounts for enclosing observer tracking.
- A fully retained ordinary literal remains `style` without claiming identical observer ownership.
- Sibling and broader-parent helper reads produce `candidate` findings; a caller's parent read
  subsumes a helper's child read.
- Explicitly throwing and async helpers abstain; synchronous reads inside `batch` remain candidates.

The changed guards were also reread directly. No remaining blocking semantic defect was found in
this scoped source-contract review. The final fresh-literal wording was corrected as well: accepted
nested object members can also have fresh identities, so the aggregate is no longer described as
the only fresh identity. Full typechecking, unit tests, corpus scoring and branch
integration are separate checks recorded by the parent integration task.

## Limits to preserve

The helper finding is a review candidate. A captured dependency does not prove that snapshot intent
is appropriate, that a React render occurs, or that changing shared helpers is safe. Unknown calls,
unsupported control flow, dynamic dispatch and incomplete provenance must remain unresolved.

Keeping all literal selector reads prevents one class of lost invalidation, but does not by itself
prove transformation equivalence: async results, property semantics, evaluation order and retained
member identity still matter. An optional style suggestion must preserve behavior too.

The two package versions share the tested contracts, but are not identical: beta.48 adds deferred
notification during render and clears its notification callback when unsubscribing. These checks do
not establish equality of scheduling or cleanup behavior across all versions. They do not certify
native applications, arbitrary computed accessors, undocumented options, or performance savings.
