import { assertVerifiedEdits, practiceFindings } from "./edit-assertions.js";
import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

test("keeps render-read instructions prose-only when the installed Legend State has no useValue", () => {
  const findings = analyzeLegendPractices({
    fileName: "fixture.tsx",
    installedLegendState: {
      source: "installed",
      syncExport: "available",
      useValueExport: "missing",
      version: "3.0.0-alpha.1",
    },
    sourceText: `import { observable } from "@legendapp/state";
import { useMount } from "@legendapp/state/react";

declare function track(): void;

const counter$ = observable({ count: 0 });

export function Counter() {
  useMount(track);
  const count = counter$.count.get();
  return <p>{count}</p>;
}
`,
  });
  assert.deepEqual(
    findings.map((finding) => [finding.action, finding.edits]),
    [["use-value-for-render-read", undefined]],
  );
});

test("passes the observable itself to useValue", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Profile() {
  const name = useValue(() => profile$.name.get());
  const email = useValue<string>(profile$.email.get());
  return <p>{name}{email}</p>;
}
`;
  const findings = practiceFindings(source, "pass-observable-to-use-value");
  assert.equal(findings.length, 2);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Profile() {
  const name = useValue(profile$.name);
  const email = useValue<string>(profile$.email);
  return <p>{name}{email}</p>;
}
`,
    findings,
  );
});

test("leaves a useValue input unedited when the rewrite would drop a comment or an assertion", () => {
  const findings = practiceFindings(
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Profile() {
  const name = useValue(() => /* tracked */ profile$.name.get());
  const email = useValue(() => profile$.email!.get());
  return <p>{name}{email}</p>;
}
`,
    "pass-observable-to-use-value",
  );
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.edits === undefined));
});

test("renames snapshot reads to peek in effects, handlers, and observer initializers", () => {
  const source = `import { observable } from "@legendapp/state";
import { observer } from "@legendapp/state/react";
import { useEffect, useState } from "react";

declare function persist(value: unknown): void;

const settings$ = observable({ open: false, theme: "light" });

export const Settings = observer(function Settings() {
  const [initial] = useState(() => settings$.theme.get());
  useEffect(() => {
    persist(settings$.open.get());
  }, []);
  return <button onClick={() => persist(settings$.theme.get())}>{initial}</button>;
});
`;
  const findings = practiceFindings(source, "use-peek-for-snapshot");
  assert.deepEqual(
    findings.map((finding) => finding.disposition),
    ["change", "style", "style"],
  );
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { observer } from "@legendapp/state/react";
import { useEffect, useState } from "react";

declare function persist(value: unknown): void;

const settings$ = observable({ open: false, theme: "light" });

export const Settings = observer(function Settings() {
  const [initial] = useState(() => settings$.theme.peek());
  useEffect(() => {
    persist(settings$.open.peek());
  }, []);
  return <button onClick={() => persist(settings$.theme.peek())}>{initial}</button>;
});
`,
    findings,
  );
});

test("subscribes a render initializer with useValue, adding it beside an existing Legend import", () => {
  const source = `import { observable } from "@legendapp/state";
import { useMount } from "@legendapp/state/react";

declare function track(): void;

const counter$ = observable({ count: 0 });

export function Counter() {
  useMount(track);
  const count = counter$.count.get();
  return <p>{count}</p>;
}
`;
  const findings = practiceFindings(source, "use-value-for-render-read");
  assert.equal(findings.length, 1);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useMount, useValue } from "@legendapp/state/react";

declare function track(): void;

const counter$ = observable({ count: 0 });

export function Counter() {
  useMount(track);
  const count = useValue(counter$.count);
  return <p>{count}</p>;
}
`,
    findings,
  );
});

test("reuses an existing useValue import for every render initializer in the file", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue as useLegendValue } from "@legendapp/state/react";

const counter$ = observable({ count: 0, label: "", step: 1 });

export function Counter() {
  const step = useLegendValue(counter$.step);
  const count = counter$.count.get();
  return <p>{count * step}</p>;
}

export function useLabel(): string {
  const label = counter$.label.get();
  return label;
}
`;
  const findings = practiceFindings(source, "use-value-for-render-read");
  assert.equal(findings.length, 2);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue as useLegendValue } from "@legendapp/state/react";

const counter$ = observable({ count: 0, label: "", step: 1 });

export function Counter() {
  const step = useLegendValue(counter$.step);
  const count = useLegendValue(counter$.count);
  return <p>{count * step}</p>;
}

export function useLabel(): string {
  const label = useLegendValue(counter$.label);
  return label;
}
`,
    findings,
  );
});

test("keeps render-read instructions prose-only when the new hook or its import is not exact", () => {
  const findings = practiceFindings(
    `import { observable } from "@legendapp/state";

const counter$ = observable({ count: 0, label: "" });

export function Label({ hidden }: { hidden: boolean }) {
  if (hidden) {
    return null;
  }
  const label = counter$.label.get();
  return <p>{label}</p>;
}

export function Counter() {
  const count = counter$.count.get();
  return <p>{count}</p>;
}

export function Rows({ rows }: { rows: string[] }) {
  return <ul>{rows.map((row) => <li key={row}>{counter$.label.get()}</li>)}</ul>;
}
`,
    "use-value-for-render-read",
  );
  assert.equal(findings.length, 3);
  assert.ok(findings.every((finding) => finding.edits === undefined));
});

test("narrows a single-property destructure to the leaf subscription", () => {
  const source = `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Name() {
  const { name } = useValue(profile$);
  return <p>{name}</p>;
}

export function Title() {
  const { email: title } = useValue(profile$);
  return <h1>{title}</h1>;
}
`;
  const findings = practiceFindings(source, "narrow-use-value-subscription");
  assert.equal(findings.length, 2);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Name() {
  const name = useValue(profile$.name);
  return <p>{name}</p>;
}

export function Title() {
  const title = useValue(profile$.email);
  return <h1>{title}</h1>;
}
`,
    findings,
  );
});

test("leaves narrowing prose-only when an annotation or a read path shapes the binding", () => {
  const findings = practiceFindings(
    `import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const profile$ = observable({ email: "", name: "" });

export function Name() {
  const { name }: { name: string } = useValue(profile$);
  return <p>{name}</p>;
}

export function Email() {
  const profile = useValue(profile$);
  return <p>{profile.email}</p>;
}
`,
    "narrow-use-value-subscription",
  );
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.edits === undefined));
});
