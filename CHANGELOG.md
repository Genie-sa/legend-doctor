# legend-doctor

## 0.4.0

### Minor Changes

- 622044c: Report unavailable imported implementation edges with `--coverage`, and add candidate reviews for additional dependencies read by synchronous local helpers. Keep these reviews outside actionable output and optimization precision.

  Classify same-value selector simplifications as style, and preserve async results, tracking options, literal property semantics, and read order by abstaining when equivalence is unproven.

## 0.3.0

### Minor Changes

- 035ffe0: Add coordinated subscription plans, workspace-aware callback analysis, and actionable transition review guidance. Preserve render snapshots, lifecycle timing, and atomic updates when recommending optimizations.

## 0.2.0

### Minor Changes

- f366842: Preserve renders that refresh mutable data and committed values captured at mount. Bound expression flow, lower try/catch/finally conservatively, and keep hidden helper writes uncertain.

  Group repeated research instructions with complete site counts, report group conversion counts, and tag compact findings only when the tier changes their outcome.

  Report schema 4 removes unused semantic diagnostics and APIs; coverage schema 2 contains parser, lowering, and detector stages. Compact scans compare final findings with broad mode using the same parsed source.

### Patch Changes

- f4db5df: Stop treating a rebound hook name as React's hook. Recognition matched the imported name anywhere in
  the file, so an injected or destructured `useState` in a closer scope still read as React state — and
  `delete-unused-state` reported a proven `change` that would have deleted an unrelated call. A call now
  reaches the import only when no enclosing scope rebinds the name.

## 0.1.3

### Patch Changes

- d1c962b: Hide reviews no answer could convert from `--actionable`. A review finding with no assumption has no
  question to answer, so nothing can turn it into an edit; the flag now reports one entry per edit as
  documented, and the full report still carries every finding.

  Merge research pointers that land on the same line. Chaining a second fact often reaches a line the
  first fact already named, so the two asks join into one step instead of listing the line twice.

## 0.1.2

### Patch Changes

- b782176: Stop effects from waiting on a state that can never change. A `useState` with no setter binding is a
  component-lifetime constant, so it is no longer treated as a reactive dependency; effects that read one now name
  the state whose ownership is actually open.

  Report `const [, setTick] = useState(0)` as the forced render it is, naming the setter, instead of calling the
  binding a non-standard `[value, setter]` tuple.

  Correct the `--materiality` help text and README: the 12-element bar applies to cuts proven by owner size, and
  cuts proven by a transported read or a hook owner do not use it.

## 0.1.1

### Patch Changes

- 81bbfe8: Add the `#!/usr/bin/env node` shebang to the CLI entry point. Without it the `legend-doctor` bin was handed to
  `/bin/sh`, so `npx legend-doctor` failed with a syntax error on the first import.

## 0.1.0

### Minor Changes

- 08395f0: Initial public release: proof-based React hook triage for Legend State, with agent-answerable review questions, a
  repo-discovered confirmations file, ranked questions, and a jsdom verification harness.
