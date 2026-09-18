# Pinned command-item selection proof

This bounded extension resolves Formbricks `SingleTag.isMergingTags`. It does not extend async
segment recognition or weaken atomic-transition, callback-capture, or mount-identity requirements.

## Before and after

Starting checkout: `378977306448c0fc3d0326dbc986f0f6e082b622`.
Tested PR base: `57c8020e70d718eabe57472f1dc9e618d0901f6a`; its only difference from the starting
checkout is README.md. The final reviewed head SHA is recorded in the PR description, so this
file does not attempt to embed the hash of its own commit. Concurrent main-branch changes are
reviewed separately by the coordinating integration task.

The same emitted `source-forwarded item selection` fixture runs against both builds:

| Observation                                              | Tested base                                                     | This change                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Minimal source wrapper ending at `Command.Item.onSelect` | `review-state` / `candidate`, `async-command-origin-unresolved` | `use-observable` / `change`                                                      |
| Pinned Formbricks `single-tag.tsx:45`, `isMergingTags`   | Same unresolved event ownership                                 | Proven event ownership; original async interval and gate retained                |
| Existing unit/runtime suite                              | 978 tests pass                                                  | 1026 tests pass (36 structural controls and 12 real-library runtime cases added) |
| Full pinned corpus                                       | 508/523 hook labels, 231/246 actionable recall                  | 509/523 hook labels, 232/246 actionable recall                                   |
| Labeled actionable precision                             | 231/231                                                         | 232/232                                                                          |
| Corpus exit                                              | 1, seven existing failures                                      | 1, same seven failures                                                           |

The positive fixture fails on the tested base and passes with this change. Its expectation was
written before editing the detector. The Formbricks label was manually audited and made enforced
before the detector edit; no repository pin, target, or scoring policy changed.

## Audited boundary and assumptions

Formbricks pins `cmdk` to 1.1.1. Its `MergeTagsCombobox` adapts selection to a tag ID and forwards
through the local `CommandItem` wrapper. The pending flag has one render gate, no event reads,
one literal start before the unconditional await, and a completion reset. Independent tag input
and count presentation stay outside the extracted, always-mounted subscriber. The spinner/combobox
conditional remains inside that subscriber, retaining its existing mount/unmount transitions.

The terminal contract was audited in [cmdk 1.1.1 source](https://github.com/pacocoursey/cmdk/blob/v1.1.1/cmdk/src/index.tsx#L625-L680):
`Item.onSelect` is consumed by click and a keyboard-dispatched selection event; it is removed from
the host prop spread. The root's value-change callback has different timing and is deliberately
unsupported. The executable tests use the actual pinned package, not a callback stub.

The proof requires the exact named `Command` import and `.Item` member, only `onSelect`, an exact
owning-package dependency pin, and agreement with installed package metadata when resolution is
available. Resolved application path aliases, absent/ranged/unknown versions, other exports,
shadowing, mutable/escaped imports, and unproven prop transports are rejected. All loaded source
files are checked for alternate imports and static package reexports/imports that could expose
or replace the same terminal. `asChild` must be absent or false through source-visible spreads.
The tracked callback must survive attribute ordering, not be overwritten by a later prop/spread.

As with the existing framework adapters, package identity is a trust boundary: the contract assumes
unmodified upstream content matching the declared exact pin when dependencies are not installed.
This does not attest registry contents, package-manager overrides/patches, custom bundler aliases,
or runtime monkey-patching from code outside the loaded source scope. Those require separate
provenance evidence; the analyzer does not claim whole-program JavaScript equivalence.

## Risk and test ledger

| Risk                        | Protected contract and test oracle                                                                                                                                                                                                      | Coverage                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Wrong terminal or timing    | Lookalike package, wrong export/member/property, eager wrapper, and unknown scheduler stay candidates                                                                                                                                   | Structural end-to-end fixtures                                                           |
| Mutable import identity     | Member overwrite, export alias with remote mutator, second named/namespace import, another loaded source module, reexport, quoted/template dynamic import, require, and unknown loader arguments in the terminal module stay candidates | Structural fixtures; disabling import stability makes seven controls fail                |
| Unknown package version     | Missing/ranged/unknown pin, malformed JSON, installed mismatch, and local path override cannot establish the audited contract; matching installed version is accepted                                                                   | Metadata plus structural fixtures; disabling version validation makes five controls fail |
| Prop overwrite/polymorphism | Later callback override, unknown spread, and `asChild` stay candidates; explicit false remains supported                                                                                                                                | Structural fixtures; disabling the host/override guard makes three controls fail         |
| Atomic start epoch          | Companion writes before/after pending start retain a grouped instruction and ordered synchronous batching                                                                                                                               | Exact group-member and instruction assertions                                            |
| Async completion/capture    | Click/keyboard, success/rejection, child selection/open writes, owner prop changes before selection and during pending, normal/StrictMode preserve event traces and captured values                                                     | Real cmdk + React + Legend runtime comparisons                                           |
| Mount identity/exception    | Stable section and independent input retain identity; picker gate lifecycle matches; synchronous throw before suspension does not remount the picker                                                                                    | Runtime identity and effect trace assertions                                             |
| Overbroad library contract  | Root value callback can run before user input; disabled Item never selects                                                                                                                                                              | Executed real-library counterexamples                                                    |
| Removed render work         | Pending start and completion stop invalidating the owner; selector executions are counted separately                                                                                                                                    | Runtime measurements below                                                               |

## Measured scenario

Node 22.23.2, macOS arm64, React 19.2.8, Legend State 3.0.0-beta.48, cmdk 1.1.1, jsdom 26.1.0.
Counts cover the pending-start and completion updates only; mount and deliberate parent prop
refreshes are excluded. Click/keyboard and success/rejection produce the same counts.

| Mode       | React owner renders | Migrated owner renders | React selector callbacks | Migrated leaf selector callbacks |
| ---------- | ------------------: | ---------------------: | -----------------------: | -------------------------------: |
| Normal     |                   2 |                      0 |                        0 |                                4 |
| StrictMode |                   4 |                      0 |                        0 |                                6 |

The migrated test uses a `useValue(() => pending$.get())` selector to expose selector work. These
are executed render/selector counts, not render-duration, selector-duration, throughput, or device
measurements. jsdom layout shims do not establish native behavior or real-browser layout cost.

## Seven-app action/disposition deltas

Each target's complete finding inventory was compared by hook, source location, and name.

| App                     | `use-observable` / `change` | `review-state` / `candidate` | Other actions/dispositions |
| ----------------------- | --------------------------: | ---------------------------: | -------------------------- |
| Legend Music            |                           0 |                            0 | unchanged                  |
| Excalidraw              |                           0 |                            0 | unchanged                  |
| Expensify               |                           0 |                            0 | unchanged                  |
| Formbricks              |                          +1 |                           -1 | unchanged                  |
| Outline                 |                           0 |                            0 | unchanged                  |
| Open WebUI React Native |                           0 |                            0 | unchanged                  |
| Hoalu                   |                           0 |                            0 | unchanged                  |

The seven unchanged corpus failures are the Outline DocumentCopy abstention-reason mismatch;
four missing subscription-relocation practices (Legend Music PlaybackArea twice, VisualizerWindow,
and Hoalu expense-filter-dropdown); and two unexpected Legend Music relocation practices
(GeneralSettings and VisualizerWindow). Practice and grouped-instruction totals are unchanged.

Outline's `isArchiving`, `isRegistering`, and `copying` remain non-enforced because the styled
wrapper/imported style factories require more proof. Expensify's Promise-chain/picker and menu
callback opportunities also remain unresolved. Hoalu's `isEncoding` already matches its
non-enforced label on the starting checkout, so it contributes no recall gain here.

## Reproduce

```sh
npm ci
npm run check
node --test dist/tests/project/analyze-path/command-item-events.test.js
node --test dist/tests/runtime/command-item-pending.test.js
node dist/src/cli.js src --coverage
node dist/evals/run.js \
  --repo legend-music=/path/to/legend-music \
  --repo excalidraw=/path/to/excalidraw \
  --repo expensify=/path/to/expensify \
  --repo formbricks=/path/to/formbricks \
  --repo outline=/path/to/outline \
  --repo open-webui-react-native=/path/to/open-webui-react-native \
  --repo hoalu=/path/to/hoalu
```

For the before/after minimal repro, build the tested base and this branch separately, copy this
branch's emitted `dist/tests/project/analyze-path/command-item-events.test.js` into the base's same
emitted test path, then run `node --test --test-name-pattern='source-forwarded item selection'
 dist/tests/project/analyze-path/command-item-events.test.js` in each checkout. The base reports the
missing event proof; this branch passes. The complete base suite was run before adding that
reproduction file. Temporary mutation checks ran in a separate emitted-output copy and never
changed the branch's source or corpus run.
