# legend-doctor

## 0.1.1

### Patch Changes

- 81bbfe8: Add the `#!/usr/bin/env node` shebang to the CLI entry point. Without it the `legend-doctor` bin was handed to
  `/bin/sh`, so `npx legend-doctor` failed with a syntax error on the first import.

## 0.1.0

### Minor Changes

- 08395f0: Initial public release: proof-based React hook triage for Legend State, with agent-answerable review questions, a
  repo-discovered confirmations file, ranked questions, and a jsdom verification harness.
