import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("keeps one dependency-driven external resource command in React", () => {
  const effects = analyzeSource(
    `
    import { useEffect } from "react";
    import { cacheKey, openWorkspace } from "./workspace";
    export function Workspace({ policyId }: { policyId: string | null }) {
      useEffect(() => {
        if (!policyId) return;
        openWorkspace(policyId);
      }, [policyId]);
      return null;
    }
    export function Documents({ client, enabled }: { client: { fetch: () => void }; enabled: boolean }) {
      useEffect(() => {
        if (enabled) void client.fetch();
      }, [client, enabled]);
      return null;
    }
    export function Cache({ client, id }: { client: { invalidate: (input: unknown) => void }; id: string }) {
      useEffect(() => {
        client.invalidate({ key: cacheKey(id) });
      }, [client, id]);
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect"],
  );
});

test("keeps a dependency-driven command with one pure mapped payload projection", () => {
  const effects = analyzeSource(
    `
    import { useEffect } from "react";
    import { enqueue } from "./integration";
    export function PureProjection({ result }: { result: { data?: Array<{ media: string }> } }) {
      useEffect(() => {
        if (result.data) enqueue(result.data.map(row => row.media));
      }, [result.data]);
      return null;
    }
    export function MutatingProjection({ rows }: { rows: Array<{ media: string }> }) {
      useEffect(() => { enqueue(rows.map(row => { row.media = "changed"; return row.media; })); }, [rows]);
      return null;
    }
    export function CallingProjection({ rows }: { rows: Array<{ media: string }> }) {
      useEffect(() => { enqueue(rows.map(row => normalize(row.media))); }, [rows]);
      return null;
    }
    export function ComputedProjection({ rows }: { rows: Array<{ media: string }> }) {
      useEffect(() => { enqueue(rows.map(row => row["media"])); }, [rows]);
      return null;
    }
    export function ShadowedSource({ rows }: { rows: string[] }) {
      useEffect(() => {
        const rows = [{ media: "local" }];
        enqueue(rows.map(row => row.media));
      }, [rows]);
      return null;
    }
    export function DifferentSource({ rows, otherRows }: { rows: string[]; otherRows: string[] }) {
      useEffect(() => { enqueue(otherRows.map(row => row.length)); }, [rows]);
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect", "keep-effect", "review-effect", "keep-effect"],
  );
  assert.match(requireValue(effects[0]).message, /external integration/u);
  for (const finding of [...effects.slice(1, 4), ...effects.slice(5)]) {
    assert.match(finding.message, /reads only props/u);
  }
});

test("keeps externally prepared dependency-driven navigation in React", () => {
  const effects = analyzeSource(
    `
    import { useEffect } from "react";
    import { format, isEmptyObject } from "./values";
    import { Navigation, ROUTES } from "./navigation";
    export function EmptyReport({ report }: { report: object | null }) {
      useEffect(() => {
        if (!report || isEmptyObject(report)) return;
        Navigation.dismissModal();
      }, [report]);
      return null;
    }
    export function Membership({ emails, login }: { emails: string[]; login: string }) {
      useEffect(() => {
        if (!emails.includes(login)) return;
        Navigation.goBack(ROUTES.member(login));
      }, [emails, login]);
      return null;
    }
    export function CurrentPeriod({ period }: { period: string | null }) {
      useEffect(() => {
        const current = format(new Date(), "yyyyMM");
        if (period?.length !== 6 || period > current) Navigation.dismissModal();
      }, [period]);
      return null;
    }
    export function RepeatedCommands({ values }: { values: string[] }) {
      useEffect(() => { for (const value of values) Navigation.navigate(value); }, [values]);
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect", "keep-effect"],
  );
});

test("keeps dependency effects with resolved local callbacks", () => {
  const effects = analyzeSource(
    `
    import React, { useCallback, useEffect, useRef, useState } from "react";
    import { publish } from "./integration";
    export function Named({ active, id }: { active: boolean; id: string }) {
      const clear = () => {
        if (active) publish(id);
      };
      useEffect(clear, [clear]);
      return null;
    }
    export function CommittedRef({ onChange, max }: { onChange: (value: boolean) => void; max: number }) {
      const offsetRef = useRef(0);
      const notify = useCallback(() => onChange(offsetRef.current < max), [onChange, max]);
      React.useEffect(notify, [notify]);
      return null;
    }
    export function PromiseChain({ rows }: { rows: string[] }) {
      const [selected, setSelected] = useState("");
      const load = useCallback(() => Promise.resolve(rows[0]).then(setSelected), [rows]);
      useEffect(load, [load]);
      return <output>{selected}</output>;
    }
    export function Mutable({ id }: { id: string }) {
      let notify = () => publish(id);
      useEffect(notify, [notify]);
      notify = () => publish("changed");
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "review-effect", "review-effect"],
  );
});

test("reviews unsafe dependency-driven command preparation", () => {
  const effects = analyzeSource(
    `
    import { useEffect, useState } from "react";
    import { Navigation } from "./navigation";
    import { subscribe } from "./resource";
    import { useSharedValue, withRepeat, withTiming } from "./animation";
    export function LocalHelper({ ready }: { ready: boolean }) {
      const [dirty, setDirty] = useState(false);
      const check = () => { setDirty(true); return ready; };
      useEffect(() => { if (check()) Navigation.dismissModal(); }, [ready]);
      return <output>{dirty}</output>;
    }
    export function Subscription({ ready }: { ready: boolean }) {
      useEffect(() => { if (subscribe(ready)) Navigation.dismissModal(); }, [ready]);
      return null;
    }
    export function Scheduled({ ready }: { ready: boolean }) {
      useEffect(() => { if (setTimeout(() => ready, 0)) Navigation.dismissModal(); }, [ready]);
      return null;
    }
    export function ArbitraryConstructor({ ready }: { ready: boolean }) {
      useEffect(() => { const value = new Widget(ready); if (value) Navigation.dismissModal(); }, [ready]);
      return null;
    }
    export function HookResource({ speed }: { speed: number }) {
      const progress = useSharedValue(0);
      useEffect(() => { progress.set(withRepeat(withTiming(speed))); }, [progress, speed]);
      return null;
    }
    export function CallbackResource({ path }: { path: string }) {
      useEffect(() => {
        const onSuccess = () => Navigation.dismissModal();
        loadResource(path, onSuccess);
      }, [path]);
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect", "keep-effect", "keep-effect", "keep-effect"],
  );
  assert.match(requireValue(effects[0]).message, /`dirty`.* stays React state/u);
  for (const finding of effects.slice(1)) {
    assert.doesNotMatch(finding.message, /external integration/u);
  }
});
