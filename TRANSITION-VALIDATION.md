# Transition evidence and execution-prefix validation

This phase implements the first part of `OPTIMIZATION-STRATEGY.md`: retain individual write
transitions, improve the proof that a completed transition exists, and give remaining reviews
specific source evidence. It does not replace the classifier with a complete migration planner.

## Changes

- State-flow proofs retain the entire prefix through the last relevant containing statement.
  Unsupported later work cannot erase earlier coexecution evidence. Earlier guards, suspensions,
  and the complete containing try/catch/finally still participate in the proof.
- Group findings expose direct write positions, handler names/lines, enclosing control contexts,
  and pairwise synchronous coexecution evidence. Different handlers are never joined by this metadata.
- Mechanical `assign` fusion is identified only for adjacent literal replacements of distinct
  fields. Other writes retain evaluation order and control boundaries.
- Group questions identify unresolved pairs by line and column. Instructions preserve independent
  synchronous phases instead of describing an entire connected group as one `assign`.

The metadata does not establish callback provenance, owner lifetime, or a subscription cut. Those
remain the responsibility of the existing structural proofs. A proven synchronous path is not a
claim that every execution shares that path, and the metadata itself never changes an action.

## Pinned source audit

Formbricks commit `b344ddd73cfb0f7af86573176d53534a5321d982`,
[`SurveyDropDownMenu`](https://github.com/formbricks/formbricks/blob/b344ddd73cfb0f7af86573176d53534a5321d982/apps/web/modules/survey/list/components/survey-dropdown-menu.tsx):

| Source writes       | Meaning                                          | Required preservation                                                                     |
| ------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 187–188             | Close dropdown, open caution dialog              | One adjacent literal handoff; preserve preceding `preventDefault`                         |
| 193–194             | Start duplication, close dropdown                | One adjacent literal handoff after the workspace guard                                    |
| 210                 | Finish duplication                               | Separate finally write, including early success return and failure                        |
| 256–257 and 376–377 | Close dropdown, open deletion dialog             | Independent handoffs in different event handlers                                          |
| 325–326             | Close dropdown, open copy modal                  | One adjacent literal handoff                                                              |
| 391–392             | Close dropdown, open archive dialog              | One adjacent literal handoff                                                              |
| 145, 150, 156       | Archive start, success close, finally completion | Preserve await and exception paths; success close and finally reset require further proof |

Other dropdown-only commands and individual close callbacks remain separate writes. The deletion
`loading` flag has its own awaited command and is not part of this seven-member group. Parent-input
mount gates must remain outside extracted subscribers. The manually audited `isDuplicating` label
is explicitly non-enforced: recognizing its startup does not approve the whole connected group.

## Runtime and source cross-validation

[React's batching documentation](https://react.dev/learn/queueing-a-series-of-state-updates) describes
queued updates and separate intentional events. The
[Legend State reactivity guide](https://legendapp.com/open-source/state/v3/usage/reactivity/)
describes batched notification. Inspection of installed Legend State beta.48 `index.mjs` confirms
that `batch` invokes its callback synchronously and ends the batch in `finally`; it does not await
an async callback. `assign` internally batches property writes, but JavaScript evaluates its
argument before entering `assign`.

The executable contracts compare React and Legend owners under StrictMode and ordinary rendering
for successful work, rejected work, and a synchronous throw before suspension. They assert the same
DOM sequence, stable button identity, disabled-click suppression, event trace, and removal of owner
renders. All seven contracts pass on beta.48 and independently on beta.47.

A counterexample also checks partial failure: `batch(() => { first.set(true); second.set(fail()); })`
preserves and publishes the first write when `fail()` throws. `assign({ first: true, second: fail() })`
never enters the assignment and loses that write. This is why synchronous coexecution cannot serve
as blanket permission to fuse expressions.

## Validation

- Full `npm run check`: lint, formatting, typecheck, 884 tests, and package dry-run pass.
- Five deliberate compiled-code mutations are killed: ignoring the relevant prefix, ignoring
  adjacency, ignoring literal arguments, merging repeated writes to one field, and mislabeling
  finally as try. Original compiled files were restored and the targeted tests pass again.
- Legend Doctor before/after: original seven findings retain their actions; the two added React
  runtime-baseline hooks are `keep-state`. Nine total hooks, zero practice findings, status `ok`.

Tests are structural and runtime contracts, not an end-to-end execution of the pinned applications.
The complete survey-menu migration remains unapproved until its completion and subscription
obligations are discharged.

## Full pinned-corpus result

All seven pinned applications passed: 1,236 hooks across 237 targets; 508/524 manually labeled
hooks matched, with 16 explicit non-enforced misses; 5/5 review questions, 10/10 grouped instructions,
and 71/71 Legend practice findings matched. There are no added, removed, or changed actions.

| Application             | Action changes |
| ----------------------- | -------------: |
| legend-music            |              0 |
| excalidraw              |              0 |
| expensify               |              0 |
| formbricks              |              0 |
| outline                 |              0 |
| open-webui-react-native |              0 |
| hoalu                   |              0 |

The report enriches 125 findings and all 38 open group questions. The corpus still has 666 reviews.
Labeled actionable precision remains 100% (231/231). Labeled recall is 93.5% (231/247), versus 93.9%
before this phase: the denominator increased by the newly audited, non-enforced duplication label;
no recommendation regressed. These figures do not measure recall over unlabeled hooks.

The survey-menu report isolates exactly one unresolved pair: `isArchiveDialogOpen` at `150:7` and
`isArchiving` at `156:7`, in try and finally respectively. Its six adjacent literal handoff pairs
are separately recognized. The prefix improvement also has a direct analyzer regression contract
showing automatic grouped conversion before unrelated unsupported work, but it produces no new
action in this pinned sample. This phase improves detection coverage and review specificity;
it does not claim a measured reduction in the corpus review backlog.

## Pre-push source review

The review of `d71a472` against `fabc583` found two proof gaps, fixed without
changing corpus targets, labels, or scoring.

### Standards

The Base UI callback proof previously accepted plain merge inputs that could
remove or suppress the event. It now rejects competing event fields, including
constant objects and escaped identifier names, prototype overrides, and calls
exceeding the five arguments consumed by `mergeProps`. This is intentionally
conservative for competing handlers; it does not establish which compositions
would be safe by their names.

### Spec

An event-origin confirmation previously accepted unreachable nested command
calls. Inline adapters now require a direct expression call or a single
return/expression statement, and cannot be generators. Other control flow stays
under review instead of claiming that event timing is the only missing fact.

### Source and documentation evidence

- [Base UI mergeProps documentation](https://base-ui.com/react/utils/merge-props)
  describes right-to-left handler execution, prevention, and the five-argument
  limit. Installed Base UI 1.7.0 `merge-props/mergeProps.mjs`, especially
  `mergeProps`, `mutablyMergeInto`, and `mergeEventHandlers`, establishes the exact
  version used by the tests. Direct runtime counterexamples confirmed that null
  removes the event, a sixth argument is ignored, and prevention suppresses the
  earlier handler. Current online documentation is newer than this pinned source.
- [Legend batching documentation](https://legendapp.com/open-source/state/v3/usage/reactivity/#batching)
  agrees with installed 3.0.0-beta.48 `index.mjs`: `batch` ends in a synchronous
  `finally`; `assign` batches its property writes. JavaScript evaluates arguments
  before entering `assign`, so sequential setter evaluation is not automatically
  equivalent to constructing its argument object.
- [Legend React API](https://legendapp.com/open-source/state/v3/react/react-api/)
  and installed `react.mjs` agree that `useObservable` retains its observable in a
  React ref. [React state identity](https://react.dev/learn/preserving-and-resetting-state)
  remains a separate obligation when changing component ownership or boundaries.

Ten adversarial cases failed before their respective fixes: six merge-input
cases and four nonexecuting adapters. A direct inline adapter remains supported.
These fixtures are unit tests, not new pinned-app labels.

### Review of the subsequently merged subscription work

The remote advanced to `2ff621b` during review. The fixes above were rebased on
that commit, preserving the merged work and its existing eval changes.

Standards review found two additional correctness defects. Raw object property
reads were treated as pure derivations; Legend preserves getters, so duplicating
a derived value into multiple children can change both invocation count and
rendered values. Property-derived flows now abstain until data-property/purity
evidence exists. The positive closed-memo fixture uses a primitive subscription;
a TypeScript primitive property annotation cannot prove the absence of getters.
The mutable-render safeguard now runs for cohesive child cuts as well as separate
children. Independent recognized subscriptions retain their tracked-source
exemption, while clock snapshots continue to block relocation.

Spec review found that supplied programmatic measurements bypassed the validation
applied to persisted JSON. Both paths now use the same parser. Zero samples,
negative counts, empty scenarios, and nonfinite samples cannot become runtime
evidence. Valid supplied measurements still work.

Four more tests failed before these fixes: a duplicated getter, two cohesive-child
clock snapshots, and invalid programmatic measurement input. The getter behavior
was independently reproduced with installed Legend 3.0.0-beta.48: one shared
derivation rendered equal strings; two evaluations returned different strings.
No eval targets, labels, or scoring were changed during this review.

The cohesive-cut safeguard also distinguishes independent cached/deferred work
from fresh snapshots. Only direct observable arguments qualify as tracked
`useValue` sources; an opaque selector may execute on every owner render.
`useMemo` and `useCallback` exemptions require inline callbacks and dependencies
that pass owner-work validation, so eager callback factories and dynamic
dependency expressions cannot hide imperative work. Positive fixtures preserve
independent cached snapshots and callbacks embedded in JSX aliases; negative
fixtures cover selector reads, unstable dependencies, and eager factories.

### Final validation and push decision

All **935 tests** pass, as do lint, formatting, typecheck, build, and package
dry-run. The final Doctor scan of `src` reports no findings or practices.

The unchanged full public/private corpus inventories **2,428 hooks across 246
targets and 14 apps**. Discrepancies increase from **5 at 2ff621b to 7**. Hook
actions and group instructions are unchanged: 877/896 hook labels, 30/30 groups,
471/471 labeled actionable precision, and 471/490 recall. Legend practice matches
change from 106/109 to 104/109.

Two recommendations are withdrawn: Legend Music's getter-dependent metadata
projection (a conservative proof gap), and a private clipboard-feedback
subscription whose owner also refreshes displayed expiry state from the clock
(a behavior-preservation correction). The other twelve apps have zero action
deltas. Four initially over-conservative withdrawals were restored by the bounded
cached/deferred-work proofs above. No eval labels were adjusted to hide the
remaining discrepancies.

The fixes are committed locally; the push is held because the user requested it
only if everything was good and the unchanged eval suite is not green. The
remaining metadata opportunity needs a structural purity/data-property proof;
it must not regain certainty from a property type or application-specific exception.
