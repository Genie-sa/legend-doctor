# Imported source coverage phase

Implemented against clean audited commit `c7864f639104823f1c868c2da4b529cbce3d9bb0`, without divergence.
The first phase is complete. No factory/accessor composition rule was added.

## Behavior and structural proof

`--coverage` now adds `sourceContext` per target: file-level `requestedProofs` and unavailable
runtime import/re-export edges with importer, specifier, selected resolved file, and reason.
Missing modules, declaration-only exports, and resolved-but-unindexed implementations are distinct.
TypeScript resolution, installed-package precedence, export conditions, and existing recommendations
are preserved. Source inventory runs independently of successful symbol lookup, so the absence of
all factory declarations cannot hide a missing factory edge. Direct imported-hook requests are
included alongside bulk source-symbol queries.

Requested categories identify potentially blocked source consumers, not a proven missed finding.
`analysis-pass.ts` consumes observable origins, containers, factories, and primitive/array facts for
existing practice and hook proofs. The coverage diagnostic does not assert allocation lifetime,
transparent normalization, or runtime savings. Existing stage `analyzed` continues to mean detector
execution. Empty unavailable edges do not establish compatible exports or successful provenance.

## Changed paths

- `src/project/source-components/module-resolution.ts`: companion structured resolution result;
  existing string/null resolver retains its behavior.
- `src/project/source-components/source-context.ts`: static runtime edge inventory, cycle and duplicate
  suppression, sorted diagnostics, requested symbol categories.
- `src/project/source-components/source-components.ts`: `SourceIndex.sourceContextFor(file)`.
- `src/project/analysis-coverage.ts` and `src/project/analyze-path/analyze-path.ts`: additive optional
  coverage field and relative path serialization, including symlink roots.
- `tests/project/source-context.test.ts`: six focused contract tests.
- `tests/project/analyze-path/workspace-events.test.ts`: coverage assertions on sixteen existing
  installed/export/duplicate/version/parser controls.
- `REPORT.md`: public diagnostic meaning and limitations.
- `docs/source-context/pinned-labels.json`: manually audited LA-05 evidence, explicitly non-enforced
  and outside scored action labels. Added before production edits; no scoring/schema action changes.

## Validation

- Locked dependency install and build passed.
- Baseline unit suite: **939 passed**, zero failures/skips.
- Final typecheck, build, unit suite: **945 passed**, zero failures/skips.
- Lint, full formatting check and whitespace check passed.
- Focused missing-edge suppression mutation failed its regression test; restored exactly afterward.
- Repeated diagnostics are equal and duplicate imports emit one edge. Cyclic reexports terminate.
- Installed precedence, incompatible registry dependency, duplicate workspace identities, null/private
  exports, types-first exports, NodeNext conditions, malformed source, and symlink roots pass controls.
- All seven public pins accepted, all tracked checkout trees clean.
- Full required corpus command completed before and after: **byte-identical output**, including the
  same seven pre-existing mismatches. 1,236 hooks, 237 targets; 508/523 hook labels, 4/4 questions,
  10/10 groups, 67/71 practice labels. This is not a green corpus claim.
- Separately built the audited source archive and compared all **237 complete target reports** with
  this build: identical. Detailed action/disposition deltas are in `action-deltas.json`.
- Doctor on the same local repository root before/after: identical 12 hook findings and zero practices;
  source files increase 558 to 560 due to the new implementation/test files.
- Linked upstream Music scan: 147 target files, 54 hooks, 45 practices, and 147 source-context entries.
  Its storage factory edge is available. The earlier 39-to-45 linking effect remains an environment
  diagnostic case, not a performance or detector improvement claim.

| Public application      | Every action/disposition delta |
| ----------------------- | -----------------------------: |
| legend-music            |                              0 |
| excalidraw              |                              0 |
| expensify               |                              0 |
| formbricks              |                              0 |
| outline                 |                              0 |
| open-webui-react-native |                              0 |
| hoalu                   |                              0 |

Unchanged baseline failures:

1. Outline `DocumentCopy.tsx:27`: callback-timing-unresolved expected; async-command-origin-unresolved received.
2. Legend Music `components/PlaybackArea.tsx:29`: missing move-use-value-down.
3. Legend Music `components/PlaybackArea.tsx:31`: missing move-use-value-down.
4. Legend Music `visualizer/VisualizerWindow.tsx:13`: missing move-use-value-down.
5. Hoalu `components/expenses/expense-filter-dropdown.tsx:67`: missing move-use-value-down.
6. Legend Music `settings/GeneralSettings.tsx:16`: unexpected move-use-value-down.
7. Legend Music `visualizer/VisualizerWindow.tsx:15`: unexpected move-use-value-down.

## Integration and remaining candidates

Two required subagents supplied source-contract analysis and independent adversarial review; their
findings shaped missing-only factory coverage, typed-export controls, pinned evidence, and direct hook
request coverage. Coordinator and siblings were informed of the narrow additive interface.
No sibling detectors, core action types, registries, or scored corpus labels were edited.

Deferred: allocated-versus-borrowed nested factory members; normalized settings accessors; semantic
ambiguity involving competing star exports. These require separate detector proofs/fixtures and
must not be inferred from method spelling. No native reproduction resumed. Static symbol inventory
excludes type-only, side-effect-only, dynamic import and CommonJS require edges. Detailed coverage
walks reachable indexed source per target and can produce repeated transitive edges across targets;
ordinary reports do not pay this inventory cost. No new runtime performance claim is made.

No commit, push, publication, or PR was performed.
