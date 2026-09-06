import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("replaces a React mirror written only by a Legend reaction with useValue", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      import { useObserveEffect } from "@legendapp/state/react";
      export function Content({ activeId$ }: { activeId$: unknown }) {
        const [isOpen, setIsOpen] = useState(false);
        useObserveEffect(() => { setIsOpen(activeId$.get() === "menu"); });
        return isOpen ? <Menu /> : null;
      }
    `),
    ["use-value"],
  );
});

test("scopes Legend hook provenance to the owning function", () => {
  const findings = analyzeSource(
    `
    import { useEffect } from "react";
    import { useValue } from "@legendapp/state/react";
    export function First({ open$ }: { open$: unknown }) {
      const isOpen = useValue(open$);
      return isOpen ? <Panel /> : null;
    }
    export function Second({ isOpen }: { isOpen: boolean }) {
      useEffect(() => report(isOpen), [isOpen]);
      return null;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.hook === "useEffect")).action,
    "keep-effect",
  );
});

test("rejects same-owner shadowed Legend hook provenance", () => {
  const findings = analyzeSource(
    `
    import { useEffect } from "react";
    import { useValue } from "@legendapp/state/react";
    export function Screen({ open$ }: { open$: unknown }) {
      const value = useValue(open$);
      const reportOther = (value: boolean) => value;
      useEffect(() => report(value), [value]);
      return reportOther(false) ? <Panel /> : null;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(
    requireValue(findings.find((finding) => finding.hook === "useEffect")).action,
    "review-effect",
  );
});

test("suggests useObserveEffect only for dependencies sourced from useValue", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Title({ title$ }: { title$: unknown }) {
        const title = useValue(title$);
        useEffect(() => { document.title = title; }, [title]);
        return null;
      }
    `),
    ["use-observe-effect"],
  );
});

test("keeps a useValue-driven effect when the same value also renders its owner", () => {
  const findings = analyzeSource(
    `
    import { useEffect } from "react";
    import { useValue } from "@legendapp/state/react";
    export function ThemeToggleState({ theme$, onClick }: { theme$: unknown; onClick: () => void }) {
      const theme = useValue(theme$);
      useEffect(() => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        localStorage.setItem("theme", theme);
      }, [theme]);
      return <ThemeToggle theme={theme} onClick={onClick} />;
    }
  `,
    "fixture.tsx",
  );
  const effect = requireValue(findings.find((finding) => finding.hook === "useEffect"));
  assert.equal(effect.action, "keep-effect");
  assert.equal(effect.disposition, "keep");
  assert.match(effect.message ?? "", /also render/u);
});

test("keeps a useValue-driven effect when the value reaches render through a nested callback", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Row({ selected$, items }: { selected$: unknown; items: { id: string }[] }) {
        const selected = useValue(selected$);
        useEffect(() => { report(selected); }, [selected]);
        return <>{items.map((item) => <Item key={item.id} active={item.id === selected} />)}</>;
      }
    `),
    ["keep-effect"],
  );
});

test("allows stable useObservable handles beside changing useValue dependencies", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Dialog({ open$ }: { open$: unknown }) {
        const open = useValue(open$);
        const draft$ = useObservable("");
        useEffect(() => { if (open) draft$.set(""); }, [open, draft$]);
        return null;
      }
    `),
    ["use-observe-effect"],
  );
});

test("does not infer an observable reaction when the effect never reads the useValue dependency", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Dialog({ open$ }: { open$: unknown }) {
        const open = useValue(open$);
        useEffect(() => { refresh(); }, [open]);
        return null;
      }
    `),
    ["review-effect"],
  );
});

test("does not move deferred useValue reads into an untracked observable reaction", () => {
  for (const body of [
    `setTimeout(() => report(value), 10);`,
    `Promise.resolve().then(() => report(value));`,
    `source.subscribe(() => report(value));`,
    `const later = () => report(value); register(later);`,
    `report(value); setTimeout(() => report(value), 10);`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        import { useValue } from "@legendapp/state/react";
        export function Screen({ value$, source }: { value$: unknown; source: { subscribe: (callback: () => void) => void } }) {
          const value = useValue(value$);
          useEffect(() => { ${body} }, [value]);
          return null;
        }
      `),
      ["review-effect"],
      body,
    );
  }
});

test("does not replace async effects or callbacks with observable reactions", () => {
  for (const effect of [
    `useEffect(async () => { await load(); report(value); }, [value]);`,
    `useEffect(() => { void (async () => { await load(); report(value); })(); }, [value]);`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        import { useValue } from "@legendapp/state/react";
        export function Screen({ value$ }: { value$: unknown }) {
          const value = useValue(value$);
          ${effect}
          return null;
        }
      `),
      ["review-effect"],
      effect,
    );
  }
});

test("tracks useValue reads through synchronous collection callbacks", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Screen({ selected$, items }: { selected$: unknown; items: { id: string }[] }) {
        const selected = useValue(selected$);
        useEffect(() => {
          report(items.find(item => item.id === selected));
        }, [selected]);
        return null;
      }
    `),
    ["use-observe-effect"],
  );
});

test("does not trust collection method names on an unknown scheduler", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      export function Screen({ value$, scheduler }: {
        value$: unknown;
        scheduler: { find: (callback: () => boolean) => unknown };
      }) {
        const value = useValue(value$);
        useEffect(() => {
          scheduler.find(() => {
            report(value);
            return true;
          });
        }, [value]);
        return null;
      }
    `),
    ["review-effect"],
  );
});

test("does not trust a shadowed Array type as a synchronous collection", () => {
  assert.deepEqual(
    actions(`
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      type Array<T> = { find: (callback: (value: T) => boolean) => T | undefined };
      export function Screen({ selected$, items }: { selected$: unknown; items: Array<{ id: string }> }) {
        const selected = useValue(selected$);
        useEffect(() => {
          report(items.find(item => item.id === selected));
        }, [selected]);
        return null;
      }
    `),
    ["review-effect"],
  );
});

test("does not trust reassigned or method-overridden array receivers", () => {
  for (const setup of [
    `let items: { id: string }[] = []; items = makeScheduler();`,
    `const items: { id: string }[] = []; items.find = schedule;`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useEffect } from "react";
        import { useValue } from "@legendapp/state/react";
        export function Screen({ selected$ }: { selected$: unknown }) {
          const selected = useValue(selected$);
          ${setup}
          useEffect(() => {
            report(items.find(item => item.id === selected));
          }, [selected]);
          return null;
        }
      `),
      ["review-effect"],
      setup,
    );
  }
});
