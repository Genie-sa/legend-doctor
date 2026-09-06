import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("keeps a returned command reentrancy guard on its React render snapshot", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function useActions() {
        const [busy, setBusy] = useState(false);
        const run = async () => {
          if (busy) return;
          setBusy(true);
          await work();
          setBusy(false);
        };
        return { run };
      }
    `),
    ["review-state"],
  );
});

test("preserves React lifecycle timing when command-only state becomes a ref", () => {
  const findings = analyzeSource(
    `
    import { useLayoutEffect, useState } from "react";
    export function ChartPreview({ source }: { source: number[] }) {
      const [elements, setElements] = useState<number[]>([]);
      useLayoutEffect(() => {
        if (source.length === 0) setElements([]);
        else setElements(source.map(value => value * 2));
      }, [source]);
      const insert = () => save(elements);
      return <Button onPress={insert} />;
    }
  `,
    "fixture.tsx",
  );
  const state = findings.find((finding) => finding.hook === "useState");
  assert.equal(requireValue(state).action, "use-ref");
  assert.match(requireValue(state).message ?? "", /preserve any existing React lifecycle hook/iu);
  assert.match(requireValue(state).evidence[2] ?? "", /effect writes 2/u);
});

test("uses a ref for command state read through imported React Hook Form", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    import { useForm } from "react-hook-form";
    export function Form() {
      const [secret, setSecret] = useState<string>();
      const { handleSubmit } = useForm();
      const submit = async () => {
        save(secret);
        setSecret(await loadSecret());
      };
      return <form onSubmit={handleSubmit(submit)}><button type="submit">Save</button></form>;
    }
    export function Shadowed({ useForm }: { useForm: () => { handleSubmit: Function } }) {
      const [secret, setSecret] = useState<string>();
      const { handleSubmit } = useForm();
      const submit = async () => {
        save(secret);
        setSecret(await loadSecret());
      };
      return <form onSubmit={handleSubmit(submit)}><button type="submit">Save</button></form>;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.name === "secret");
  assert.equal(requireValue(findings[0]).action, "use-ref");
  assert.notEqual(requireValue(findings[1]).action, "use-ref");
});

test("does not move lifecycle-written rendered or self-read state into a ref", () => {
  const rendered = analyzeSource(
    `
    import { useLayoutEffect, useState } from "react";
    export function Preview({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      useLayoutEffect(() => setVisible(source), [source]);
      const report = () => save(visible);
      return <main><Button onPress={report} />{visible && <Panel />}</main>;
    }
  `,
    "fixture.tsx",
  ).find((finding) => finding.hook === "useState");
  assert.notEqual(requireValue(rendered).action, "use-ref");

  const selfRead = analyzeSource(
    `
    import { useLayoutEffect, useState } from "react";
    export function Preview({ source }: { source: boolean }) {
      const [visible, setVisible] = useState(false);
      useLayoutEffect(() => { if (!visible) setVisible(source); }, [source, visible]);
      const report = () => save(visible);
      return <Button onPress={report} />;
    }
  `,
    "fixture.tsx",
  ).find((finding) => finding.hook === "useState");
  assert.notEqual(requireValue(selfRead).action, "use-ref");
});

test("does not call lifecycle or render-callback state command-only", () => {
  const listener = analyzeSource(
    `
      import { useCallback, useEffect, useState } from "react";
      export function Listener() {
        const [active, setActive] = useState(false);
        const report = useCallback(() => send(active), [active]);
        useEffect(report, [report]);
        return <Button onPress={() => { if (active) setActive(false); }} />;
      }
    `,
    "fixture.tsx",
  ).find((finding) => finding.hook === "useState");
  assert.equal(requireValue(listener).action, "review-state");

  const renderCallback = analyzeSource(
    `
      import { useCallback, useState } from "react";
      export function Results({ rows }: { rows: Array<{ id: string }> }) {
        const [selected, setSelected] = useState<string | null>(null);
        const renderItem = useCallback(({ item }: { item: { id: string } }) => (
          <Row active={selected === item.id} />
        ), [selected]);
        return <><List data={rows} renderItem={renderItem} />
          <Button onPress={() => { if (selected) setSelected(null); }} /></>;
      }
    `,
    "fixture.tsx",
  ).find((finding) => finding.hook === "useState");
  assert.notEqual(requireValue(renderCallback).action, "use-ref");
});

test("replaces a self-refreshing effect-owned command snapshot with a ref", () => {
  const source = (escape: string, readAfterWrite: string): string => `
    import { useCallback, useEffect, useState } from "react";
    export function Listener({ next }: { next: string }) {
      const [previous, setPrevious] = useState<string>();
      const update = useCallback(() => {
        if (next !== previous) {
          apply(next);
          setPrevious(next);
          ${readAfterWrite}
        }
      }, [next, previous]);
      useEffect(() => {
        update();
        const listener = () => update();
        source.addListener("change", listener);
        return () => source.removeListener("change", listener);
      }, [update]);
      return <Status ${escape}/>;
    }
  `;
  const [finding] = analyzeSource(source("", ""), "fixture.tsx");
  assert.equal(requireValue(finding).action, "use-ref");
  assert.match(requireValue(finding).message ?? "", /listener/iu);
  assert.match(requireValue(finding).message ?? "", /dependency/iu);

  for (const unsafe of [source("onUpdate={update}", ""), source("", "report(previous);")]) {
    assert.notEqual(
      requireValue(
        analyzeSource(unsafe, "fixture.tsx").find((candidate) => candidate.name === "previous"),
      ).action,
      "use-ref",
    );
  }
});

test("counts immediately invoked render computations as render reads", () => {
  const finding = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Filter({ custom }: { custom: boolean }) {
      const [enabled, setEnabled] = useState(custom);
      useEffect(() => setEnabled(custom), [custom]);
      const selected = (() => enabled ? "custom" : "preset")();
      return <Select value={selected} onChange={() => setEnabled(true)} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(finding).action, "use-ref");
  assert.match(requireValue(finding).evidence[1] ?? "", /reads: render 1/u);
});

test("does not call custom-hook reactions or returned commands event-rooted", () => {
  const focusReaction = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function Map() {
      const [idle, setIdle] = useState(false);
      useEffect(() => setIdle(false), []);
      useFocusEffect(() => { if (idle) fitBounds(); });
      return <MapView onIdle={() => setIdle(true)} />;
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(focusReaction).action, "use-ref");

  const returnedCommand = analyzeSource(
    `
    import { useEffect, useState } from "react";
    export function useSteps(source: string) {
      const [next, setNext] = useState("");
      useEffect(() => setNext(source), [source]);
      const navigate = () => go(next);
      return { navigate };
    }
  `,
    "fixture.tsx",
  ).find((candidate) => candidate.hook === "useState");
  assert.notEqual(requireValue(returnedCommand).action, "use-ref");
});
