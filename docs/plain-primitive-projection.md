# Primitive projection proof

`select-primitive-projection` finds a render that subscribes to a whole observable value only to compare it with one
render-stable operand, and moves the comparison into the subscription:

```tsx
function Row({ trackId }: { trackId: string }) {
  const id = useValue(active$);
  const selected = id === trackId;
  return <div data-selected={selected} />;
}
```

becomes

```tsx
function Row({ trackId }: { trackId: string }) {
  const selected = useValue(() => active$.get() === trackId);
  return <div data-selected={selected} />;
}
```

`Row` then renders only when the boolean flips instead of on every `active$` change. In a list of rows keyed by
identity, changing the active id re-renders the two rows whose selection flips; the selector itself still runs once
per row, so selection work stays linear. The edit keeps the callee the source calls (`useValue`, `use$`,
`useSelector`, or an alias) and the comparison's operand order.

When the sole comparison initializes a `const` in the owner body, that `const` becomes the selector's binding and its
declaration is deleted. Otherwise the selector gets a fresh name (`activeMatches` or `activeDiffers`, and
`hasItem` or `missingItem` against `null`/`undefined`) and every comparison is replaced with it. A finding keeps its
instruction but omits edits when the removed range holds a comment, and is withheld when the fresh name is already
used in the file.

## Proof

Every condition must hold; a missing proof yields no finding.

1. **Subscription.** A `const` declares the raw value from a one-argument `useValue`-family call without type
   arguments or annotation, directly in the body of a synchronous component or hook that no `observer` wraps. The
   argument is a proven observable path. Bindings are proven per declaration: module and imported observables, a
   typed props parameter (`({ a$ }: Props)`, `const { a$ } = props`, `const a$ = props.a$` when `props` is never
   reassigned), and a `const` destructure of a context-reader hook whose `createContext<T>` type argument declares the
   member as an `Observable`. A `?? fallback`, a `let` binding, a shadowed hook, or an untyped or union-typed member
   stays unproven.
2. **Confinement.** Every owner reference to the raw value is one side of the same `===` or `!==` comparison against
   the same operand. Loose `==`/`!=` is accepted only against `null` or `undefined`. The one other reference allowed
   is an entry in the dependency list of an effect that the comparison guards: the comparison is `!==`, the effect
   callback starts with `if (raw !== operand) return;`, returns no cleanup, and lists the operand (a literal operand
   needs no entry). Listing the boolean in place of the raw value then skips only the reruns in which the raw value
   changed while the operand did not. A changed value cannot strictly equal an unchanged operand both times, so every
   skipped run would have returned at the guard. The edit replaces the dependency entry with the selector's binding.
3. **Stable operand.** The operand is fixed for the render: a literal, a parameter or prop that is never assigned, a
   `const` declared before the subscription, or a module constant, optionally through a static property path.
4. **Domain.** The observable holds objects or at least three primitive values, taken from its declared type or its
   widened seed. A boolean or a two-member literal union cannot keep the comparison while changing, so it removes no
   render.
5. **No other render on the same change.** The owner has no overlapping subscription or observer `get()` on a
   related path and no dependency-free effect, and no visible parent re-renders it on the same path. Every hook the
   owner calls is known: React's owner-local hooks, Legend's selector and non-rendering hooks, or a context read
   (`useContext`, `use`, or a reader hook) whose every `<Context.Provider>` passes a mount-stable value, meaning a
   ref, an owned observable, a state setter, a module binding, or a `useMemo`/`useCallback` over such values. An
   unresolved custom hook could subscribe to the same path or run an effect on every render, so it blocks the
   finding. Single-file analysis sees no provider and proves no context.
6. **No stale render reads.** Dropped renders are the ones where the raw value changes but the comparison does not.
   For a primitive, that only happens on the unequal side, so a ref, `peek()`, or untracked `get()` read in render is
   allowed only under a test of the comparison's equal side (`if (selected)`, `selected && …`, or the true branch
   of `selected ? … : …`). Object domains allow none, since an in-place change keeps identity.

## Truthiness

The same action selects `!!x$.get()` when every read of the raw value keeps only its truthiness:

```tsx
const dragged = useValue(dragged$);
return <div className={dragged ? "on" : "off"}>{dragged && <Badge />}</div>;
```

becomes

```tsx
const hasDragged = useValue(() => !!dragged$.get());
return <div className={hasDragged ? "on" : "off"}>{hasDragged && <Badge />}</div>;
```

A read keeps only truthiness under `!`, `Boolean()`, an `if`, loop, or ternary condition, or as an operand of `&&`
or `||` whose result is itself tested. `!!raw` and `Boolean(raw)` are replaced whole; a sole `const shown = !!raw`
becomes the selector's binding, and otherwise the binding is `hasRaw`. A `{raw && …}` JSX child renders `raw` when it
is falsy, so it is accepted only when the domain holds no `0`, `NaN`, `""`, or `0n`, where JSX renders the falsy value
as text while `false` renders nothing. Any other read, including an effect dependency, blocks the finding.

The domain must hold objects or more than one truthy value, so a change can leave the boolean unchanged; a boolean or
`"a" | null` removes no render. Conditions 1 and 5 above apply unchanged, and no ref, `peek()`, or untracked `get()`
render read is allowed, since dropped renders fall on both sides of the test.
`tests/runtime/truthiness-projection.test.ts` shows one object replacing another renders the raw owner and not the
projected one, with identical markup at every step.

## Runtime evidence

`tests/runtime/plain-primitive-projection.test.ts` mounts 500 keyed rows under React 19.2.8 and Legend State
3.0.0-beta.48 in jsdom. Changing the active id renders 500 raw rows against 2 projected rows (1,000 against 4 under
StrictMode). Prop updates stay live through the inline selector and keep mount identity.

`tests/runtime/context-row-selector.test.ts` runs 200 rows in both modes:

- rows that read the observable from a context with a memoized provider value render 200 raw against 2 projected;
- a provider that subscribes to the same observable and rebuilds its value keeps all 200 rows rendering even when
  projected, which is why the rule requires a mount-stable provider value;
- a `!== null` projection renders no row when one dragged object replaces another;
- a render write under `if (isSelected)` still tracks the selected row.

## Corpus

The one enforced projection is a truthiness selector at junto's `App.tsx:306`, where every canvas switch sets one
non-empty `canvasName` over another and App reads it only as `!canvasName`. `evals/research/plain-primitive-projection.json` records the
audited research sites at the Legend Music pin. Its `DroppableZone` compares `activeDropZone` and `draggedItem` exactly
as the reorder-controls package did before the upstream fix. Legend Music's provider, however, subscribes to
`activeDropZone$` and rebuilds its context value on every render, so every zone renders anyway and the rule abstains.
In the expert replay, the reorder-controls parent tree memoizes its provider value, and the rule reproduces the
expert's edit at `DroppableZone.tsx:40`. In the junto replay, the file, group, link, and text canvas nodes read
`editNodeId` only in an effect that returns unless it equals `node.id`, starts editing, and clears it. The rule's
`editNodeId !== node.id` selectors are the negation of the maintainer's four, with the same `node.id` dependency, so
an edit request renders only its target.

The earlier, narrower phase of this rule is documented in [the before/after evidence](plain-projection-before-after.md)
and [the test ledger](plain-projection-test-ledger.md).
