import { assertVerifiedEdits, practiceFindings } from "./edit-assertions.js";
import type { LegendPracticeFinding } from "../../src/core/types.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

const IMPORTS = `import { observable } from "@legendapp/state";
import type { Observable } from "@legendapp/state";
import { Memo, useObservable, useValue } from "@legendapp/state/react";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { FC } from "react";
`;

const STORE = `
const ui$ = observable({ count: 0, offset: 0 });
const THEMES = [{ id: "a", swatch: "red" }, { id: "b", swatch: "blue" }];
declare function subscribeSpeaking(listener: () => void): () => void;
declare function speakingKey(): string | null;
`;

function memoFindings(body: string): LegendPracticeFinding[] {
  return practiceFindings(`${IMPORTS}${STORE}\n${body}`, "use-computed-for-parent-reads");
}

test("proves a Memo child that reads a value derived from a useValue subscription", () => {
  const finding = requireValue(
    memoFindings(`
export function Row({ index }: { index: number }) {
  const offset = useValue(ui$.offset);
  const absoluteIndex = offset + index;
  return <Memo>{() => <span>{absoluteIndex}:{ui$.count.get()}</span>}</Memo>;
}
`)[0],
  );
  assert.equal(finding.disposition, "change");
  assert.equal(finding.confidence, "certain");
  assert.equal(finding.practice, "reactivity");
  assert.equal(finding.location.line, 16);
  assert.match(
    finding.message,
    /^Replace `<Memo>` with `<Computed>`\. `absoluteIndex` changes when `Row` re-renders, but `Memo` never re-renders from its parent/u,
  );
  assert.match(
    finding.evidence.join("\n"),
    /`absoluteIndex` \(line 16\) depends on `offset`, the `useValue` result at line 14, which re-renders `Row`/u,
  );
  assert.equal(finding.evidence.length, 2);
});

test("proves React state with a used setter and external store values read by the child", () => {
  const findings = memoFindings(`
export function Message() {
  const [open, setOpen] = useState(false);
  const key = useSyncExternalStore(subscribeSpeaking, speakingKey);
  const speaking = key === "a";
  const toggle = () => setOpen(!open);
  return (
    <div onClick={toggle}>
      <Memo>{() => <b>{open ? "open" : "closed"}</b>}</Memo>
      <Memo>{() => <i>{speaking ? "stop" : "read"}</i>}</Memo>
    </div>
  );
}
`);
  assert.deepEqual(
    findings.map((finding) => [finding.disposition, finding.message.split(".")[1]?.trim()]),
    [
      [
        "change",
        "`open` changes when `Message` re-renders, but `Memo` never re-renders from its parent, so the child keeps the value from its first render",
      ],
      [
        "change",
        "`speaking` changes when `Message` re-renders, but `Memo` never re-renders from its parent, so the child keeps the value from its first render",
      ],
    ],
  );
});

test("follows a local render helper the child calls and a callback with changing dependencies", () => {
  const findings = memoFindings(`
export function Files() {
  const offset = useValue(ui$.offset);
  const renderOffset = () => <em>{offset}</em>;
  const onPick = useCallback(() => offset, [offset]);
  return (
    <>
      <Memo>{() => renderOffset()}</Memo>
      <Memo>{() => <button onClick={onPick} />}</Memo>
    </>
  );
}
`);
  assert.deepEqual(
    findings.map((finding) => finding.disposition),
    ["change", "change"],
  );
});

test("reports a prop the child reads as a candidate", () => {
  const finding = requireValue(
    memoFindings(`
export function Label({ label }: { label: string }) {
  return <div><Memo>{() => <span>{label}: {ui$.count.get()}</span>}</Memo></div>;
}
`)[0],
  );
  assert.equal(finding.disposition, "candidate");
  assert.equal(finding.confidence, "probable");
  assert.match(
    finding.message,
    /^`Memo` never re-renders from its parent, so its child keeps the first render's `label`\. If it can change while `Label` stays mounted, replace `<Memo>` with `<Computed>`/u,
  );
});

test("keeps a Memo whose child reads only observables and values that never change", () => {
  const findings = memoFindings(`
export function Stable({ value$ }: { value$: Observable<number> }) {
  const local$ = useObservable(0);
  const ref = useRef(0);
  const [, setOpen] = useState(false);
  const [frozen] = useState(1);
  const reset = useCallback(() => setOpen(false), []);
  const limit = 3;
  return (
    <div>
      <Memo>{() => <span onClick={reset}>{value$.get()}{local$.get()}{ref.current}{frozen}{limit}</span>}</Memo>
      <Memo>{ui$.count}</Memo>
      {THEMES.map((theme) => (
        <Memo key={theme.id}>{() => <i style={{ color: theme.swatch }}>{ui$.count.get()}</i>}</Memo>
      ))}
    </div>
  );
}
`);
  assert.deepEqual(findings, []);
});

test("keeps observable props declared on the parameter or on an FC annotation", () => {
  const findings = memoFindings(`
interface CardProps { item$: Observable<number>; title: string }
export const Card: FC<CardProps> = ({ item$ }) => <Memo>{() => <b>{item$.get()}</b>}</Memo>;
export function Panel(props: { value$: Observable<number> }) {
  return <Memo>{() => <b>{props.value$.get()}</b>}</Memo>;
}
export const Titled: FC<CardProps> = ({ title }) => <Memo>{() => <b>{title}</b>}</Memo>;
`);
  assert.deepEqual(
    findings.map((finding) => [finding.location.line, finding.disposition]),
    [[18, "candidate"]],
  );
});

test("keeps scoped Memos, handler-only captures, and Computed", () => {
  const findings = memoFindings(`
export function Handlers({ onSave, label }: { onSave: (value: number) => void; label: string }) {
  const offset = useValue(ui$.offset);
  return (
    <div>
      <Memo scoped>{() => <span>{label}</span>}</Memo>
      <Memo>{() => <button onClick={() => onSave(offset)}>{ui$.count.get()}</button>}</Memo>
    </div>
  );
}
`);
  assert.deepEqual(findings, []);
});

test("reports a nested Memo separately from the Memo that contains it", () => {
  const findings = memoFindings(`
export function Nested({ title }: { title: string }) {
  const offset = useValue(ui$.offset);
  return (
    <Memo>
      {() => (
        <section>
          <h1>{title}</h1>
          <Memo>{() => <span>{offset}</span>}</Memo>
        </section>
      )}
    </Memo>
  );
}
`);
  assert.deepEqual(
    findings.map((finding) => [finding.location.line, finding.disposition]),
    [
      [16, "candidate"],
      [20, "change"],
    ],
  );
});

test("renames every Memo tag and swaps the import when the file keeps no other Memo", () => {
  const source = `import { observable } from "@legendapp/state";
import { Memo, useValue } from "@legendapp/state/react";

const ui$ = observable({ count: 0, offset: 0 });

export function Row({ label }: { label: string }) {
  const offset = useValue(ui$.offset);
  return (
    <div>
      <Memo>{() => <span>{offset}:{ui$.count.get()}</span>}</Memo>
      <Memo>
        {() => <b>{label}</b>}
      </Memo>
    </div>
  );
}
`;
  const findings = practiceFindings(source, "use-computed-for-parent-reads");
  assert.equal(findings.length, 2);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { Computed, useValue } from "@legendapp/state/react";

const ui$ = observable({ count: 0, offset: 0 });

export function Row({ label }: { label: string }) {
  const offset = useValue(ui$.offset);
  return (
    <div>
      <Computed>{() => <span>{offset}:{ui$.count.get()}</span>}</Computed>
      <Computed>
        {() => <b>{label}</b>}
      </Computed>
    </div>
  );
}
`,
    findings,
  );
});

test("adds Computed beside a Memo import that another Memo still uses", () => {
  const source = `import { observable } from "@legendapp/state";
import { Memo, useValue } from "@legendapp/state/react";

const ui$ = observable({ count: 0, offset: 0 });

export function Row() {
  const offset = useValue(ui$.offset);
  return (
    <div>
      <Memo>{() => <span>{offset}</span>}</Memo>
      <Memo>{() => <b>{ui$.count.get()}</b>}</Memo>
    </div>
  );
}
`;
  const findings = practiceFindings(source, "use-computed-for-parent-reads");
  assert.equal(findings.length, 1);
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { Computed, Memo, useValue } from "@legendapp/state/react";

const ui$ = observable({ count: 0, offset: 0 });

export function Row() {
  const offset = useValue(ui$.offset);
  return (
    <div>
      <Computed>{() => <span>{offset}</span>}</Computed>
      <Memo>{() => <b>{ui$.count.get()}</b>}</Memo>
    </div>
  );
}
`,
    findings,
  );
});

test("reuses an imported Computed and removes the Memo specifier", () => {
  const source = `import { observable } from "@legendapp/state";
import { Computed, Memo, useValue } from "@legendapp/state/react";

const ui$ = observable({ count: 0, offset: 0 });

export function Row() {
  const offset = useValue(ui$.offset);
  return (
    <div>
      <Memo>{() => <span>{offset}</span>}</Memo>
      <Computed>{() => <b>{ui$.count.get()}</b>}</Computed>
    </div>
  );
}
`;
  const findings = practiceFindings(source, "use-computed-for-parent-reads");
  assertVerifiedEdits(
    source,
    `import { observable } from "@legendapp/state";
import { Computed, useValue } from "@legendapp/state/react";

const ui$ = observable({ count: 0, offset: 0 });

export function Row() {
  const offset = useValue(ui$.offset);
  return (
    <div>
      <Computed>{() => <span>{offset}</span>}</Computed>
      <Computed>{() => <b>{ui$.count.get()}</b>}</Computed>
    </div>
  );
}
`,
    findings,
  );
});

test("omits edits when the Memo specifier anchors another rule's import edit", () => {
  const finding = requireValue(
    practiceFindings(
      `import { observable } from "@legendapp/state";
import { useValue, Memo } from "@legendapp/state/react";

const ui$ = observable({ offset: 0 });

export function Row() {
  const offset = useValue(ui$.offset);
  return <Memo>{() => <span>{offset}</span>}</Memo>;
}
`,
      "use-computed-for-parent-reads",
    )[0],
  );
  assert.equal(finding.disposition, "change");
  assert.equal(finding.edits, undefined);
});
