import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("uses a ref for an effect-written cursor read only by one returned switch command", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    import { Navigation, resolveNext } from "./navigation";
    export function useSteps(source: "first" | "second") {
      const [next, setNext] = useState<"first" | "second">();
      useEffect(() => setNext(resolveNext(source)), [source]);
      const navigate = () => {
        switch (next) {
          case "first":
            Navigation.navigate("first");
            break;
          case "second":
            Navigation.navigate("second");
            break;
          default:
            Navigation.navigate("done");
            break;
        }
      };
      return { navigate };
    }
  `,
    "fixture.ts",
  );
  assert.equal(requireValue(findings.find((finding) => finding.name === "next")).action, "use-ref");
});

test("uses a ref for a returned switch command with one exact guarded fallback", () => {
  const [finding] = analyzeSource(
    `
    import { useEffect, useState } from "react";
    import { Navigation, resolvePrevious } from "./navigation";
    export function useSteps(source: string, backTo?: string) {
      const [previous, setPrevious] = useState<"first">();
      useEffect(() => setPrevious(resolvePrevious(source)), [source]);
      const goBack = () => {
        switch (previous) {
          case "first":
            Navigation.goBack("first");
            break;
          default:
            if (backTo) {
              Navigation.goBack(backTo);
              return;
            }
            Navigation.goBack("root");
            break;
        }
      };
      return { goBack };
    }
  `,
    "fixture.ts",
  );
  assert.equal(requireValue(finding).action, "use-ref");
});

test("keeps returned switch fallbacks with unsafe guards or branch work conservative", () => {
  for (const fallback of [
    `if (shouldGoBack()) { Navigation.goBack(backTo); return; } Navigation.goBack("root"); break;`,
    `if (backTo) { Navigation.goBack(backTo); audit(); return; } Navigation.goBack("root"); break;`,
    `if (backTo) { Navigation.goBack(backTo); return backTo; } Navigation.goBack("root"); break;`,
  ]) {
    const [finding] = analyzeSource(
      `
      import { useEffect, useState } from "react";
      import { Navigation, resolvePrevious } from "./navigation";
      export function useSteps(source: string, backTo?: string) {
        const [previous, setPrevious] = useState<"first">();
        useEffect(() => setPrevious(resolvePrevious(source)), [source]);
        const goBack = () => {
          switch (previous) {
            case "first": Navigation.goBack("first"); break;
            default: ${fallback}
          }
        };
        return { goBack };
      }
    `,
      "fixture.ts",
    );
    assert.notEqual(requireValue(finding).action, "use-ref", fallback);
  }
});

test("keeps returned switch cursors with extra reads or non-command branches conservative", () => {
  for (const command of [
    `switch (next) { case "first": Navigation.navigate(next); break; default: Navigation.navigate("done"); }`,
    `switch (next) { case "first": return next; default: Navigation.navigate("done"); }`,
    `switch (next) { case "first": render(next); break; default: Navigation.navigate("done"); }`,
  ]) {
    const finding = analyzeSource(
      `
      import { useEffect, useState } from "react";
      import { Navigation, resolveNext } from "./navigation";
      export function useSteps(source: "first" | "second") {
        const [next, setNext] = useState<"first" | "second">();
        useEffect(() => setNext(resolveNext(source)), [source]);
        const navigate = () => { ${command} };
        return { navigate };
      }
    `,
      "fixture.ts",
    ).find((candidate) => candidate.name === "next");
    assert.notEqual(requireValue(finding).action, "use-ref", command);
  }
});
