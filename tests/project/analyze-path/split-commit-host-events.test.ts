import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const REACT_18 = JSON.stringify({
  dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
  name: "app",
});

const COMPONENTS = {
  "field.tsx": `
export function Field({ onChange }: { onChange: () => void }) {
  return <input onChange={onChange} />;
}
`,
  "input.tsx": `
import styled from "styled-components";

const Input = styled.input\`
  border: 0;
\`;

export default Input;
`,
  "uploader.tsx": `
import { read } from "./read";

export function Uploader({ onUpload }: { onUpload: () => void }) {
  return <div onDrop={(event) => void read(event).then(onUpload)} />;
}
`,
};

async function originVerdict(element: string): Promise<string | undefined> {
  const board = `
import { useState } from "react";
import { Field } from "./field";
import Input from "./input";
import { report } from "./report";
import { Uploader } from "./uploader";

export function Board() {
  const [dragging, setDragging] = useState(false);
  const [origin, setOrigin] = useState("");
  const startDrag = () => {
    setDragging(true);
  };
  const move = () => {
    setOrigin("top");
    startDrag();
  };
  report(dragging);
  return (
    <section>
      <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
      <p>{origin}</p>
      ${element}
    </section>
  );
}
`;
  let verdict: string | undefined = undefined;
  await withProject(
    { "board.tsx": board, "package.json": REACT_18, ...COMPONENTS },
    async (root) => {
      const report = await analyzePath(root);
      const origin = report.findings.find(
        (finding) => finding.hook === "useState" && finding.name === "origin",
      );
      verdict = origin?.abstentionReason ?? origin?.action;
    },
  );
  return verdict;
}

test("React 18 commits co-writes once through a component that forwards the prop to a host element", async () => {
  for (const element of [`<Input onChange={move} />`, `<Field onChange={move} />`]) {
    assert.equal(await originVerdict(element), "use-observable", element);
  }
});

test("React 18 splits co-writes that a component calls outside its host event", async () => {
  assert.equal(await originVerdict(`<Uploader onUpload={move} />`), "atomic-transition-unproven");
});
