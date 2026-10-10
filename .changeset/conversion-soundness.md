---
"legend-doctor": patch
---

Keep object and array state out of leaf and call-site cuts: Legend skips notifying a structurally equal object replacement, so a leaf could keep passing the previous reference, and leaves that receive object values may not compare them by identity. Hold every observable conversion back when a write runs inside a transition that a same-module, imported, or child-component callee starts. Keep returned and conditional call-site wraps from changing which fiber mounts when another arm or return renders the same type in the same slot. Prove class-name and style calls by their `clsx`/`tailwind-merge`/`cva`/`StyleSheet.create` bindings instead of by name, and block read-only projections on receivers proven to be user objects. Stop treating a setter listed in a hook dependency array as an escape.
