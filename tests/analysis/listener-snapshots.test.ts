import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("groups listener-only pointer snapshots into one ref migration", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useEffect, useState } from "react";
    export function Canvas() {
      const [pressed, setPressed] = useState(false);
      const [originX, setOriginX] = useState(0);
      const [originY, setOriginY] = useState(0);
      const start = (event: { x: number; y: number }) => {
        setPressed(true);
        setOriginX(event.x);
        setOriginY(event.y);
      };
      const move = useCallback((event: MouseEvent) => {
        if (pressed) pan(originX - event.x, originY - event.y);
      }, [originX, originY, pressed]);
      useEffect(() => {
        document.addEventListener(("mousemove"), move, (true));
        return () => document.removeEventListener("mousemove", move, true);
      }, [move]);
      return <Surface onPointerDown={start} />;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useState");

  assert.deepEqual(
    findings.map((finding) => finding.action),
    ["use-ref", "use-ref", "use-ref"],
  );
  assert.deepEqual(
    findings.map((finding) => requireValue(finding.group).members),
    [
      ["pressed", "originX", "originY"],
      ["pressed", "originX", "originY"],
      ["pressed", "originX", "originY"],
    ],
  );
  assert.deepEqual(
    findings.map((finding) => requireValue(finding.group).primary),
    [true, false, false],
  );
});

test("keeps incomplete or render-coupled listener snapshots in React state", () => {
  for (const effect of [
    `useEffect(() => { document.addEventListener("mousemove", move); }, [move]);`,
    `useEffect(() => move(), [move]);`,
    `useEffect(() => {
      document.addEventListener("mousemove", move, true);
      return () => document.removeEventListener("mousemove", move, false);
    }, [move]);`,
    `useEffect(() => {
      document.addEventListener("mousemove", move);
      return () => document.removeEventListener("mousemove", move);
    }, []);`,
  ]) {
    const findings = analyzeSource(
      `
      import { useCallback, useEffect, useState } from "react";
      export function Canvas() {
        const [pressed, setPressed] = useState(false);
        const [origin, setOrigin] = useState(0);
        const [visible, setVisible] = useState(false);
        const start = () => {
          setPressed(true);
          setOrigin(1);
          setVisible(true);
        };
        const move = useCallback(() => {
          if (pressed) pan(origin);
        }, [origin, pressed]);
        ${effect}
        return <Surface onPointerDown={start} visible={visible} />;
      }
    `,
      "fixture.tsx",
    ).filter((finding) => ["pressed", "origin"].includes(finding.name ?? ""));
    assert.ok(
      findings.every((finding) => finding.action === "review-state"),
      effect,
    );
    assert.ok(
      findings.every((finding) => finding.group === undefined),
      effect,
    );
  }
});

test("keeps async listener snapshots under review", () => {
  const findings = analyzeSource(
    `
    import { useCallback, useEffect, useState } from "react";
    export function Canvas() {
      const [pressed, setPressed] = useState(false);
      const [origin, setOrigin] = useState(0);
      const start = () => {
        setPressed(true);
        setOrigin(1);
      };
      const move = useCallback(async () => {
        await ready();
        if (pressed) pan(origin);
      }, [origin, pressed]);
      useEffect(() => {
        document.addEventListener("mousemove", move);
        return () => document.removeEventListener("mousemove", move);
      }, [move]);
      return <Surface onPointerDown={start} />;
    }
  `,
    "fixture.tsx",
  ).filter((finding) => finding.hook === "useState");
  assert.ok(findings.every((finding) => finding.action === "review-state"));
  assert.ok(findings.every((finding) => finding.group === undefined));
});
