import { applyFindingEdits, assertVerifiedEdits, practiceFindings } from "./edit-assertions.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";
import { typecheckDiagnostics } from "./typecheck.js";

test("migrates every legacy call and its import in one shared rewrite", () => {
  const source = `import { observable } from "@legendapp/state";
import { use$, useSelector } from "@legendapp/state/react";

const profile$ = observable({ first: "", last: "", name: "" });

export function Profile() {
  const name = useSelector(profile$.name);
  const first = use$(() => profile$.first.get());
  const full = useSelector(() => profile$.first.get() + profile$.last.get());
  return <p>{name}{first}{full}</p>;
}
`;
  const findings = practiceFindings(source, "replace-legacy-use-value");
  assert.equal(findings.length, 3);
  assert.ok(findings.every((finding) => finding.edits === findings[0]?.edits));
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const profile$ = observable({ first: "", last: "", name: "" });

export function Profile() {
  const name = useValue(profile$.name);
  const first = useValue(profile$.first);
  const full = useValue(() => profile$.first.get() + profile$.last.get());
  return <p>{name}{first}{full}</p>;
}
`,
    findings,
  );
});

test("shares the imported useValue with a render read in the same file", () => {
  const source = `import { observable } from "@legendapp/state";
import { useSelector, useValue } from "@legendapp/state/react";

const state$ = observable({ count: 0, label: "", title: "" });

export function Counter() {
  const title = useValue(state$.title);
  const count = state$.count.get();
  const label = useSelector(state$.label);
  return <p>{title}{count}{label}</p>;
}
`;
  const findings = analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: source });
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-value-for-render-read", "replace-legacy-use-value"],
  );
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const state$ = observable({ count: 0, label: "", title: "" });

export function Counter() {
  const title = useValue(state$.title);
  const count = useValue(state$.count);
  const label = useValue(state$.label);
  return <p>{title}{count}{label}</p>;
}
`,
    findings,
  );
});

test("names the imported legacy hook in a render read without an edit the migration would strand", () => {
  const source = `import { observable } from "@legendapp/state";
import { useMount, useSelector } from "@legendapp/state/react";

declare function track(): void;

const state$ = observable({ count: 0, label: "" });

export function Counter() {
  useMount(track);
  const count = state$.count.get();
  const label = useSelector(state$.label);
  return <p>{count}{label}</p>;
}
`;
  const findings = analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: source });
  const [renderRead] = findings;
  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-value-for-render-read", "replace-legacy-use-value"],
  );
  assert.match(renderRead?.message ?? "", /with `useSelector\(state\$\.count\)`/u);
  assert.equal(renderRead?.edits, undefined);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useMount, useValue } from "@legendapp/state/react";

declare function track(): void;

const state$ = observable({ count: 0, label: "" });

export function Counter() {
  useMount(track);
  const count = state$.count.get();
  const label = useValue(state$.label);
  return <p>{count}{label}</p>;
}
`,
    findings,
  );
});

test("removes legacy specifiers when useValue is already imported", () => {
  const source = `import { observable } from "@legendapp/state";
import {
  useSelector,
  useValue,
} from "@legendapp/state/react";

const profile$ = observable({ first: "", name: "" });

export function Profile() {
  const name = useValue(profile$.name);
  const first = useSelector(profile$.first);
  return <p>{name}{first}</p>;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import {
  useValue,
} from "@legendapp/state/react";

const profile$ = observable({ first: "", name: "" });

export function Profile() {
  const name = useValue(profile$.name);
  const first = useValue(profile$.first);
  return <p>{name}{first}</p>;
}
`,
    practiceFindings(source, "replace-legacy-use-value"),
  );
});

test("renames namespace legacy calls in place", () => {
  const source = `import { observable } from "@legendapp/state";
import * as LegendReact from "@legendapp/state/react";

const profile$ = observable({ name: "" });

export function Profile() {
  const name = LegendReact.use$(() => profile$.name.get());
  return <p>{name}</p>;
}
`;
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import * as LegendReact from "@legendapp/state/react";

const profile$ = observable({ name: "" });

export function Profile() {
  const name = LegendReact.useValue(profile$.name);
  return <p>{name}</p>;
}
`,
    practiceFindings(source, "replace-legacy-use-value"),
  );
});

test("keeps legacy migrations prose-only when the binding escapes or useValue is taken", () => {
  for (const source of [
    `import { observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";

const profile$ = observable({ name: "" });

export const select = useSelector;

export function Profile() {
  const name = useSelector(profile$.name);
  return <p>{name}</p>;
}
`,
    `import { observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";

const profile$ = observable({ name: "" });

export function useValue(): number {
  return 1;
}

export function Profile() {
  const name = useSelector(profile$.name);
  return <p>{name}</p>;
}
`,
  ]) {
    const findings = practiceFindings(source, "replace-legacy-use-value");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.edits, undefined);
    assert.deepEqual(typecheckDiagnostics(applyFindingEdits(source, findings)), []);
  }
});
