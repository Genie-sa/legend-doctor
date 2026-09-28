# Lockfile Legend State version audit — September 28, 2026

Capability change: when no `@legendapp/state` package is installed, the analysis root's nearest lockfile answers for its
version. A lockfile that pins one version maps it to the exports every published release was checked for: 2.x exports
neither `useValue` nor `./sync`; every `3.0.0` alpha and beta exports `./sync`; `useValue` first ships in
`3.0.0-beta.35`, as `useSelector as useValue`, and stays an alias through `3.0.0-beta.48`. Newer or unlisted versions stay
`unknown`. Analysis baseline: `8b12c53`. No pin or target changed.

The pinned checkouts carry no `node_modules`, so every rule gated on the installed package ran ungated before this
change, including `replace-legacy-use-value` and `plain-primitive-projection`. Users with installed dependencies already
saw the gated output.

## Versions per pinned application

| Repository              | Lockfile            | Version         | `useValue` | `./sync`  |
| ----------------------- | ------------------- | --------------- | ---------- | --------- |
| legend-music            | `bun.lock`          | `3.0.0-beta.42` | alias      | available |
| legend-photos           | `bun.lock`          | `3.0.0-beta.30` | missing    | available |
| hoalu                   | `pnpm-lock.yaml`    | `3.0.0-beta.47` | alias      | available |
| open-webui-react-native | `package-lock.json` | `2.1.15`        | missing    | missing   |
| excalidraw              | `yarn.lock`         | none            | —          | —         |
| expensify               | `package-lock.json` | none            | —          | —         |
| formbricks              | `pnpm-lock.yaml`    | none            | —          | —         |
| outline                 | `yarn.lock`         | none            | —          | —         |

## Retired labels

| Pinned source                                                  | Audit                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| legend-photos, 39 `replace-legacy-use-value` sites             | `3.0.0-beta.30` has no `useValue` export; applying the replacement fails to compile. Legacy `useSelector` is correct. |
| open-webui-react-native `form-chat-input/component.tsx:79, 80` | `2.1.15` has no `useValue` export. The target keeps its hook labels; any practice finding there fails as unexpected.  |

legend-music `windowDimensions.tsx:40` keeps its label with `disposition: "style"`: at `3.0.0-beta.42` the rename changes
no subscription.

## Per-application deltas

| Application             | Delta                                                |
| ----------------------- | ---------------------------------------------------- |
| legend-music            | `replace-legacy-use-value` change 1 → 0, style 0 → 1 |
| legend-photos           | `replace-legacy-use-value` change 39 → 0             |
| hoalu                   | 0                                                    |
| open-webui-react-native | `replace-legacy-use-value` change 17 → 0             |
| excalidraw              | 0                                                    |
| expensify               | 0                                                    |
| formbricks              | 0                                                    |
| outline                 | 0                                                    |

Four unpinned Legend-native applications resolve `3.0.0-beta.43` through `3.0.0-beta.48` from `bun.lock`. All four are
unchanged, because their legacy calls were already `style`, and no rule is gated on those versions.
