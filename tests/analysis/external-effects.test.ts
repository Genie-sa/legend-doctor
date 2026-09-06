import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("keeps one translated external notification in React", () => {
  const effects = analyzeSource(
    `
    import { useEffect } from "react";
    import { useTranslation, useTranslation as useI18n } from "react-i18next";
    import { toast } from "sonner";
    export function Users({ count, error }: { count: number; error: Error | null }) {
      const { t } = useTranslation();
      useEffect(() => {
        if (error) toast.error(t("Could not load {{count}} users", { count }));
      }, [t, count, error]);
      return null;
    }
    export function Groups({ error }: { error: Error | null }) {
      const { t: translate } = useI18n();
      useEffect(() => {
        if (error) toast.error(translate("Could not load groups"));
      }, [translate, error]);
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect", "keep-effect"],
  );
});

test("does not trust local formatters or lookalike translation hooks in external effects", () => {
  const effects = analyzeSource(
    `
    import { useEffect } from "react";
    import { useTranslation as useLookalike } from "./translations";
    import { useTranslation } from "react-i18next";
    import { toast } from "sonner";
    export function LocalFormatter({ error }: { error: Error | null }) {
      const t = (message: string) => message;
      useEffect(() => { if (error) toast.error(t("Failed")); }, [t, error]);
      return null;
    }
    export function LookalikeHook({ error }: { error: Error | null }) {
      const { t } = useLookalike();
      useEffect(() => { if (error) toast.error(t("Failed")); }, [t, error]);
      return null;
    }
    export function MissingDependency({ error }: { error: Error | null }) {
      const { t } = useTranslation();
      useEffect(() => { if (error) toast.error(t("Failed")); }, [error]);
      return null;
    }
    export function ShadowedHook({ error }: { error: Error | null }) {
      const useTranslation = () => ({ t: (message: string) => message });
      const { t } = useTranslation();
      useEffect(() => { if (error) toast.error(t("Failed")); }, [t, error]);
      return null;
    }
    export function ArbitraryPreparation({ error }: { error: Error | null }) {
      const { t } = useTranslation();
      useEffect(() => { if (error) toast.error(t(buildMessage(error))); }, [t, error]);
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect", "keep-effect", "keep-effect", "keep-effect", "keep-effect"],
  );
  for (const finding of effects) {
    assert.doesNotMatch(finding.message, /external integration/u);
  }
});

test("keeps dependency-driven browser-storage persistence in React", () => {
  const effects = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Filters({ ready, workspaceId }: { ready: boolean; workspaceId: string }) {
      const [query, setQuery] = useState("");
      const [statuses, setStatuses] = useState<string[]>([]);
      useEffect(() => {
        if (!ready || globalThis.window === undefined) return;
        globalThis.window.localStorage.setItem(
          workspaceId + ":filters",
          JSON.stringify({ query, statuses })
        );
        if (Object.keys(statuses).length > 0) {
          sessionStorage.setItem("has-statuses", "true");
        } else {
          window.sessionStorage.removeItem("has-statuses");
        }
      }, [query, statuses, ready, workspaceId]);
      return <input value={query} onChange={event => setQuery(event.target.value)} />;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    ["keep-effect"],
  );
  assert.match(requireValue(effects[0]).message ?? "", /browser storage/iu);
});

test("does not call storage hydration, scheduling, arbitrary work, or reactions with extra work persistence", () => {
  const effects = analyzeSource(
    `
    import { useEffect, useState } from "react";
    import { useValue } from "@legendapp/state/react";
    export function Hydrate({ value, value$ }: { value: string; value$: unknown }) {
      const [stored, setStored] = useState("");
      const observed = useValue(value$);
      useEffect(() => {
        const next = localStorage.getItem("value");
        if (next) setStored(next);
      }, [value]);
      useEffect(() => { setTimeout(() => localStorage.setItem("value", value), 10); }, [value]);
      useEffect(() => { localStorage.setItem("value", serialize(value)); }, [value]);
      useEffect(() => { localStorage.setItem("value", value); report(value); }, [value]);
      useEffect(async () => { localStorage.setItem("value", value); }, [value]);
      useEffect(() => {
        localStorage.setItem("value", value);
        return () => localStorage.removeItem("value");
      }, [value]);
      useEffect(() => { localStorage.setItem("observed", JSON.stringify(observed)); }, [observed]);
      return <output>{stored}</output>;
    }
    export function ShadowedStorage({ value }: { value: string }) {
      const localStorage = { setItem: (_key: string, _value: string) => undefined };
      useEffect(() => { localStorage.setItem("value", value); }, [value]);
      return null;
    }
    export function ShadowedJson({ value }: { value: string }) {
      const JSON = { stringify: (_value: unknown) => "custom" };
      useEffect(() => { window.localStorage.setItem("value", JSON.stringify(value)); }, [value]);
      return null;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    [
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "persist-observable",
      "keep-effect",
      "keep-effect",
    ],
  );
  assert.match(requireValue(effects[0]).message, /`stored`.* stays React state/u);
  assert.match(requireValue(effects[6]).message, /syncObservable/u);
  for (const finding of [...effects.slice(1, 5), ...effects.slice(7)]) {
    assert.doesNotMatch(finding.message, /browser storage/iu);
  }
});

test("reviews local-state, helper, scheduled, multi-command, collection, and subscription effects", () => {
  const effects = analyzeSource(
    `
    import { useEffect, useState } from "react";
    import { fetchResource, reportResource, resources, subscribeToResource } from "./resource";
    export function Screen({ id }: { id: string }) {
      const [query, setQuery] = useState("");
      const load = () => fetchResource(id);
      useEffect(() => { fetchResource(query); }, [query]);
      useEffect(() => { load(); }, [load]);
      useEffect(() => { setTimeout(() => fetchResource(id), 10); }, [id]);
      useEffect(() => { fetchResource(id); reportResource(id); }, [id]);
      useEffect(() => { [id].forEach(value => fetchResource(value)); }, [id]);
      useEffect(() => { subscribeToResource(id); }, [id]);
      useEffect(() => { animation.set(withRepeat(withTiming(id))); }, [animation, id]);
      useEffect(() => { const key = resourceKey(id); fetchResource(key); }, [id]);
      useEffect(() => { fetchResource(resources.map(resource => resource + id)); }, [id]);
      useEffect(() => { fetchResource({ id, resolve: () => id }); }, [id]);
      return <input value={query} onChange={event => setQuery(event.target.value)} />;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useEffect");
  assert.deepEqual(
    effects.map((finding) => finding.action),
    [
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
      "keep-effect",
    ],
  );
  assert.match(requireValue(effects[0]).message, /`query`.* stays React state/u);
  for (const finding of effects.slice(1)) {
    assert.doesNotMatch(finding.message, /external integration/u);
  }
});

test("honors an adjacent directive that keeps lifecycle ownership in React", () => {
  for (const directive of [
    "react-effect-allow timer: preserve React replay",
    "legend-doctor keep-react-effect",
  ]) {
    const [finding] = analyzeSource(
      `
      import { useEffect, useRef } from "react";
      export function Screen() {
        const timer = useRef<number | null>(null);
        // ${directive}
        useEffect(() => () => {
          if (timer.current !== null) clearTimeout(timer.current);
        }, []);
        return null;
      }
    `,
      "fixture.tsx",
    );
    assert.equal(requireValue(finding).action, "keep-effect");
    assert.equal(requireValue(finding).confidence, "certain");
    assert.match(requireValue(finding).message ?? "", /ownership directive/u);
  }
});

test("does not apply a detached or unrelated React effect comment", () => {
  for (const source of [
    `
      import { useEffect } from "react";
      // react-effect-allow timer
      const label = "detached";
      export function Screen() {
        useEffect(() => () => release(), []);
        return label;
      }
    `,
    `
      import { useEffect } from "react";
      export function Screen() {
        const policy = "react-effect-allow";
        useEffect(() => () => release(), []);
        return policy;
      }
    `,
    `
      import { useEffect } from "react";
      export function Screen() {
        // Documentation mentions legend-doctor keep-react-effect, but this is not a directive.
        useEffect(() => () => release(), []);
        return null;
      }
    `,
    `
      import { useEffect } from "react";
      export function Screen() {
        // legend-doctor keep-react-effect

        useEffect(() => () => release(), []);
        return null;
      }
    `,
  ]) {
    const [finding] = analyzeSource(source, "fixture.tsx");
    assert.equal(requireValue(finding).action, "use-unmount");
  }
});
