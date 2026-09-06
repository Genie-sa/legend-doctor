import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("groups a literal popup payload with its visibility at one resolved child", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-popup-model-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "LevelPopup.tsx"),
    `
      import { useCallback, useEffect } from "react";
      export function LevelPopup({ open, level, setOpen }: {
        open: boolean;
        level: number;
        setOpen: (open: boolean) => void;
      }) {
        useEffect(() => reportVisibility(open), [open]);
        const close = useCallback(() => setOpen(false), [setOpen]);
        return <dialog open={open} data-level={level}><button onClick={close}>Close</button></dialog>;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { LevelPopup } from "./LevelPopup";

      export function Screen() {
        const [popupOpen, setPopupOpen] = useState(false);
        const [popupLevel, setPopupLevel] = useState(1);
        const show = (level: number) => { setPopupLevel(level); setPopupOpen(true); };
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={() => show(5)}>Show</button>
          <LevelPopup open={popupOpen} level={popupLevel} setOpen={setPopupOpen} /></main>;
      }

      export function SplitScreen() {
        const [splitOpen, setSplitOpen] = useState(false);
        const [splitLevel, setSplitLevel] = useState(1);
        const show = () => { setSplitLevel(5); setSplitOpen(true); };
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={show}>Show</button><output>{splitLevel}</output>
          <LevelPopup open={splitOpen} level={0} setOpen={setSplitOpen} /></main>;
      }

      export function RepeatedScreen({ levels }: { levels: number[] }) {
        const [repeatedOpen, setRepeatedOpen] = useState(false);
        const [repeatedLevel, setRepeatedLevel] = useState(1);
        const show = (level: number) => { setRepeatedLevel(level); setRepeatedOpen(true); };
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview />{levels.map(level => <LevelPopup key={level} open={repeatedOpen}
            level={repeatedLevel} setOpen={setRepeatedOpen} />)}<button onClick={() => show(5)}>Show</button></main>;
      }

      export function FunctionalScreen() {
        const [functionalOpen, setFunctionalOpen] = useState(false);
        const [functionalLevel, setFunctionalLevel] = useState(1);
        const show = () => { setFunctionalLevel(level => level + 1); setFunctionalOpen(true); };
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><button onClick={show}>Show</button>
          <LevelPopup open={functionalOpen} level={functionalLevel} setOpen={setFunctionalOpen} /></main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const actions = new Map(report.findings.map((finding) => [finding.name, finding.action]));
  const popupOpenFinding = requireValue(
    report.findings.find((finding) => finding.name === "popupOpen"),
  );
  assert.equal(actions.get("popupOpen"), "use-observable");
  assert.equal(actions.get("popupLevel"), "use-observable");
  assert.equal(actions.get("splitOpen"), "use-observable");
  assert.equal(actions.get("splitLevel"), "use-observable");
  assert.equal(actions.get("repeatedOpen"), "review-state");
  assert.equal(actions.get("repeatedLevel"), "review-state");
  assert.equal(actions.get("functionalOpen"), "review-state");
  assert.equal(actions.get("functionalLevel"), "review-state");
  assert.deepEqual(requireValue(popupOpenFinding.group).members, ["popupOpen", "popupLevel"]);
});

test("proves direct source-component callback timing before replacing command-only state", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-source-callback-state-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Forms.tsx"),
    `
      import { useEffect } from "react";
      export function DeferredForm({ validate }: { validate: () => boolean }) {
        return <button onClick={() => validate()}>Validate</button>;
      }
      export function EagerForm({ validate }: { validate: () => boolean }) {
        const valid = validate();
        return <span>{String(valid)}</span>;
      }
      export function EffectForm({ validate }: { validate: () => boolean }) {
        useEffect(() => { validate(); }, [validate]);
        return null;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useCallback, useEffect, useState } from "react";
      import { DeferredForm, EagerForm, EffectForm } from "./Forms";
      export function SafeScreen() {
        const [enabled, setEnabled] = useState(false);
        useEffect(() => setEnabled(true), []);
        const validate = useCallback(() => enabled, [enabled]);
        return <DeferredForm validate={validate} />;
      }
      export function UnsafeScreen() {
        const [eager, setEager] = useState(false);
        useEffect(() => setEager(true), []);
        const validate = useCallback(() => eager, [eager]);
        return <EagerForm validate={validate} />;
      }
      export function MixedScreen() {
        const [mixed, setMixed] = useState(false);
        useEffect(() => setMixed(true), []);
        const validate = useCallback(() => mixed, [mixed]);
        return <><DeferredForm validate={validate} /><EagerForm validate={validate} /></>;
      }
      export function EffectScreen() {
        const [effect, setEffect] = useState(false);
        useEffect(() => setEffect(true), []);
        const validate = useCallback(() => effect, [effect]);
        return <EffectForm validate={validate} />;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const states = new Map(
    report.findings
      .filter((finding) => finding.hook === "useState")
      .map((finding) => [finding.name, finding.action]),
  );
  assert.equal(states.get("enabled"), "use-ref");
  assert.equal(states.get("eager"), "review-state");
  assert.equal(states.get("mixed"), "review-state");
  assert.equal(states.get("effect"), "review-state");
});

test("moves reset effects through source wrappers into Base UI event callbacks", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-base-ui-reset-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Controls.tsx"),
    `
      import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
      import { Select as SelectPrimitive } from "@base-ui/react/select";
      export function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
        return <TabsPrimitive.Root className={className} {...props} />;
      }
      function Select(props: SelectPrimitive.Root.Props<string>) {
        return <SelectPrimitive.Root {...props} />;
      }
      function FilterSelect({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
        return <Select value={value} onValueChange={next => onValueChange(String(next))} />;
      }
      export function Toolbar({ filters = [] }: { filters?: { value: string; onChange: (value: string) => void }[] }) {
        return filters.map(filter => filter.onChange ? (
          <FilterSelect key={filter.value} value={filter.value} onValueChange={filter.onChange} />
        ) : null);
      }
      export function EagerToolbar({ filters }: { filters: { onChange: (value: string) => void }[] }) {
        filters[0]?.onChange("render");
        return null;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useEffect, useState } from "react";
      import { EagerToolbar, Tabs, Toolbar } from "./Controls";
      export function SafeTabsScreen() {
        const [period, setPeriod] = useState("week");
        const [page, setPage] = useState(1);
        useEffect(() => setPage(1), [period]);
        return <main>
          <Tabs value={period} onValueChange={value => setPeriod(String(value))} />
          <button onClick={() => setPage(value => value + 1)}>{page}</button>
        </main>;
      }
      export function SafeToolbarScreen() {
        const [type, setType] = useState("all");
        const [member, setMember] = useState("all");
        const [page, setPage] = useState(1);
        useEffect(() => setPage(1), [type, member]);
        return <main>
          <Toolbar filters={[{ value: type, onChange: setType }, { value: member, onChange: setMember }]} />
          <button onClick={() => setPage(value => value + 1)}>{page}</button>
        </main>;
      }
      export function UnsafeScreen() {
        const [type, setType] = useState("all");
        const [page, setPage] = useState(1);
        useEffect(() => setPage(1), [type]);
        return <main>
          <EagerToolbar filters={[{ onChange: setType }]} />
          <button onClick={() => setPage(value => value + 1)}>{page}</button>
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const effects = report.findings.filter((finding) => finding.hook === "useEffect");
  assert.equal(requireValue(effects[0]).action, "move-to-event");
  assert.equal(requireValue(effects[1]).action, "move-to-event");
  assert.equal(requireValue(effects[2]).action, "keep-effect");
  assert.match(requireValue(effects[2]).message, /stays React state/u);
});
