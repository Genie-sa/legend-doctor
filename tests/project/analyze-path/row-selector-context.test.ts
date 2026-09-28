import type { LegendPracticeFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const provider = (valueSetup: string, providerSetup = ""): string => `
import type { Observable } from "@legendapp/state";
import { useObservable, useValue } from "@legendapp/state/react";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

interface DragValue {
  activeZone$: Observable<string | null>;
  clear: () => void;
}

const DragContext = createContext<DragValue | null>(null);

export function useDrag() {
  const value = useContext(DragContext);
  if (!value) {
    throw new Error("useDrag needs a DragProvider");
  }
  return value;
}

export function DragProvider({ children }: { children: ReactNode }) {
  const activeZone$ = useObservable<string | null>(null);
  ${providerSetup}
  const clear = useCallback(() => activeZone$.set(null), [activeZone$]);
  ${valueSetup}
  return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}
`;

const ZONE = `
import { useValue } from "@legendapp/state/react";
import { useDrag } from "./drag";

export function Zone({ id }: { id: string }) {
  const { activeZone$, clear } = useDrag();
  const activeZone = useValue(activeZone$);
  const isActive = activeZone === id;
  return <div data-active={isActive} onClick={clear} />;
}
`;

const MEMOIZED = "const value = useMemo(() => ({ activeZone$, clear }), [activeZone$, clear]);";

async function zoneFindings(drag: string, zone = ZONE): Promise<LegendPracticeFinding[]> {
  let findings: LegendPracticeFinding[] = [];
  await withProject({ "drag.tsx": drag, "zone.tsx": zone }, async (root) => {
    const report = await analyzePath(root);
    findings = report.practices.filter(
      (finding) => finding.action === "select-primitive-projection",
    );
  });
  return findings;
}

test("a context-hook observable projects when every provider value is mount-stable", async () => {
  const [finding, ...rest] = await zoneFindings(provider(MEMOIZED));
  assert.equal(rest.length, 0);
  assert.equal(finding?.location.file, "zone.tsx");
  assert.match(
    finding?.message ?? "",
    /`const isActive = useValue\(\(\) => activeZone\$\.get\(\) === id\)`/u,
  );
});

for (const [name, drag] of Object.entries({
  freshValue: provider("const value = { activeZone$, clear };"),
  subscribingProvider: provider(
    "const value = { activeZone$, clear, hovered };",
    "const hovered = useValue(activeZone$);",
  ),
  renderValueDependency: provider(
    "const value = useMemo(() => ({ activeZone$, clear, hovered }), [activeZone$, clear, hovered]);",
    "const hovered = useValue(activeZone$);",
  ),
  undeclaredDependencies: provider("const value = useMemo(() => ({ activeZone$, clear }));"),
  secondFreshProvider: `${provider(MEMOIZED)}
export function OtherProvider({ children }: { children: ReactNode }) {
  const activeZone$ = useObservable<string | null>(null);
  return <DragContext.Provider value={{ activeZone$, clear: () => {} }}>{children}</DragContext.Provider>;
}
`,
  escapedContext: `${provider(MEMOIZED)}
export const DragContextHandle = DragContext;
`,
  plainMember: provider(MEMOIZED).replace(
    "activeZone$: Observable<string | null>;",
    "activeZone$: { get(): string | null };",
  ),
})) {
  test(`a context-hook observable abstains on ${name}`, async () => {
    assert.deepEqual(await zoneFindings(drag), []);
  });
}

for (const [name, zone] of Object.entries({
  nullishFallback: ZONE.replace("= useDrag();", "= useDrag() ?? fallback;"),
  shadowedHook: ZONE.replace(
    "export function Zone({ id }: { id: string })",
    "export function Zone({ id, useDrag }: { id: string; useDrag: () => never })",
  ),
  reassignedMember: ZONE.replace(
    "const { activeZone$, clear }",
    "let { activeZone$, clear }",
  ).replace("const activeZone =", "activeZone$ = other$; const activeZone ="),
})) {
  test(`the context-hook binding stays unproven on ${name}`, async () => {
    assert.deepEqual(await zoneFindings(provider(MEMOIZED), zone), []);
  });
}
