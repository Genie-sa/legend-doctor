---
"legend-doctor": patch
---

Add the `#!/usr/bin/env node` shebang to the CLI entry point. Without it the `legend-doctor` bin was handed to
`/bin/sh`, so `npx legend-doctor` failed with a syntax error on the first import.
