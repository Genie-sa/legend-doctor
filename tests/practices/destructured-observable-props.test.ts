import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

const IMPORTS = `
  import { observable } from "@legendapp/state";
  import type { Observable } from "@legendapp/state";
  import { useValue } from "@legendapp/state/react";
`;

function practiceActions(body: string): string[] {
  return analyzeLegendPractices({ fileName: "fixture.tsx", sourceText: `${IMPORTS}\n${body}` }).map(
    (finding) => `${finding.location.line - 5} ${finding.action}`,
  );
}

test("a plain prop that reuses a module observable's name is never treated as that observable", () => {
  assert.deepEqual(
    practiceActions(`
      const prefs$ = observable({ theme: "dark", fontSize: 12 });
      export function Header() {
        return <h1>{useValue(prefs$.theme)}</h1>;
      }
      export function Row({ prefs$ }: { prefs$: { theme: string; fontSize: number } }) {
        const prefs = useValue(prefs$);
        const fontSize = useValue(prefs$.fontSize);
        return <button onClick={() => console.log(fontSize)}>{prefs.theme}</button>;
      }
    `),
    [],
  );
});

test("an observable prop that reuses a module observable's name never borrows its plain seed", () => {
  assert.deepEqual(
    practiceActions(`
      const prefs$ = observable({ theme: "dark", fontSize: 12 });
      export function Header() {
        return <h1>{useValue(prefs$.theme)}</h1>;
      }
      interface RowPrefs {
        theme: string;
        fontSize: number;
      }
      export function Row({ prefs$ }: { prefs$: Observable<RowPrefs> }) {
        const fontSize = useValue(prefs$.fontSize);
        const onClick = () => console.log(fontSize);
        return <button onClick={onClick}>log</button>;
      }
    `),
    [],
  );
});

test("destructured props declared observable by their parameter type are observable bindings", () => {
  assert.deepEqual(
    practiceActions(`
      interface Profile {
        name: string;
        email: string;
      }
      interface CardProps {
        profile$: Observable<Profile>;
        label$?: Observable<string>;
      }
      export function Card({ profile$, label$ }: CardProps) {
        const profile = useValue(profile$);
        return <h2>{profile.name}{label$?.get()}</h2>;
      }
    `),
    ["11 narrow-use-value-subscription"],
  );
});

test("Omit, Pick, and intersections keep or drop the observable member they declare", () => {
  assert.deepEqual(
    practiceActions(`
      interface Session {
        mode: string;
      }
      type ToolbarProps = {
        session$: Observable<Session>;
        title: string;
      };
      export function Kept({ session$: kept$ }: Omit<ToolbarProps, "title">) {
        return <b>{kept$.mode.get()}</b>;
      }
      export function Added({ session$: added$ }: Pick<ToolbarProps, "title"> & { session$: Observable<Session> }) {
        return <b>{added$.mode.get()}</b>;
      }
      export function Dropped({ session$: dropped$ }: Omit<ToolbarProps, "session$"> & { session$: Session }) {
        return <b>{dropped$.mode}</b>;
      }
      export function Optional({ session$: optional$ }: { session$?: Observable<Session> }) {
        return <b>{optional$?.mode.get()}</b>;
      }
    `),
    ["10 use-value-for-render-read", "13 use-value-for-render-read"],
  );
});

test("a name counts as observable only while every declaration of it is proven", () => {
  assert.deepEqual(
    practiceActions(`
      interface Session {
        mode: string;
      }
      export function Proven({ session$ }: { session$: Observable<Session> }) {
        return <b>{session$.mode.get()}</b>;
      }
      export function Plain({ session$ }: { session$: { mode: { get(): string } } }) {
        return <b>{session$.mode.get()}</b>;
      }
    `),
    [],
  );
});
