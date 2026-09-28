import type { AnalysisReport, LegendPracticeFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const CHILDREN = `
  import { memo } from "react";
  import { observer, reactive } from "@legendapp/state/react";
  interface RowProps { onPick?: () => void; style?: object; label?: string; children?: unknown }
  export const Row = memo(function Row({ label }: RowProps) {
    return <div>{label}</div>;
  });
  export const ObservedRow = observer(function ObservedRow({ label }: RowProps) {
    return <div>{label}</div>;
  });
  export const ComparedRow = memo(
    function ComparedRow({ label }: RowProps) {
      return <div>{label}</div>;
    },
    (previous, next) => previous.label === next.label,
  );
  export const ReactiveRow = reactive(function ReactiveRow({ label }: RowProps) {
    return <div>{label}</div>;
  });
  export function PlainRow({ label }: RowProps) {
    return <div>{label}</div>;
  }
  export default memo(function DefaultRow({ label }: RowProps) {
    return <div>{label}</div>;
  });
`;

const HOOKS = `
  import { createContext, useContext, useMemo, useState } from "react";
  export const ThemeContext = createContext({ tone: "dark" });
  export function useTheme() {
    return useContext(ThemeContext);
  }
  export function useCounter() {
    const [count, setCount] = useState(0);
    return { count, increment: () => setCount(count + 1), setCount };
  }
  export function useOptions() {
    return { dense: true };
  }
  export function useLabel(prefix: string) {
    return useMemo(() => \`\${prefix}:label\`, [prefix]);
  }
`;

const IMPORTS = `
  import { useCallback, useMemo, useReducer, useState } from "react";
  import { observable } from "@legendapp/state";
  import { useValue } from "@legendapp/state/react";
  import DefaultRow, { ComparedRow, ObservedRow, PlainRow, ReactiveRow, Row } from "./rows";
  import { ReRow } from "./barrel";
  import { useCounter, useLabel, useOptions, useTheme } from "./hooks";
  const STYLE = { color: "red" };
  const list$ = observable({ items: [] as string[], limit: 3 });
  declare function lookup(): object;
`;

const MEMO_ACTION = "stabilize-memo-prop";

interface OwnerScan {
  readonly findings: readonly LegendPracticeFinding[];
  readonly report: AnalysisReport;
  readonly source: string;
}

function owner(body: string, signature = "{ id }: { id: string }"): string {
  return `${IMPORTS}\nexport function Owner(${signature}) {\n${body}\n}\n`;
}

async function scanOwner(
  body: string,
  extraFiles: Readonly<Record<string, string>> = {},
  signature?: string,
): Promise<OwnerScan> {
  let scanned: OwnerScan | null = null;
  const source = owner(body, signature);
  await withProject(
    {
      "package.json": JSON.stringify({ name: "app" }),
      "src/barrel.ts": `export { Row as ReRow } from "./rows";\n`,
      "src/hooks.ts": HOOKS,
      "src/owner.tsx": source,
      "src/rows.tsx": CHILDREN,
      ...extraFiles,
    },
    async (root) => {
      const report = await analyzePath(root);
      scanned = {
        findings: report.practices.filter((practice) => practice.action === MEMO_ACTION),
        report,
        source,
      };
    },
  );
  assert.ok(scanned);
  return scanned;
}

function lineOf(scan: OwnerScan, snippet: string, occurrence = 1): number {
  let index = -1;
  for (let seen = 0; seen < occurrence; seen += 1) {
    index = scan.source.indexOf(snippet, index + 1);
    assert.notEqual(index, -1, snippet);
  }
  return scan.source.slice(0, index).split("\n").length;
}

function onlyFinding(scan: OwnerScan): LegendPracticeFinding {
  assert.equal(scan.findings.length, 1, JSON.stringify(scan.findings, null, 2));
  const [finding] = scan.findings;
  assert.ok(finding);
  return finding;
}

const TOGGLE = `
  const [open, setOpen] = useState(false);
`;
const TOGGLE_BUTTON = `<button onClick={() => setOpen(!open)}>{open ? "close" : "open"}</button>`;

test("proves an inline callback re-renders a memo child on every unrelated state write", async () => {
  const scan = await scanOwner(`
    ${TOGGLE}
    return (
      <main>
        ${TOGGLE_BUTTON}
        <Row onPick={() => console.log(id)} style={STYLE} />
      </main>
    );
  `);
  const finding = onlyFinding(scan);
  assert.equal(finding.disposition, "change");
  assert.equal(finding.confidence, "certain");
  assert.equal(finding.practice, "memoization");
  assert.equal(finding.location.file, "src/owner.tsx");
  assert.equal(finding.location.line, lineOf(scan, "<Row onPick"));
  assert.match(finding.message, /`<Row>` is wrapped in `memo`, but `onPick` is recreated/u);
  assert.match(
    finding.message,
    new RegExp(`each \`open\` \\(line ${lineOf(scan, "const [open")}\\) update re-renders it`, "u"),
  );
  assert.match(finding.message, /Wrap `onPick` in useCallback\./u);
  assert.ok(finding.evidence.some((line) => line.includes("in src/rows.tsx")));
});

test("stable identities leave a memo child alone", async () => {
  const scan = await scanOwner(`
    ${TOGGLE}
    const pick = useCallback(() => console.log(id), [id]);
    const style = useMemo(() => ({ id }), [id]);
    const [, dispatch] = useReducer((value: number) => value + 1, 0);
    return (
      <main>
        ${TOGGLE_BUTTON}
        <Row onPick={pick} style={STYLE} label={id} />
        <Row onPick={dispatch} style={style} label={\`\${id}!\`} />
        <Row label="static">text</Row>
      </main>
    );
  `);
  assert.deepEqual(scan.findings, []);
});

test("names the memo to repair when a useMemo has no dependencies or a fresh one", async () => {
  const scan = await scanOwner(`
    ${TOGGLE}
    const unkeyed = useMemo(() => ({ id }));
    const options = { id };
    const rekeyed = useMemo(() => ({ ...options }), [options]);
    return (
      <main>
        ${TOGGLE_BUTTON}
        <Row style={unkeyed} />
        <Row style={rekeyed} />
      </main>
    );
  `);
  const [unkeyed, rekeyed] = scan.findings;
  assert.ok(unkeyed && rekeyed);
  assert.equal(unkeyed.disposition, "change");
  assert.equal(rekeyed.disposition, "change");
  assert.ok(
    unkeyed.message.includes(
      `Give the memo at line ${lineOf(scan, "useMemo(() => ({ id }))")} a dependency list.`,
    ),
  );
  assert.ok(
    rekeyed.message.includes(
      `Stabilize the dependency the memo at line ${lineOf(scan, "useMemo(() => ({ ...options })")} recreates`,
    ),
  );
});

test("suggests module scope for an allocation that reads nothing from the render", async () => {
  const finding = onlyFinding(
    await scanOwner(`
      ${TOGGLE}
      return <main>${TOGGLE_BUTTON}<Row style={{ margin: 4 }} onPick={() => setOpen(true)} /></main>;
    `),
  );
  assert.equal(finding.disposition, "change");
  assert.match(finding.message, /Move `style` to module scope; wrap `onPick` in useCallback\./u);
});

test("an owner without its own state or subscription never renders the child alone", async () => {
  const scan = await scanOwner(`
    return <main><Row onPick={() => console.log(id)} style={{ id }} /></main>;
  `);
  assert.deepEqual(scan.findings, []);
});

test("a write the element reads changes its props anyway", async () => {
  const scan = await scanOwner(`
    ${TOGGLE}
    return (
      <main>
        ${TOGGLE_BUTTON}
        <Row onPick={() => console.log(open)} />
        {open && <Row onPick={() => console.log(id)} />}
        <Row>
          <span>{open ? "on" : "off"}</span>
        </Row>
      </main>
    );
  `);
  assert.deepEqual(scan.findings, []);
});

test("components that compare props themselves or never memoize are not memo-busted", async () => {
  const scan = await scanOwner(`
    ${TOGGLE}
    return (
      <main>
        ${TOGGLE_BUTTON}
        <ComparedRow onPick={() => console.log(id)} />
        <ReactiveRow onPick={() => console.log(id)} />
        <PlainRow onPick={() => console.log(id)} />
      </main>
    );
  `);
  assert.deepEqual(scan.findings, []);
});

test("resolves observer, default-exported, and re-exported memo components", async () => {
  const scan = await scanOwner(`
    ${TOGGLE}
    return (
      <main>
        ${TOGGLE_BUTTON}
        <ObservedRow onPick={() => console.log(id)} />
        <DefaultRow onPick={() => console.log(id)} />
        <ReRow onPick={() => console.log(id)} />
      </main>
    );
  `);
  assert.deepEqual(
    scan.findings.map((finding) => [finding.location.line, finding.disposition]),
    [
      [lineOf(scan, "<ObservedRow"), "change"],
      [lineOf(scan, "<DefaultRow"), "change"],
      [lineOf(scan, "<ReRow"), "change"],
    ],
  );
  assert.match(scan.findings[0]?.message ?? "", /wrapped in `observer`/u);
});

test("the React Compiler gate disables the rule and reports it", async () => {
  const scan = await scanOwner(
    `
      ${TOGGLE}
      return <main>${TOGGLE_BUTTON}<Row onPick={() => console.log(id)} /></main>;
    `,
    {
      "package.json": JSON.stringify({
        devDependencies: { "babel-plugin-react-compiler": "1.0.0" },
        name: "app",
      }),
    },
  );
  assert.deepEqual(scan.findings, []);
  const gate = scan.report.capabilities.disabledRules.find((rule) => rule.rule === "memo-props");
  assert.equal(gate?.reason, "react-compiler");
  assert.ok((gate?.files ?? 0) > 0);
});

test("a spread of the owner's props keeps identity; an unseen spread leaves a candidate", async () => {
  const scan = await scanOwner(
    `
      ${TOGGLE}
      const extra = lookup();
      return (
        <main>
          ${TOGGLE_BUTTON}
          <Row {...props} onPick={() => console.log(props.id)} />
          <Row {...extra} onPick={() => console.log(props.id)} />
        </main>
      );
    `,
    {},
    "props: { id: string }",
  );
  assert.deepEqual(
    scan.findings.map((finding) => finding.disposition),
    ["change", "candidate"],
  );
  assert.match(scan.findings[1]?.message ?? "", /`\.\.\.extra` is shown to keep its identity/u);
});

test("follows project hooks to the values they return", async () => {
  const scan = await scanOwner(`
    ${TOGGLE}
    const theme = useTheme();
    const { count, setCount } = useCounter();
    const label = useLabel(id);
    const options = useOptions();
    return (
      <main>
        ${TOGGLE_BUTTON}
        <Row style={theme} label={label} onPick={() => setCount(1)} />
        <Row label={\`\${count}\`} style={options} onPick={() => console.log(id)} />
      </main>
    );
  `);
  const [proven, unproven] = scan.findings;
  assert.equal(proven?.disposition, "change", JSON.stringify(proven, null, 2));
  assert.equal(unproven?.disposition, "candidate");
  assert.ok(
    unproven?.evidence.some((line) =>
      line.includes("a hook result that allocates on every render"),
    ),
  );
});

test("a handler that also writes read state leaves only a candidate", async () => {
  const scan = await scanOwner(`
      const [open, setOpen] = useState(false);
      const [count, setCount] = useState(0);
      const toggle = () => {
        setOpen(!open);
        setCount(count + 1);
      };
      return (
        <main>
          <button onClick={toggle}>{open ? "close" : "open"}</button>
          <Row label={\`\${count}\`} onPick={() => console.log(id)} />
        </main>
      );
    `);
  const finding = onlyFinding(scan);
  assert.equal(finding.disposition, "candidate");
  assert.ok(
    finding.message.includes(
      `some write of \`open\` (line ${lineOf(scan, "const [open")}) is shown to change nothing else`,
    ),
  );
});

test("reports the outer element when its fresh children hold another memo-busted element", async () => {
  const scan = await scanOwner(`
      ${TOGGLE}
      return (
        <main>
          ${TOGGLE_BUTTON}
          <Row label={id}>
            <Row onPick={() => console.log(id)} />
          </Row>
        </main>
      );
    `);
  const finding = onlyFinding(scan);
  assert.equal(finding.location.line, lineOf(scan, "<Row label={id}>"));
  assert.match(finding.message, /`children` is recreated/u);
});

test("selectors keep identity only for stored reads and primitives", async () => {
  const scan = await scanOwner(`
    ${TOGGLE}
    const limit = useValue(() => list$.limit.get() > 2);
    const items = useValue(() => list$.items.get());
    const visible = useValue(() => list$.items.get().filter(Boolean));
    return (
      <main>
        ${TOGGLE_BUTTON}
        <Row label={\`\${limit}\`} style={items} onPick={() => console.log(id)} />
        <Row style={visible} onPick={() => console.log(id)} />
      </main>
    );
  `);
  assert.deepEqual(
    scan.findings.map((finding) => finding.disposition),
    ["change", "candidate"],
  );
  assert.ok(scan.findings[1]?.evidence.some((line) => line.includes("a selector result")));
});
