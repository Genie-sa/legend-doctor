import { analyzeSource, analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import type { HookFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

function effectsOf(findings: readonly HookFinding[]): HookFinding[] {
  return findings.filter((finding) => finding.hook === "useEffect");
}

const MIGRATING_TARGET = `
  import { useEffect, useState } from "react";
  export function Screen() {
    const [target, setTarget] = useState<string | null>(null);
    useEffect(() => {
      sessionStorage.setItem("target", JSON.stringify(target));
    }, [target]);
    return <main>${CHROME}
      <button onClick={() => setTarget("details")} />
      <DetailDialog id={target} open={!!target} onOpenChange={open => !open && setTarget(null)} />
    </main>;
  }
`;

test("a persistence effect follows its state into an observable as a synced persist candidate", () => {
  const findings = analyzeSource(MIGRATING_TARGET, "fixture.tsx");
  const target = findings.find((finding) => finding.name === "target");
  const [effect] = effectsOf(findings);

  assert.equal(target?.action, "use-observable");
  assert.equal(requireValue(effect).action, "persist-observable");
  assert.equal(requireValue(effect).disposition, "candidate");
  assert.match(requireValue(effect).message, /state finding for `target`/u);
  assert.match(requireValue(effect).message, /synced\(/u);
  assert.match(requireValue(effect).message, /ObservablePersistSessionStorage/u);
  assert.doesNotMatch(requireValue(effect).message, /ObservablePersistLocalStorage/u);
});

test("a persistence effect stays in React while the state it writes stays React state", () => {
  const [effect] = effectsOf(
    analyzeSource(
      `
      import { useEffect, useState } from "react";
      export function Filters() {
        const [query, setQuery] = useState("");
        useEffect(() => {
          localStorage.setItem("query", query);
        }, [query]);
        return <input value={query} onChange={event => setQuery(event.target.value)} />;
      }
    `,
      "fixture.tsx",
    ),
  );

  assert.equal(requireValue(effect).action, "keep-effect");
  assert.match(requireValue(effect).message, /while `query` stays React state/u);
  assert.match(requireValue(effect).message, /ObservablePersistLocalStorage/u);
});

test("a persistence effect driven only by props names no Legend replacement", () => {
  const [effect] = effectsOf(
    analyzeSource(
      `
      import { useEffect } from "react";
      export function WorkspaceStorage({ workspaceId }: { workspaceId: string }) {
        useEffect(() => {
          localStorage.setItem("workspace", workspaceId);
        }, [workspaceId]);
        return null;
      }
    `,
      "fixture.tsx",
    ),
  );

  assert.equal(requireValue(effect).action, "keep-effect");
  assert.match(requireValue(effect).message, /persists React dependencies to browser storage/u);
  assert.doesNotMatch(requireValue(effect).message, /synced/u);
});

test("persisting an existing observable's value names syncObservable and both storages' plugins", () => {
  const [effect] = effectsOf(
    analyzeSource(
      `
      import { useEffect } from "react";
      import { useValue } from "@legendapp/state/react";
      import { settings$ } from "./state";
      export function Theme() {
        const theme = useValue(settings$.theme);
        useEffect(() => {
          localStorage.setItem("theme", theme);
          window.sessionStorage.setItem("theme-session", theme);
        }, [theme]);
        return <output>{theme}</output>;
      }
    `,
      "fixture.tsx",
    ),
  );

  assert.equal(requireValue(effect).action, "persist-observable");
  assert.match(requireValue(effect).message, /syncObservable\(/u);
  assert.match(
    requireValue(effect).message,
    /ObservablePersistLocalStorage \| ObservablePersistSessionStorage/u,
  );
});

test("an installed Legend State without the sync entry point keeps every persistence effect in React", () => {
  const legendState = {
    syncExport: "missing" as const,
    useValueExport: "alias" as const,
    version: "2.1.15",
  };
  const findings = analyzeSourceWith(MIGRATING_TARGET, "fixture.tsx", { legendState });
  const [effect] = effectsOf(findings);

  assert.equal(findings.find((finding) => finding.name === "target")?.action, "review-state");
  assert.equal(requireValue(effect).action, "keep-effect");
  assert.doesNotMatch(requireValue(effect).message, /synced/u);
});

test("a hydration guard read only inside the persistence effect still counts as consumed", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Filters() {
      const [query, setQuery] = useState("");
      const [hydrated, setHydrated] = useState(false);
      useEffect(() => {
        const stored = localStorage.getItem("query");
        if (stored) setQuery(stored);
        setHydrated(true);
      }, []);
      useEffect(() => {
        if (!hydrated) return;
        localStorage.setItem("query", query);
      }, [query, hydrated]);
      return <input value={query} onChange={event => setQuery(event.target.value)} />;
    }
  `,
    "fixture.tsx",
  );
  const hydrated = findings.find((finding) => finding.name === "hydrated");

  assert.notEqual(hydrated?.action, "delete-unused-state");
  assert.notEqual(hydrated?.action, "use-ref");
});
