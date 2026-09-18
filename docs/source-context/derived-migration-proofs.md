# Computed memo migration proof boundary

This phase repairs research items 1 and 2 from the audit of
`378977306448c0fc3d0326dbc986f0f6e082b622`. A primitive result is only candidate discovery;
it is neither a purity summary nor evidence of equality suppression.

## Enforced boundary

`derive-computed-observable` is `change` only when all of these structural proofs hold:

- Existing confinement checks establish one direct, option-free `useValue` dependency,
  with no consumption outside the memo and its dependency array.
- The callback is an expression or a block containing exactly one return. Its result
  compares that input with a same-domain literal using `===` or `!==`. The total-expression
  grammar contains no calls, property access, coercive operators, writes, or suspension.
- The observable has stable module `const` identity, created directly by the imported
  Legend `observable` factory. Its value is a broad string or number, established by a
  literal initializer/static object property or an explicit root `string`/`number` type
  argument. Assertions, narrow unions, aliases, imported roots, mutable roots, owner-local
  factories, props, accessors, spreads, and prototype-setting object literals are not proofs.
- The owner is a capitalized module-local function component with an actual JSX use and
  no non-JSX references in the same source. Lowercase intrinsic tags are not component calls.
  Files containing explicit JSX factory/runtime/import-source/fragment directives stay candidates.
  The owner has no parameters, exports, wrapper/alias escapes, effects, ref work, extra declarations,
  or render statements. It returns intrinsic JSX with literal/derived-value expressions;
  custom children, refs, customized built-ins, spreads, and function-valued props need review.

A broad string/number domain contains two distinct values unequal to the literal, so a
transition between those values preserves the boolean result. The rule proves that class
of render saving, not that a particular application's update trace exercises it. Parent
renders are unaffected. Only the boolean consumer is retained; no input snapshots or
atomic multi-input transitions are rewritten.

Other previously discovered primitive memos remain `candidate` with an explicit missing
proof and an instruction to retain the React memo. Earlier discovery exclusions (for
example owner captures or separate raw-value consumers) still abstain entirely. Local and
imported helpers, even apparently pure built-ins or shadowed globals, are not summarized.
No `peek()` substitution is used to disguise a dependency change. Exported consumers and
observer wrappers require a separate ownership proof. Plain-const projections are outside
this phase.

## Evidence and risk ledger

| Risk                       | Regression evidence                                                                                  | Protected boundary                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Hidden dependency          | Module helper reads a second observable; original stays `true`, migration becomes `false`            | Unproven calls are candidates                                 |
| No equality saving         | String suffix across `a → b → c → d`: 3 renders before and after, 6 in StrictMode                    | Primitive output does not imply savings                       |
| Supported suppression      | Strict comparison on the same sequence: 3 → 1 renders, 6 → 2 in StrictMode                           | Preserve proven many-to-one cases and host identity           |
| Commit/ref snapshot loss   | `a → b` leaves comparison false; original effect publishes `b` and ref updates, migration skips both | Owner purity must be proven separately                        |
| Identity drift             | Prop/local observable controls; aliases/wrappers/exports require review                              | Do not retain a mount-time observable across identity changes |
| Impurity/abrupt completion | Imported/local calls, writes, throws, scheduling, coercion, accessors, shadowed globals              | No inferred tracking or evaluation equivalence                |
| Equality edges             | NaN, repeated NaN, signed zero, infinity, boolean inversion, narrow unions                           | Boolean primitive category alone is insufficient              |

The first two detector regressions were observed failing on the original implementation
(`change` instead of `candidate`) before the detector was edited. Runtime tests use the
installed React 19.2.8 / Legend State 3.0.0-beta.48 and jsdom, in normal mode and StrictMode.
They establish DOM behavior and render counts, not native performance or device timings.

`evals/research/derived-migration.json` records manually audited non-enforced boundaries at
the pinned Legend Music commit. Sidebar's inputs have other consumers; TrackItem already
selects booleans. Neither is misrepresented as the synthetic helper defect or as an
implemented optimization. Scored labels and pins are unchanged.

## Initial phase validation

- `npm run check` passed: lint, formatting, typecheck, build, all 996 tests (including runtime
  tests), and package dry run. The final focused suite passed all 24 tests.
- Temporarily bypassing the owner gate in generated JavaScript made the owner-effect
  regression fail (`change` instead of `candidate`). The generated file was restored;
  the focused suite passed again. No mutation remains in source or generated output.
- Doctor ran on `src --coverage` before edits and after validation: both scans completed
  with zero hooks/findings/practices. This checks scanner execution, not React correctness.
- The complete seven-app pinned corpus ran before and after. Its output is identical:
  1,236 hooks / 237 targets, 508/523 hook labels, 67/71 practice labels, 10/10 groups,
  and seven pre-existing failures. No new failures or changed dispositions occurred.

| Application             | Action deltas (all actions) | Disposition deltas (change / candidate / keep / style) |
| ----------------------- | --------------------------- | ------------------------------------------------------ |
| Legend Music            | 0                           | 0 / 0 / 0 / 0                                          |
| Excalidraw              | 0                           | 0 / 0 / 0 / 0                                          |
| Expensify               | 0                           | 0 / 0 / 0 / 0                                          |
| Formbricks              | 0                           | 0 / 0 / 0 / 0                                          |
| Outline                 | 0                           | 0 / 0 / 0 / 0                                          |
| Open WebUI React Native | 0                           | 0 / 0 / 0 / 0                                          |
| Hoalu                   | 0                           | 0 / 0 / 0 / 0                                          |

Neither corpus run emits a derived-computed practice; this phase changes only that rule.
The unchanged failures are Outline DocumentCopy's abstention reason, three missing Legend
Music relocation practices, one missing Hoalu relocation practice, and two unexpected
Legend Music relocation practices. They belong to the separately owned corpus/relocation
work and were not relabeled or repaired here.

Execution logs are retained at
`/Users/alialdhamen/.codex/artifacts/derived-migration-proofs-2026-09-19/`.

## Review follow-up: render and configuration boundaries

The first review found that comparison purity cannot establish owner commit equivalence;
that counterexample is covered by effect/layout-effect and ref-snapshot runtime controls.
The next review found two accepted cases without a proven React render boundary: lowercase
`<row />` syntax does not call a `row` function, and an explicit custom JSX factory can
perform arbitrary work. Both detector tests failed against the first commit before the
additional gates were added. Unused functions already remain candidates.

The deep test matrix enumerates the supported boundary rather than claiming exhaustive
proof of every TypeScript or React program:

| Boundary             | Accepted controls                                                                             | Rejected/unknown controls                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook provenance      | Aliases and namespaces for React/Legend imports                                               | Legacy `useSelector`/`use$`, foreign hooks, selector inputs, subscription options                                                            |
| Callback contract    | Expression, single-return block/function, reversed strict comparison, parentheses             | Helpers, scheduling, throws, coercion, constructors, globals, multiple statements, async/generator/parameterized callbacks                   |
| Dependency ownership | One confined direct subscription                                                              | Missing/duplicate dependency, extra memo arguments, event snapshots, mutable memo binding                                                    |
| Input domain         | Inferred and explicit broad strings/numbers, static child paths                               | Booleans, narrow unions, unknown generics, assertions, annotated/aliased/imported roots, accessors, spreads, prototype setters               |
| Equality benefit     | `===`/`!==` against a same-domain literal, normal and special numeric values                  | Injective suffix/arithmetic, self-comparison, unsupported truthiness projection                                                              |
| Render boundary      | Capitalized local component used through real JSX, pure intrinsic output                      | Lowercase/unused function, export/wrapper/alias escape, custom children, custom built-ins, refs, spreads, calls in JSX, explicit JSX pragmas |
| Lifecycle            | Same host node on supported updates; disposal stops computations; remount reads current value | Prop-observable swap reproduces retained original computed identity                                                                          |

Disposal/remount, prop identity, hidden-helper dependency, equality, and commit/ref tests run
with and without StrictMode. Legacy entry-point tests establish abstention, not cross-version
runtime compatibility. Only the installed React 19.2.8 / Legend State beta.48 combination is
executed. Other dependency versions, React Compiler transformations, concurrent scheduling,
and alternate JSX factories configured solely outside the source file are residual integration
limits; this source-local rule assumes the standard React JSX transform. Native custom children
are outside the enforced owner grammar. No universal speedup or exhaustive runtime proof is
claimed.

Follow-up validation also passed `npm run check` (1,004 tests) and all 32 focused tests.
Doctor completed before/after the follow-up. The second full seven-app corpus output is
byte-for-byte identical to the initial baseline, so the per-app table above and all seven
known failures remain unchanged. The real PR base is
`57c8020e70d718eabe57472f1dc9e618d0901f6a`; its only change since the audited starting
commit is `README.md`, verified with Git. The PR includes a separate concise before/after
evidence document and exact head SHA in its description.
