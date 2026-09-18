# Subscription owner projection risks

The pinned Legend Music labels retain the three expected subscription cuts:
`PlaybackArea.tsx:29`, `PlaybackArea.tsx:31`, and `VisualizerWindow.tsx:13`, at
`59d02afc11d6b27bc53ddecf1a69501626f8487f`. The source audit identifies independent class-name
composition and numeric formatting as the blockers. Class wrapper names and application paths
are not proof inputs.

| Risk | Protected contract                                                   | Trigger and oracle                                                                                                                                                       | Narrowest test surface                                                                    |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| P1   | Pure independent formatting must not block a proven subscription cut | A separately subscribed number is formatted with the unshadowed global `String`; the unrelated leaf can move                                                             | `subscription-owner-projections.test.ts`                                                  |
| P2   | Source-visible class wrappers require safe argument evaluation       | Getter, mutation, hidden call, mutable read, or an aliased effect in a class condition must prevent relocation even when its result is a string                          | `owner-class-evaluation.test.ts`, `subscription-owner-projections.test.ts`                |
| P3   | Primitive facts stay attached to their lexical bindings              | An inner block shadows a numeric subscription result or its alias with a coercible object; the analyzer must not recommend the unrelated cut                             | `independent-subscription-shadow.test.ts`                                                 |
| P4   | Primitive facts stay attached to the observable receiver             | A prop shadows a module observable with an object-valued observable; formatting can now invoke object coercion and must prevent relocation                               | `independent-subscription-receiver.test.ts`, `independent-subscription-coercion.test.ts`  |
| P5   | Nested prop reads require source data provenance                     | A second caller supplies a getter-capable object, or the component/prop escapes source analysis; class evaluation must remain unproven                                   | `component-prop-data.test.ts`                                                             |
| P6   | Preserve the existing owner-work guard                               | A sibling date panel reads the clock during render, so moving only the category subscription can leave its displayed year stale                                          | `subscription-child-clock.test.ts` analysis/runtime tests and pinned Hoalu research label |
| P7   | Distinguish command origins from actual captured reads               | A pending flag written but never read by a deferred callback asks for origin proof; a real deferred read retains snapshot guidance                                       | `async-origin-diagnostics.test.ts` and pinned Outline label                               |
| P8   | Preserve work in parameter defaults                                  | A timestamp default runs before the body and must still refresh on the owner update; unsafe defaults and nested destructuring cannot authorize new projection exemptions | `independent-subscription-parameters.test.ts`, class caller fixtures                      |

The independent numeric and class-wrapper positive fixtures failed before the detector changes.
The result/alias shadow fixtures failed against the first, overly broad independent-flow union and
passed after ambiguous bindings were excluded. Further review found receiver shadowing and unsafe
class argument evaluation; their regression evidence is retained with the PR validation artifacts.
The receiver counterexample supplies an object-valued observable whose `toString()` reads a mutable label.
An unrelated subscription update refreshes that label in the original owner, while the unsafe relocation
leaves it stale. It runs in normal and StrictMode. A parameter timestamp default also failed before the new guard and passed afterward. The Hoalu counterexample uses a controlled clock and runs in normal and StrictMode without
remounting the displayed output. Outline's label correction changes no analyzer action.

These tests protect the enumerated proof boundaries. They do not claim universal JavaScript purity,
native performance measurements, or a proof for unknown package implementations. The class helper
summary remains bounded to its existing imported composition contracts; other wrappers abstain.
