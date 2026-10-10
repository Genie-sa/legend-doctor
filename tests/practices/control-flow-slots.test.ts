import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

function moveDownMessage(slot: string, initial = "false"): string {
  const finding = analyzeLegendPractices({
    sourceText: `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen({ view }) {
      const value$ = useObservable(${initial});
      const value = useValue(value$);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        ${slot}
      </main>;
    }
  `,
    fileName: "fixture.tsx",
  }).find((candidate) => candidate.location.line === 5);
  assert.equal(requireValue(finding).action, "move-use-value-down");
  return requireValue(finding).message;
}

test("moves a ternary slot's subscription into Show", () => {
  assert.match(
    moveDownMessage("{value ? <Dialog /> : null}"),
    /^Replace the complete conditional JSX slot at line 9 with `<Show if=\{value\$\}>\{\(\) => <Dialog \/>\}<\/Show>` and remove the owner's `useValue\(value\$\)`/u,
  );
  assert.match(
    moveDownMessage("{!value ? <Dialog /> : <Spinner />}"),
    /`<Show if=\{\(\) => !value\$\.get\(\)\} else=\{\(\) => <Spinner \/>\}>\{\(\) => <Dialog \/>\}<\/Show>`/u,
  );
});

test("tracks a branch read inside Show's child function when the condition does not narrow it", () => {
  assert.match(
    moveDownMessage('{view === "category" && <CategoryFilter kind={value} />}', '"all"'),
    /`<Show if=\{\(\) => view === "category"\}>\{\(\) => <CategoryFilter kind=\{value\$\.get\(\)\} \/>\}<\/Show>`/u,
  );
});

test("keeps the wrapper when Show would change what the slot renders or tracks", () => {
  for (const slot of [
    "{value && <Badge />}",
    "{value ? <Row item={value} /> : null}",
    "{value || <Placeholder />}",
  ]) {
    const message = moveDownMessage(slot);
    assert.doesNotMatch(message, /<Show/u, slot);
    assert.match(message, /always-mounted wrapper/u, slot);
  }
});
