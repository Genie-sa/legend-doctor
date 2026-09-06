import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const OWNER_CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

function screen(children: readonly string[], imports: string): string {
  return `
    import { useState } from "react";
    ${imports}
    export function Screen() {
      const [busy, setBusy] = useState(true);
      const run = async () => { setBusy(false); await work(); };
      ${"\n".repeat(150)}
      const content = (
        <main>${OWNER_CHROME}<button onClick={run} />${children.join("")}</main>
      );
      return <Shell>{content}</Shell>;
    }
  `;
}

async function scan(files: Readonly<Record<string, string>>): Promise<HookFinding[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-leaf-forwarding-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, source]) =>
        writeFile(path.join(root, name), source, "utf8"),
      ),
    );
    const report = await analyzePath(path.join(root, "Screen.tsx"));
    return report.findings;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("proves leaf rendering through forwardRef children, one-hop forwarding, and rest spreads", async () => {
  const cases = {
    ForwardRefLeaf: [
      "ForwardRefLeaf.tsx",
      `
        import { forwardRef } from "react";
        export const ForwardRefLeaf = forwardRef<HTMLElement, { busy: boolean }>(({ busy }, ref) => (
          <section ref={ref} data-busy={busy}><span>{busy ? "Busy" : "Ready"}</span></section>
        ));
      `,
    ],
    ForwardingLeaf: [
      "ForwardingLeaf.tsx",
      `
        import { StatusLeaf } from "./StatusLeaf";
        export function ForwardingLeaf({ busy }: { busy: boolean }) {
          return <div className="frame"><StatusLeaf busy={busy} /></div>;
        }
      `,
    ],
    SpreadHostLeaf: [
      "SpreadHostLeaf.tsx",
      `
        export function SpreadHostLeaf({ className, ...props }: { className?: string; busy: boolean }) {
          return <section className={className} {...props} />;
        }
      `,
    ],
    SpreadForwardingLeaf: [
      "SpreadForwardingLeaf.tsx",
      `
        import { StatusLeaf } from "./StatusLeaf";
        export function SpreadForwardingLeaf({ className, ...props }: { className?: string; busy: boolean }) {
          return <div className={className}><StatusLeaf {...props} /></div>;
        }
      `,
    ],
  } satisfies Record<string, readonly [string, string]>;
  for (const [name, [file, source]] of Object.entries(cases)) {
    const findings = await scan({
      "StatusLeaf.tsx": `
        export function StatusLeaf({ busy }: { busy: boolean }) {
          return <section data-busy={busy}><span>{busy ? "Busy" : "Ready"}</span></section>;
        }
      `,
      [file]: source,
      "Screen.tsx": screen([`<${name} busy={busy} />`], `import { ${name} } from "./${name}";`),
    });
    assert.equal(findings[0]?.action, "use-observable", name);
    assert.match(findings[0]?.message ?? "", /child contract is verified/u, name);
  }
});

const EFFECT_LEAF = `
  import { useEffect } from "react";
  export function EffectLeaf({ busy }: { busy: boolean }) {
    useEffect(() => { document.title = String(busy); }, [busy]);
    return <section />;
  }
`;

test("abstains when the forwarded prop leaves host output or the receiver cannot be resolved", async () => {
  const cases = {
    EffectLeaf: ["EffectLeaf.tsx", EFFECT_LEAF],
    ForwardingToEffect: [
      "ForwardingToEffect.tsx",
      `
        import { EffectLeaf } from "./EffectLeaf";
        export function ForwardingToEffect({ busy }: { busy: boolean }) {
          return <div><EffectLeaf busy={busy} /></div>;
        }
      `,
    ],
    LibraryForwarding: [
      "LibraryForwarding.tsx",
      `
        import { Primitive } from "@vendor/primitives";
        export function LibraryForwarding({ className, ...props }: { className?: string; busy: boolean }) {
          return <Primitive className={className} {...props} />;
        }
      `,
    ],
    RestEscape: [
      "RestEscape.tsx",
      `
        export function RestEscape({ className, ...props }: { className?: string; busy: boolean }) {
          const merged = Object.assign({}, props);
          return <section className={className} {...merged} />;
        }
      `,
    ],
    RefParameterUsed: [
      "RefParameterUsed.tsx",
      `
        import { forwardRef } from "react";
        export const RefParameterUsed = forwardRef<HTMLElement, { busy: boolean }>((props, ref) => {
          const { busy } = props;
          return <section ref={ref} data-busy={busy} onClick={() => report(props)} />;
        });
      `,
    ],
  } satisfies Record<string, readonly [string, string]>;
  for (const [name, [file, source]] of Object.entries(cases)) {
    const findings = await scan({
      "EffectLeaf.tsx": EFFECT_LEAF,
      [file]: source,
      "Screen.tsx": screen([`<${name} busy={busy} />`], `import { ${name} } from "./${name}";`),
    });
    assert.equal(findings[0]?.action, "review-state", name);
  }
});

test("forwards the setter through the wrapper when the child calls it only after render", async () => {
  const toggle = `
    export function Toggle({ on, onToggle }: { on: boolean; onToggle: (next: boolean) => void }) {
      return <button data-on={on} onClick={() => onToggle(false)}>{on ? "On" : "Off"}</button>;
    }
  `;
  const findings = await scan({
    "Toggle.tsx": toggle,
    "Screen.tsx": `
      import { useState } from "react";
      import { Toggle } from "./Toggle";
      export function Screen() {
        const [busy, setBusy] = useState(true);
        const run = async () => { setBusy(false); await work(); };
        ${"\n".repeat(150)}
        const content = (
          <main>${OWNER_CHROME}<button onClick={run} /><Toggle on={busy} onToggle={setBusy} /></main>
        );
        return <Shell>{content}</Shell>;
      }
    `,
  });
  assert.equal(findings[0]?.action, "use-observable");
  assert.match(findings[0]?.message ?? "", /onToggle=\{\(next\) => busy\$\.set\(next\)\}/u);
});

test("keeps the setter transport under review when the child may call it during render or elsewhere", async () => {
  const cases = {
    EagerToggle: `
      export function EagerToggle({ on, onToggle }: { on: boolean; onToggle: (next: boolean) => void }) {
        if (!on) onToggle(true);
        return <button data-on={on}>{on ? "On" : "Off"}</button>;
      }
    `,
    SplitToggle: `
      export function SplitToggle({ on }: { on: boolean }) {
        return <button data-on={on}>{on ? "On" : "Off"}</button>;
      }
      export function Reset({ onReset }: { onReset: (next: boolean) => void }) {
        return <button onClick={() => onReset(false)}>Reset</button>;
      }
    `,
  } satisfies Record<string, string>;
  for (const [name, source] of Object.entries(cases)) {
    const usage =
      name === "SplitToggle"
        ? `<SplitToggle on={busy} /><Reset onReset={setBusy} />`
        : `<${name} on={busy} onToggle={setBusy} />`;
    const imports =
      name === "SplitToggle"
        ? `import { Reset, SplitToggle } from "./${name}";`
        : `import { ${name} } from "./${name}";`;
    const findings = await scan({
      [`${name}.tsx`]: source,
      "Screen.tsx": `
        import { useState } from "react";
        ${imports}
        export function Screen() {
          const [busy, setBusy] = useState(true);
          const run = async () => { setBusy(false); await work(); };
          ${"\n".repeat(150)}
          const content = (
            <main>${OWNER_CHROME}<button onClick={run} />${usage}</main>
          );
          return <Shell>{content}</Shell>;
        }
      `,
    });
    assert.equal(findings[0]?.action, "review-state", name);
  }
});

test("subscribes at a computed child prop when the child contract verifies the prop", async () => {
  const findings = await scan({
    "Badge.tsx": `
      export function Badge({ tone }: { tone: string }) {
        return <span className={tone}>{tone}</span>;
      }
    `,
    "Screen.tsx": `
      import { useState } from "react";
      import { Badge } from "./Badge";
      export function Screen() {
        const [count, setCount] = useState(0);
        ${"\n".repeat(150)}
        return (
          <main>${OWNER_CHROME}
            <p>{count}</p>
            <Badge tone={count > 3 ? "loud" : "quiet"} />
            <button onClick={() => setCount(count + 1)}>Add</button>
          </main>
        );
      }
    `,
  });
  assert.equal(findings[0]?.action, "use-observable");
  assert.match(findings[0]?.message ?? "", /computing tone/u);
});

test("treats the child's own React Native primitives as host output", async () => {
  const cases = {
    NativeLeaf: `
      import { Text, View } from "react-native";
      export function NativeLeaf({ busy }: { busy: boolean }) {
        return <View accessibilityState={{ busy }}><Text>{busy ? "Busy" : "Ready"}</Text></View>;
      }
    `,
    NativeSpreadLeaf: `
      import { Text } from "react-native";
      export function NativeSpreadLeaf({ style, ...props }: { style?: object; busy: boolean }) {
        return <Text style={style} {...props} />;
      }
    `,
  } satisfies Record<string, string>;
  for (const [name, source] of Object.entries(cases)) {
    const findings = await scan({
      [`${name}.tsx`]: source,
      "Screen.tsx": screen([`<${name} busy={busy} />`], `import { ${name} } from "./${name}";`),
    });
    assert.equal(findings[0]?.action, "use-observable", name);
  }
  const findings = await scan({
    "CustomViewLeaf.tsx": `
      import { View } from "./View";
      export function CustomViewLeaf({ busy }: { busy: boolean }) {
        return <View busy={busy} />;
      }
    `,
    "Screen.tsx": screen(
      ["<CustomViewLeaf busy={busy} />"],
      'import { CustomViewLeaf } from "./CustomViewLeaf";',
    ),
  });
  assert.equal(findings[0]?.action, "review-state");
});
