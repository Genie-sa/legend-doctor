import type { FormEvent, ReactElement } from "react";
import { act, createElement as jsx, useState } from "react";
import { count, mountDom } from "../../src/runtime/dom.js";
import { useObservable, useValue } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import assert from "node:assert/strict";
import test from "node:test";

interface Draft {
  name: string;
  color: string;
}
interface FormProps {
  renders: Map<string, number>;
  saved: string[];
  completion: Promise<void>;
}
interface FieldProps {
  name: string;
  value: string;
  change: (value: string) => void;
  renders: Map<string, number>;
}

function Field({ name, value, change, renders }: FieldProps): ReactElement {
  count(renders, name);
  return jsx("input", {
    name,
    value,
    onInput: (event: FormEvent<HTMLInputElement>) => change(event.currentTarget.value),
  });
}

function Help({ renders }: Pick<FormProps, "renders">): ReactElement {
  count(renders, "help");
  return jsx("aside", null, "Complete your profile");
}

function ReactForm({ renders, saved, completion }: FormProps): ReactElement {
  count(renders, "owner");
  const [draft, setDraft] = useState<Draft>({ name: "", color: "blue" });
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    await completion;
    saved.push(draft.name);
  }
  return jsx(
    "form",
    { onSubmit: save },
    jsx(Help, { renders }),
    jsx(Field, {
      name: "name",
      value: draft.name,
      change: (name) => setDraft({ ...draft, name }),
      renders,
    }),
    jsx(Field, {
      name: "color",
      value: draft.color,
      change: (color) => setDraft({ ...draft, color }),
      renders,
    }),
    jsx("button", { type: "submit", disabled: !draft.name.trim() }, "Save"),
  );
}

function ObservableField({
  name,
  value$,
  renders,
}: Omit<FieldProps, "value" | "change"> & { value$: Observable<string> }): ReactElement {
  return jsx(Field, {
    name,
    value: useValue(value$),
    change: (value) => value$.set(value),
    renders,
  });
}

function SaveButton({ draft$ }: { draft$: Observable<Draft> }): ReactElement {
  return jsx(
    "button",
    { type: "submit", disabled: useValue(() => !draft$.name.get().trim()) },
    "Save",
  );
}

function LegendForm({ renders, saved, completion }: FormProps): ReactElement {
  count(renders, "owner");
  const draft$ = useObservable<Draft>({ name: "", color: "blue" });
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    const snapshot = { ...draft$.peek() };
    await completion;
    saved.push(snapshot.name);
  }
  return jsx(
    "form",
    { onSubmit: save },
    jsx(Help, { renders }),
    jsx(ObservableField, { name: "name", value$: draft$.name, renders }),
    jsx(ObservableField, { name: "color", value$: draft$.color, renders }),
    jsx(SaveButton, { draft$ }),
  );
}

for (const strict of [false, true]) {
  test(`form migration preserves pending-submit snapshots and isolates field renders (strict=${strict})`, async (context) => {
    const ui = mountDom(context, strict);
    for (const Component of [ReactForm, LegendForm]) {
      const renders = new Map<string, number>();
      const saved: string[] = [];
      let release: () => void = () => {
        throw new Error("Completion not initialized");
      };
      // oxlint-disable-next-line promise/avoid-new -- The test controls the exact async completion boundary.
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      await ui.render(jsx(Component, { renders, saved, completion }));
      assert.equal(ui.element("button").hasAttribute("disabled"), true);
      renders.clear();
      await ui.input('[name="name"]', "Ada");
      assert.equal(ui.element("button").hasAttribute("disabled"), false);
      assert.ok((renders.get("name") ?? 0) > 0);
      for (const unaffected of ["owner", "help", "color"]) {
        assert.equal((renders.get(unaffected) ?? 0) > 0, Component === ReactForm, unaffected);
      }
      await ui.submit();
      await ui.input('[name="name"]', "Grace");
      assert.deepEqual(saved, []);
      await act(() => release());
      assert.deepEqual(saved, ["Ada"], "the pending command keeps its original draft");
      await ui.input('[name="name"]', " ");
      assert.equal(ui.element("button").hasAttribute("disabled"), true);
      await ui.render(null);
    }
  });
}
