# Legend Doctor

Legend Doctor inventories React `useState` and `useEffect` calls and emits concise, evidence-backed instructions for
a coding agent. Its migration posture is Legend-first: prefer stable observable ownership with subscriptions at the
smallest rendering leaf, while retaining React state only for coherent leaf-local or intentionally isolated state.

`useState` does not mechanically become `useValue`. The analyzer makes two decisions: where mutable state should be
owned (`useState`, `useObservable`, an existing observable, a ref, or nowhere) and where rendered values should
subscribe (`useValue`, `Memo`, a reactive prop, or an extracted leaf). It does not recommend `observer` by default.

Output has three dispositions: `change` for proven transformations, `candidate` for Legend-first restructuring that
requires the coding agent to choose or extract the leaf boundary, and `keep` only when React state is already in a
tiny coherent owner or deliberately holds a stable component-lifetime resource.

Related hooks can carry a `state-cluster` group in JSON. Agent output collapses those members into one instruction—for
example, replacing a payload plus several modal booleans with one discriminated observable dialog model—so architectural
state is restructured as a unit instead of generating repetitive per-hook advice.

Direct-render analysis computes the lowest common JSX subtree for every state read and command. Stable confined
ownership can move into an extracted React leaf; conditional or repeated surfaces keep one observable at the owner and
subscribe in a leaf or per-row selector. Pure boolean, equality, property, and style projections can move into a
call-site subscriber wrapper without changing the receiving component's API. The analyzer rejects projection changes
when companion React writes, custom-hook escapes, or reactive mutation lifecycles mean the owner would rerender anyway.
Companion-coupled state must migrate as one proven workflow model; an independent open event alone is not enough to
justify splitting a later atomic transition across React and Legend updates.

One-shot deferred render gates are treated as paired state/effect transformations. The request-idle, animation-frame,
or interaction scheduler and its exact cleanup remain unchanged; only the literal-true React state sink becomes an
observable, with the render gate subscribed at the leaf. Multi-phase, dependency-rearmed, and multi-sink effects remain
review cases.

```bash
npm install
npm test
npm run build
node dist/src/cli.js ./path/to/react-app
```

Use `--json` for structured output and `--actionable` to show both proven changes and Legend-first candidates while
hiding genuine keeps. The same filtering applies to `--json --actionable`.

## Evaluation

The pinned corpus currently inventories 1,738 direct React hooks across Tree Map, Tree Wallet, Memoria, Legend Music,
Excalidraw, Expensify, Formbricks, and Outline. The benchmark contains implemented labels, known missed opportunities,
and hard negatives. This keeps recall honest instead of measuring only patterns the analyzer already supports.

```bash
npm run eval -- \
  --repo platform=/path/to/netzerosa-platform \
  --repo memoria=/path/to/memoria \
  --repo legend-music=/path/to/legend-music \
  --repo excalidraw=/path/to/excalidraw \
  --repo expensify=/path/to/expensify \
  --repo formbricks=/path/to/formbricks \
  --repo outline=/path/to/outline
```

The runner verifies repository commits and exact hook counts before scoring recommendations, so source drift cannot
silently change the benchmark.

The first version intentionally has no autofix, persistent cache, worker pool, SARIF output, or generalized
cross-file call graph. Those features are allowed only when labeled real-world evaluations demonstrate a concrete
need.

Cross-file component resolution uses each importer's nearest TypeScript configuration. Resolution alone is only
provenance; a change requires a bounded call-site or subtree proof showing one stable runtime leaf owns every render
read, plus proof that no effect, repeated/conditional instance, escape, or companion React update keeps the owner
render alive. The instruction creates a local call-site wrapper by default instead of changing a shared component API.
Detectors are defined by these structural facts, never by repository names or application-specific allowlists.

Controlled-input recommendations keep one observable at the current owner and prove every subscriber explicitly. A
single value/callback leaf may be paired with one pure validation projection only when the two leaves are disjoint and
independent rendered work remains outside both. State-independent conditional branches keep the observable above the
branch. A direct, call-free controlled edit can remain independent even when a separate reset transaction also clears
sibling React state; callbacks that normalize, schedule, or issue another command remain coupled. Ref-backed validation,
repeated consumers, nested cohesive controls, opaque normalization, and incomplete projection aliases remain review findings.

Keyed selection recommendations create row-local membership selectors and separate aggregate subscribers; converting
an array or `Set` into one root observable is not enough. The bounded array form accepts one immutable local
`new Set(selectedIds)` normalization, stable item-derived row keys, command-only payload reads, and summaries that do
not decide row existence. Mutable or escaped aliases, list filtering/cardinality, effect ownership, unstable keys, and
raw aggregate broadcasts across every row remain review findings.
