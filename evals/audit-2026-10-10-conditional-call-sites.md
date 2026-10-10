# Conditional and keyed call-site audit — October 10, 2026

A leaf transport can now wrap a conditional or keyed call site once its mount identity is proven. No pin or target
changed.

## What changed

A transport call site under `&&`, a ternary arm, or a key used to block the owner-side leaf transport and the per-site
subscription verdicts with `mount-identity-unproven`. Each such site now qualifies when three facts hold:

- **Guards stay in the owner.** No condition or left operand that decides the mount reads the state, so the wrapper
  mounts and unmounts in the same commit the child did.
- **The key keeps its meaning.** A key that does not read the state stays on the child, the wrapper's only child,
  where a change still remounts it. A keyed element inside a render callback is one of an array's siblings, so it
  abstains.
- **The type change keeps every fiber.** `typeChangeKeepsMountIdentity` finds no other ternary arm or return that
  places a same-typed element along the same chain of child slots. `||` and `??` operands abstain.

A conditional or keyed site also needs a state that stays primitive, as the slot verdict does: Legend skips an equal
object replacement, so a leaf could keep passing a stale reference. `move-state-down` still blocks on any conditional
call site, because a state moved into a conditionally mounted wrapper would reset each time the condition hides it.

## Measurement

Before implementing, 271 `mount-identity-unproven` findings across formbricks, outline, excalidraw, Expensify,
social-app, gptme, zenborg, and junto were classified by the shapes of their transport call sites. In 153 every site
sits under guards and keys that do not read the state (24 of them beside another return), 62 have a guard or key that
reads the state, 20 reach rows inside `.map`, 8 have same-typed ternary arms, 6 sit in other callbacks, and 3 in a `||`
or `??` operand. 19 have no transport site: the subtree's own lifetime blocks them. Only four findings had mount
identity as their only blocker; the rest also wait on a child contract or a render cut.

After the change, 159 of the 271 move to their next real blocker: 158 to `child-contract-unresolved` and one to
`atomic-transition-unproven`. 111 remain, and one converts.

## Corpus deltas

| App        | Finding                                       | Before                      | After                           |
| ---------- | --------------------------------------------- | --------------------------- | ------------------------------- |
| formbricks | `PreviewSurvey` `isModalOpen` (unlabeled)     | `mount-identity-unproven`   | `use-observable`                |
| Expensify  | `ReportCardLostPage` `shouldShowAddressError` | `use-observable` (enforced) | review, label `enforced: false` |
| Expensify  | `ReportCardLostPage` `shouldShowReasonError`  | `use-observable` (enforced) | review, label `enforced: false` |

`isModalOpen` reaches two `Modal` call sites, each in a ternary whose other arm renders a `div` or a `MediaBackground`,
and the component's other return renders a fragment, so a wrapper keeps every fiber.

The `ReportCardLostPage` flags were converted before without any mount check. Both `isReasonConfirmed` arms are
fragments that place `FormAlertWithSubmitButton` in the same child slot, so React keeps that fiber across the step
change. Giving each arm a wrapper type of its own would remount it, and only one wrapper type shared by both arms keeps
it, so both labels are now non-enforced. Every other pinned app is unchanged.

Corpus abstentions for `mount-identity-unproven` fall from 138 to 53.
