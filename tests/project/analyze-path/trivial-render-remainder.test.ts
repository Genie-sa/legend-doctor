import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function urlControl({ header = "", hooks = "" } = {}): string {
  return `
    import { useEffect, useState } from "react";
    import { Heading } from "./heading";
    import { Heavy, Rows, Stamp, useSaved } from "./heavy";
    export function UrlControl({ id, url }: { id: string; url: string }) {
      ${hooks}
      const [draft, setDraft] = useState(url);
      useEffect(() => {
        setDraft(url);
      }, [id, url]);
      return (
        <div className="section">
          ${header}
          <div className="label">page url</div>
          <label className="editor">
            <span>url</span>
            <input aria-label="Page URL" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
        </div>
      );
    }
  `;
}

const HEADING = `
  export function Heading({ title }: { title: string }) {
    return <h2 className="heading">{title}</h2>;
  }
`;

const HEAVY = `
  import { useEffect, useState } from "react";
  export function useSaved(): boolean {
    const [saved, setSaved] = useState(false);
    useEffect(() => setSaved(true), []);
    return saved;
  }
  export function Heavy() {
    const saved = useSaved();
    return <section>{saved ? "saved" : "draft"}</section>;
  }
  const ROWS = ["a", "b", "c"];
  export function Rows() {
    return <ul>{ROWS.map((row) => <li key={row}>{row}</li>)}</ul>;
  }
  export function Stamp() {
    return <time>{new Date().toISOString()}</time>;
  }
`;

async function draftAction(control: string): Promise<HookFinding["action"]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-trivial-remainder-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app" }), "utf8");
    await writeFile(path.join(root, "heading.tsx"), HEADING, "utf8");
    await writeFile(path.join(root, "heavy.tsx"), HEAVY, "utf8");
    await writeFile(path.join(root, "control.tsx"), control, "utf8");
    const report = await analyzePath(root);
    const finding = report.findings.find(
      (candidate) => candidate.hook === "useState" && candidate.name === "draft",
    );
    assert.ok(finding, "missing state draft");
    return finding.action;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("keeps state whose owner renders only a trivial remainder outside the leaf", async () => {
  assert.equal(await draftAction(urlControl()), "keep-state");
  assert.equal(await draftAction(urlControl({ header: `<Heading title="Link" />` })), "keep-state");
});

test("keeps the cut when the owner render it skips does unproven work", async () => {
  const unproven = {
    "custom hook": urlControl({ hooks: "const saved = useSaved();" }),
    "hook-calling child": urlControl({ header: "<Heavy />" }),
    "repeating child": urlControl({ header: "<Rows />" }),
    "child with unproven call": urlControl({ header: "<Stamp />" }),
    "unproven call": urlControl({ header: `<p>{new Date().toISOString()}</p>` }),
  };
  for (const [work, control] of Object.entries(unproven)) {
    assert.equal(await draftAction(control), "use-observable", work);
  }
});
