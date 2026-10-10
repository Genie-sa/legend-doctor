# React Compiler hook-name audit — October 10, 2026

Rules: `replace-legacy-use-value`, `use-value-for-render-read`, `snapshot-mutated-use-value`. Analysis baseline:
`2355fd9`. No pin, target, or label changed.

## Compiler facts

babel-plugin-react-compiler 1.0 gives hook semantics only to names matching `/^use[A-Z0-9]/` (`isHookName` in
`HIR/Environment.ts`). An imported binding is a hook when its imported or local name passes; a namespace member when
its property name passes. Every other call is an ordinary call, which the Compiler memoizes when its value escapes into
the returned output, keyed on its operands by reference. Legend State's React API page says `use$` was not compatible
with the Compiler, and its migration guide says the Compiler breaks `observer` with render `get()` for the same reason.

`src/core/react-compiler-units.ts` mirrors which functions the default `infer` mode compiles (`Entrypoint/Program.ts`):
a component by name that calls a hook or creates JSX with valid props parameters and a node return, a hook by name
that calls a hook or creates JSX, a `memo` or `forwardRef` callback, or a function with a `"use memo"` directive. The
outermost candidate compiles; class bodies never do. A prologue `"use no memo"` in the file or the function, or an
ESLint suppression of `react-hooks/exhaustive-deps` or `react-hooks/rules-of-hooks` (a next-line comment inside the
function, a block disable anywhere in the file), keeps it uncompiled. A function passed inline to `observer` has no
name the Compiler reads, so it is not compiled.

Not modeled: a `compilationMode` other than `infer`, custom directives or suppression rules, a `sources` filter, and
Compiler bailouts on validation errors. Each of them compiles less, so the rename stays safe where a `change` overstates
the risk.

## Dispositions

| Finding                                                                                     | Before       | After                   |
| ------------------------------------------------------------------------------------------- | ------------ | ----------------------- |
| `use$` or `Namespace.use$` in a compiled unit                                               | `style`      | `change`                |
| `useSelector`, or an alias whose imported or local name passes the test                     | `style`      | `style`                 |
| Render `get()` inside `observer` in a compiled unit whose value reaches the returned output | `style`/none | `change`                |
| A method chain on a raw `useValue` result, or a call receiving it, in a compiled unit       | none         | `change` or `candidate` |

## Per-application deltas

Hooks are unchanged in every application. Practice findings from `node dist/src/cli.js <repo>` at the base and head
builds:

| Application                                                                                                                                                                                                       | Delta                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| legend-music                                                                                                                                                                                                      | `snapshot-mutated-use-value` candidate +1 (`Sidebar.tsx:62`)                                        |
| legend-apps                                                                                                                                                                                                       | `snapshot-mutated-use-value` candidate +1 (`apps/music/src/components/MediaLibrary/Sidebar.tsx:60`) |
| excalidraw, expensify, formbricks, outline, open-webui-react-native, hoalu, legend-photos, noutube, nori, gptme, zenborg, junto, fractals, social-app, fontsource, campus-rallye, bbplayer, and the private slice | 0                                                                                                   |

Both candidates are the same component. The `push` at `Sidebar.tsx:92` runs in a handler that also calls
`setTempPlaylistId`, and `tempPlaylistId` is captured by both memoized `playlists.map` calls, so the update that
mutates the array also recomputes them. That masking keeps them `candidate`, as the September 28 audit kept the
`TrackList.tsx` memo. No compiled application in the corpus calls `use$` or reads `get()` inside a compiled `observer`
unit, so no `change` appears.
