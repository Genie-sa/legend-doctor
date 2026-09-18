import { act, createElement as jsx } from "react";
import type { ReactElement } from "react";
import assert from "node:assert/strict";
import { mountDom } from "../../src/runtime/dom.js";
import { observable } from "@legendapp/state";
import test from "node:test";
import { useValue } from "@legendapp/state/react";

for (const strict of [false, true]) {
  test(`a category-only subscription cut can leave a sibling calendar year stale (strict=${strict})`, async (context) => {
    const beforeMidnight = new Date(2025, 11, 31, 23, 59, 59).getTime();
    const afterMidnight = new Date(2026, 0, 1, 0, 0, 1).getTime();
    const ui = mountDom(context, strict);
    context.mock.timers.enable({ apis: ["Date"], now: beforeMidnight });
    const kind$ = observable("all");

    // Hoalu's source-visible DateFilterView derives Calendar.endMonth from the render clock.
    const DatePanel = ({ id }: { id: string }): ReactElement => {
      // eslint-disable-next-line house/no-ambient-nondeterminism -- The test fixes and advances Date through context.mock.timers.
      const currentYear = new Date().getFullYear();
      const endMonth = new Date(currentYear + 2, 11);
      return jsx("output", { id }, String(endMonth.getFullYear()));
    };
    const CategorySlot = ({ active }: { active: boolean }): ReactElement | null => {
      const kind = useValue(kind$);
      return active ? jsx("span", null, kind) : null;
    };
    const Before = (): ReactElement => {
      const kind = useValue(kind$);
      const categoryActive = false;
      return jsx(
        "section",
        null,
        categoryActive ? jsx("span", null, kind) : null,
        jsx(DatePanel, { id: "before" }),
      );
    };
    const After = (): ReactElement =>
      jsx("section", null, jsx(CategorySlot, { active: false }), jsx(DatePanel, { id: "after" }));

    await ui.render(jsx("main", null, jsx(Before), jsx(After)));
    const before = ui.element("#before");
    const after = ui.element("#after");
    assert.equal(before.textContent, "2027");
    assert.equal(after.textContent, "2027");
    context.mock.timers.setTime(afterMidnight);
    await act(() => kind$.set("expense"));
    assert.equal(ui.element("#before"), before);
    assert.equal(ui.element("#after"), after);
    assert.equal(before.textContent, "2028", "the original owner refreshes its mounted date panel");
    assert.equal(after.textContent, "2027", "the category-only leaf cannot refresh the sibling");
  });
}
