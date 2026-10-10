---
"legend-doctor": minor
---

Give every finding and practice a stable `id` (`file::owner::subject::action`, numbered when repeated) and bump the report to `schemaVersion` 8, so scans and the GitHub Action compare one finding at a time across edits elsewhere in a file. Skip a file that fails to parse or analyze instead of failing the whole scan, and list it under `skippedFiles` with its phase; name the file and phase in `scan_failed` reports. Write Action outputs in delimited form so a path cannot reopen a blocking gate.

Support only the latest React, React Native, and Legend State v3. Scans no longer resolve older renderer or Legend versions.
