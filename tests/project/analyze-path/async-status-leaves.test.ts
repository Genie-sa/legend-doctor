import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates source-proven async status across bounded leaf call sites", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-async-fanout-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "SelectControl.tsx"),
    `
      export function SelectControl({ loading, load }: {
        loading: boolean;
        load: (id: string) => Promise<void>;
      }) {
        return <select disabled={loading} onChange={event => void load(event.currentTarget.value)} />;
      }

      export function EagerControl({ loading, load }: {
        loading: boolean;
        load: (id: string) => Promise<void>;
      }) {
        load("now");
        return <select disabled={loading} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { EagerControl, SelectControl } from "./SelectControl";
      function StatusButton({ loading }: { loading: boolean }) {
        return <button disabled={loading}>Save</button>;
      }

      export function Screen({ edit }: { edit: boolean }) {
        const [loading, setLoading] = useState(false);
        const load = async (id: string) => {
          setLoading(true);
          await fetchData(id);
          setLoading(false);
        };
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer />
          <SelectControl loading={loading} load={load} />
          {edit ? <StatusButton loading={loading} /> : <StatusButton loading={loading} />}
        </main>;
      }

      export function SmallWorkflow() {
        const [smallLoading, setSmallLoading] = useState(false);
        const load = async (id: string) => {
          setSmallLoading(true);
          await fetchData(id);
          setSmallLoading(false);
        };
        return <form><SelectControl loading={smallLoading} load={load} /><StatusButton loading={smallLoading} /></form>;
      }

      export function UnresolvedTiming() {
        const [eagerLoading, setEagerLoading] = useState(false);
        const load = async (id: string) => {
          setEagerLoading(true);
          await fetchData(id);
          setEagerLoading(false);
        };
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer />
          <EagerControl loading={eagerLoading} load={load} /><StatusButton loading={eagerLoading} />
        </main>;
      }

      export function MixedLifecycle() {
        const [mixedLoading, setMixedLoading] = useState(false);
        const [, setReady] = useState(false);
        const load = async (id: string) => {
          setMixedLoading(true);
          await fetchData(id);
          setMixedLoading(false);
        };
        useEffect(() => {
          void load("initial");
          setReady(true);
        }, []);
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer />
          <SelectControl loading={mixedLoading} load={load} /><StatusButton loading={mixedLoading} />
        </main>;
      }

      export function RepeatedStatus({ rows }: { rows: string[] }) {
        const [repeatedLoading, setRepeatedLoading] = useState(false);
        const load = async (id: string) => {
          setRepeatedLoading(true);
          await fetchData(id);
          setRepeatedLoading(false);
        };
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer />
          <SelectControl loading={repeatedLoading} load={load} />
          {rows.map(row => <StatusButton key={row} loading={repeatedLoading} />)}
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const actions = new Map(report.findings.map((finding) => [finding.name, finding.action]));
  assert.equal(actions.get("loading"), "use-observable");
  assert.equal(actions.get("smallLoading"), "review-state");
  assert.equal(actions.get("eagerLoading"), "review-state");
  assert.equal(actions.get("mixedLoading"), "review-state");
  assert.equal(actions.get("repeatedLoading"), "review-state");
  assert.match(
    requireValue(report.findings.find((finding) => finding.name === "loading")).message ?? "",
    /three stable status call sites/u,
  );
});

test("requires source-proven deferred callbacks for one async status leaf", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-async-event-contract-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Controls.tsx"),
    `
      export function DeferredControl({ loading, onRun }: { loading: boolean; onRun: () => void }) {
        return <button disabled={loading} onClick={onRun}>Run</button>;
      }
      export function EagerControl({ loading, onRun }: { loading: boolean; onRun: () => void }) {
        onRun();
        return <span>{String(loading)}</span>;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { DeferredControl, EagerControl } from "./Controls";
      import { OpaqueControl } from "opaque-controls";

      export function DeferredScreen() {
        const [deferred, setDeferred] = useState(false);
        const run = async () => { setDeferred(true); try { await save(); } finally { setDeferred(false); } };
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status /><DeferredControl loading={deferred} onRun={run} /></main>;
      }
      export function EagerScreen() {
        const [eager, setEager] = useState(false);
        const run = async () => { setEager(true); try { await save(); } finally { setEager(false); } };
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status /><EagerControl loading={eager} onRun={run} /></main>;
      }
      export function OpaqueScreen() {
        const [opaque, setOpaque] = useState(false);
        const run = async () => { setOpaque(true); try { await save(); } finally { setOpaque(false); } };
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status /><OpaqueControl loading={opaque} onRun={run} /></main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const findings = new Map(report.findings.map((finding) => [finding.name, finding]));
  assert.equal(
    requireValue(findings.get("deferred")).action,
    "use-observable",
    requireValue(findings.get("deferred")).message,
  );
  assert.equal(requireValue(findings.get("deferred")).abstentionReason, undefined);
  assert.equal(
    requireValue(findings.get("eager")).action,
    "review-state",
    requireValue(findings.get("eager")).message,
  );
  assert.equal(
    requireValue(findings.get("eager")).abstentionReason,
    "async-command-origin-unresolved",
  );
  assert.equal(
    requireValue(findings.get("opaque")).action,
    "review-state",
    requireValue(findings.get("opaque")).message,
  );
});
