import type { ComponentType, ReactElement } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import { createElement as jsx, memo, useCallback, useState } from "react";
import assert from "node:assert/strict";
import { observer } from "@legendapp/state/react";
import test from "node:test";

interface RowProps {
  label: string;
  onPick: () => void;
  renders: Map<string, number>;
  style: { readonly color: string };
}

interface OwnerProps {
  label: string;
  renders: Map<string, number>;
}

type Row = ComponentType<RowProps>;

type Owner = (props: OwnerProps) => ReactElement;

interface OwnerVersions {
  readonly after: Owner;
  readonly before: Owner;
}

const ROW_STYLE = { color: "red" } as const;
const TOGGLES = 5;

function RowBody({ label, onPick, renders, style }: RowProps): ReactElement {
  count(renders, "row");
  return jsx("button", { id: "pick", onClick: onPick, style }, label);
}

const MemoRow = memo(RowBody);
const ObserverRow = observer(RowBody);

function owners(Row: Row): OwnerVersions {
  function Before({ label, renders }: OwnerProps): ReactElement {
    const [open, setOpen] = useState(false);
    const [picked, setPicked] = useState(0);
    return jsx(
      "section",
      null,
      jsx("button", { id: "toggle", onClick: () => setOpen(!open) }, open ? "close" : "open"),
      jsx("output", null, String(picked)),
      jsx(Row, {
        label,
        onPick: () => setPicked((value) => value + 1),
        renders,
        style: { color: "red" },
      }),
    );
  }
  function After({ label, renders }: OwnerProps): ReactElement {
    const [open, setOpen] = useState(false);
    const [picked, setPicked] = useState(0);
    const pick = useCallback(() => setPicked((value) => value + 1), []);
    return jsx(
      "section",
      null,
      jsx("button", { id: "toggle", onClick: () => setOpen(!open) }, open ? "close" : "open"),
      jsx("output", null, String(picked)),
      jsx(Row, { label, onPick: pick, renders, style: ROW_STYLE }),
    );
  }
  return { after: After, before: Before };
}

for (const strict of [false, true]) {
  for (const [wrapper, Row] of [
    ["memo", MemoRow],
    ["observer", ObserverRow],
  ] as const) {
    test(`stabilized props skip ${wrapper} child renders for unrelated owner state (strict=${strict})`, async (context) => {
      const ui = mountDom(context, strict);
      const outcomes = new Map<string, { html: string[]; rowRenders: number }>();
      const versions = owners(Row);
      for (const version of ["before", "after"] as const) {
        const Owner = versions[version];
        const renders = new Map<string, number>();
        const html: string[] = [];
        await ui.render(jsx(Owner, { label: "Row", renders }));
        renders.clear();
        for (let toggle = 0; toggle < TOGGLES; toggle += 1) {
          await ui.click("#toggle");
          html.push(ui.html());
        }
        const rowRenders = renders.get("row") ?? 0;
        await ui.click("#pick");
        assert.equal(ui.element("output").textContent, "1");
        html.push(ui.html());
        outcomes.set(version, { html, rowRenders });
        await ui.render(null);
      }
      const renderFactor = strict ? 2 : 1;
      assert.equal(outcomes.get("before")?.rowRenders, TOGGLES * renderFactor);
      assert.equal(outcomes.get("after")?.rowRenders, 0);
      assert.deepEqual(outcomes.get("after")?.html, outcomes.get("before")?.html);
    });
  }
}
