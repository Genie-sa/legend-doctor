# legend-doctor

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
