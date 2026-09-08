import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

const WRAPPER = `
  import { useRender as renderElement } from "@base-ui/react/use-render";
  import { mergeProps as combine } from "@base-ui/react/merge-props";
  export function Button({ render, ...props }) {
    const defaults = { type: render ? undefined : "button" };
    return renderElement({ defaultTagName: "button", props: combine(defaults, props), render });
  }
`;

const CHROME =
  "<header /><nav /><aside /><section /><article /><footer /><hr /><p /><p /><p /><p /><p />";

function screen(attributes: string): string {
  return `
    import { useState } from "react";
    import { Button } from "./Button";
    export function Screen({ overrides, customRender }) {
      const [pending, setPending] = useState(false);
      const submit = async () => {
        setPending(true);
        try { await save(); } finally { setPending(false); }
      };
      return <main>${CHROME}<Button disabled={pending} onClick={submit} ${attributes} /></main>;
    }
  `;
}

const CASES = [
  {
    name: "escaped event override",
    attributes: "",
    wrapper: WRAPPER.replace(
      "combine(defaults, props)",
      String.raw`combine(defaults, props, { on\u0043lick: null })`,
    ),
    action: "review-state",
  },
  { name: "default DOM rendering", attributes: "", wrapper: WRAPPER, action: "use-observable" },
  {
    name: "null event override",
    attributes: "",
    wrapper: WRAPPER.replace(
      "combine(defaults, props)",
      "combine(defaults, props, { onClick: null })",
    ),
    action: "review-state",
  },
  {
    name: "prevented event",
    attributes: "",
    wrapper: WRAPPER.replace(
      "combine(defaults, props)",
      "combine(defaults, props, { onClick: event => event.preventBaseUIHandler() })",
    ),
    action: "review-state",
  },
  {
    name: "ignored sixth argument",
    attributes: "",
    wrapper: WRAPPER.replace("combine(defaults, props)", "combine({}, {}, {}, {}, {}, props)"),
    action: "review-state",
  },
  {
    name: "prototype event override",
    attributes: "",
    wrapper: WRAPPER.replace(
      "combine(defaults, props)",
      "combine(defaults, props, { __proto__: { onClick: null } })",
    ),
    action: "review-state",
  },
  {
    name: "constant event override",
    attributes: "",
    wrapper: WRAPPER.replace(
      "const defaults =",
      "const overrides = { onClick: null }; const defaults =",
    ).replace("combine(defaults, props)", "combine(defaults, props, overrides)"),
    action: "review-state",
  },
  {
    name: "custom element",
    attributes: "render={<Unknown />}",
    wrapper: WRAPPER,
    action: "review-state",
  },
  {
    name: "custom renderer",
    attributes: "render={customRender}",
    wrapper: WRAPPER,
    action: "review-state",
  },
  {
    name: "unknown spread",
    attributes: "{...overrides}",
    wrapper: WRAPPER,
    action: "review-state",
  },
  {
    name: "lookalike import",
    attributes: "",
    wrapper: WRAPPER.replace("@base-ui/react/use-render", "./lookalike"),
    action: "review-state",
  },
  {
    name: "eager merge function",
    attributes: "",
    wrapper: WRAPPER.replace(
      "combine(defaults, props)",
      "combine(props, previous => { previous.onClick(); return previous; })",
    ),
    action: "review-state",
  },
  {
    name: "render default",
    attributes: "",
    wrapper: WRAPPER.replace("{ render, ...props }", "{ render = Unknown, ...props }"),
    action: "review-state",
  },
  {
    name: "render reassignment",
    attributes: "",
    wrapper: WRAPPER.replace("const defaults", "render = Unknown; const defaults"),
    action: "review-state",
  },
  {
    name: "escaped event props",
    attributes: "",
    wrapper: WRAPPER.replace("const defaults", "consume(props); const defaults"),
    action: "review-state",
  },
] as const;

for (const scenario of CASES) {
  test(`Base UI pending command: ${scenario.name}`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-use-render-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "Button.tsx"), scenario.wrapper);
    await writeFile(path.join(root, "Screen.tsx"), screen(scenario.attributes));
    const report = await analyzePath(root);
    const finding = requireValue(report.findings.find((entry) => entry.name === "pending"));
    assert.equal(finding.action, scenario.action, finding.message);
  });
}
