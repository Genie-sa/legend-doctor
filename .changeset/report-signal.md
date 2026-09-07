---
"legend-doctor": patch
---

Hide reviews no answer could convert from `--actionable`. A review finding with no assumption has no
question to answer, so nothing can turn it into an edit; the flag now reports one entry per edit as
documented, and the full report still carries every finding.

Merge research pointers that land on the same line. Chaining a second fact often reaches a line the
first fact already named, so the two asks join into one step instead of listing the line twice.
