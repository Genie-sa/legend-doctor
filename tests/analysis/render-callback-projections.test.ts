import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("isolates a bounded pure projection in one uniquely selected repeated branch", () => {
  const finding = analyzeSource(
    `
    import { useState } from "react";
    export function Controls({ configured, windowWidth }: { configured: string[]; windowWidth: number }) {
      const [layoutWidth, setLayoutWidth] = useState(0);
      const setWidth = (nextWidth: number) => setLayoutWidth(previous =>
        Math.abs(previous - nextWidth) < 1 ? previous : nextWidth
      );
      const baseWidth = layoutWidth > 0 ? layoutWidth : windowWidth;
      const dropdownWidth = Math.max(baseWidth - 16, 320);
      const controls = configured.filter((control, index, array) => array.indexOf(control) === index);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside />
        <button onClick={() => setWidth(400)} />
        {controls.map(control => {
          switch (control) {
            case "search": return <Search key="search" width={dropdownWidth} />;
            case "save": return <Save key="save" />;
            default: return null;
          }
        })}
      </main>;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.name === "layoutWidth");
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /uniquely selected branch/u);
});

test("requires every proof for a uniquely selected repeated projection", () => {
  const source = `
    import { useState } from "react";
    export function Controls({ configured, windowWidth }: { configured: string[]; windowWidth: number }) {
      const [layoutWidth, setLayoutWidth] = useState(0);
      const setWidth = (nextWidth: number) => setLayoutWidth(nextWidth);
      const baseWidth = layoutWidth > 0 ? layoutWidth : windowWidth;
      const dropdownWidth = Math.max(baseWidth - 16, 320);
      const controls = configured.filter((control, index, array) => array.indexOf(control) === index);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside />
        <button onClick={() => setWidth(400)} />
        {controls.map(control => {
          switch (control) {
            case "search": return <Search key="search" width={dropdownWidth} />;
            case "save": return <Save key="save" />;
            default: return null;
          }
        })}
      </main>;
    }
  `;
  const unsafe = [
    source.replace(
      "const controls = configured.filter((control, index, array) => array.indexOf(control) === index);",
      "const controls = configured;",
    ),
    source.replace(
      "export function Controls({ configured, windowWidth }:",
      "export function Controls({ configured, windowWidth, Math }:",
    ),
    source.replace('key="search"', 'key="wrong"'),
    source.replace("const baseWidth", "let baseWidth"),
    source.replace("Math.max(baseWidth - 16, 320)", "clamp(baseWidth - 16, 320)"),
    source.replace("Math.max(baseWidth - 16, 320)", "Math.geometry.max(baseWidth - 16, 320)"),
    source.replace(
      "configured.filter((control, index, array) => array.indexOf(control) === index)",
      "configured.filter((control, index, array) => array.indexOf(control) === index).filter((control, index, array) => { array.push(control); return true; })",
    ),
    source.replace(
      "configured.filter((control, index, array) => array.indexOf(control) === index)",
      "configured.filter((control, index, array) => array.indexOf(control) === index).filter(control => inspect(control))",
    ),
    source.replace("switch (control) {", "controls.push(control); switch (control) {"),
    source
      .replace(
        "const controls = configured.filter",
        "const finalWidth = dropdownWidth; const renderedWidth = finalWidth; const controls = configured.filter",
      )
      .replace("width={dropdownWidth}", "width={renderedWidth}"),
    source.replace(
      `{controls.map(control => {
          switch (control) {
            case "search": return <Search key="search" width={dropdownWidth} />;
            case "save": return <Save key="save" />;
            default: return null;
          }
        })}`,
      `{controls.map(control => <Search key={control} width={dropdownWidth} />)}`,
    ),
  ];
  for (const candidate of unsafe) {
    const finding = analyzeSource(candidate, "fixture.tsx").find(
      (result) => result.name === "layoutWidth",
    );
    assert.notEqual(requireValue(finding).action, "use-observable");
  }
});

test("isolates a narrow projection inside a JSX child render callback", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [hovered, setHovered] = useState(false);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <Picker>{() => <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
          <Icon fill={hovered ? "green" : "gray"} /><Label />
        </div>}</Picker>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /leaf subscriber/u);
});

test("does not trust an unresolved event producer inside a JSX child render callback", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [hovered, setHovered] = useState(false);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <Picker>{() => <Wrapper onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}>
          <Icon fill={hovered ? "green" : "gray"} /><Label />
        </Wrapper>}</Picker>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("does not isolate a key projection inside a JSX child render callback", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [version, setVersion] = useState(0);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
        <Picker>{() => <div onClick={() => setVersion(value => value + 1)}>
          <Icon key={version} /><Label />
        </div>}</Picker>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("requires repeated projections to depend on a stable row key", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ rows }: { rows: Array<{ id: string }> }) {
        const [busy, setBusy] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          {rows.map(row => <Row key={row.id} disabled={!busy} onClick={() => setBusy(true)} />)}
        </main>;
      }
    `),
    ["review-state"],
  );
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ rows }: { rows: Array<{ id: string }> }) {
        const [selectedId, setSelectedId] = useState<string | null>(null);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          {rows.map((row, index) => <Row key={index} active={selectedId === row.id} onClick={() => setSelectedId(row.id)} />)}
        </main>;
      }
    `),
    ["review-state"],
  );
});

test("allows a keyed row projection to read the current key in its click command", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ rows }: { rows: Array<{ id: string }> }) {
      const [openId, setOpenId] = useState<string | null>(null);
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        {rows.map(row => <Row key={row.id} open={openId === row.id} onClick={() => setOpenId(openId === row.id ? null : row.id)} />)}
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /per-item/u);
});

test("does not move direct state when every write shares a mutation lifecycle", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const save = useSave();
        const [busy, setBusy] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <section>{busy ? "Saving" : "Ready"}<button onClick={async () => { setBusy(true); await save.mutateAsync(); setBusy(false); }} /></section>
        </main>;
      }
    `),
    ["review-state"],
  );
});

test("does not move controlled state from an owner that is already a small leaf", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Editor() { return null; }
      export function Screen() {
        const [value, setValue] = useState("");
        return <Editor value={value} onChange={setValue} />;
      }
    `),
    ["keep-state"],
  );
});

test("keeps conditional child state at the owner and rejects multiple instances", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Editor() { return null; }
      export function Screen({ show }: { show: boolean }) {
        const [value, setValue] = useState("");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          {show && <Editor value={value} onChange={setValue} />}
        </main>;
      }
    `),
    ["use-observable"],
  );
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Editor() { return null; }
      export function Screen() {
        const [value, setValue] = useState("");
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Editor value={value} onChange={setValue} /><Editor value={value} onChange={setValue} />
        </main>;
      }
    `),
    ["review-state"],
  );
});
