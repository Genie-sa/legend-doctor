import { agentFindings } from "../../src/report/format.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates property-local object draft edits without splitting coupled commands", () => {
  const findings = analyzeSource(
    `
    import { useEffect, useState } from "react";
    interface Draft { title: string; notes: string; }
    const EMPTY_DRAFT: Draft = { title: "", notes: "" };
    const BASE_DRAFT: Draft = { title: "", notes: "" };
    export function Form() {
      const [draft, setDraft] = useState(EMPTY_DRAFT);
      const submit = () => save(draft.title, draft.notes);
      return <form onSubmit={submit}>
        <Header /><Summary /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Metrics />
        <input value={draft.title} onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} />
        <textarea value={draft.notes} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} />
        <button disabled={!draft.title}>Save</button>
      </form>;
    }
    export function CoupledForm() {
      const [draft, setDraft] = useState(EMPTY_DRAFT);
      const [dirty, setDirty] = useState(false);
      return <main><Header /><Summary /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Metrics />
        <input value={draft.title} onChange={event => {
          setDraft(previous => ({ ...previous, title: event.target.value }));
          setDirty(true);
        }} />
        <output>{draft.notes}{String(dirty)}</output>
      </main>;
    }
    export function EffectOwnedForm() {
      const [draft, setDraft] = useState(EMPTY_DRAFT);
      useEffect(() => report(draft.title), [draft.title]);
      return <main><Header /><Summary /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Metrics />
        <input value={draft.title} onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} />
        <output>{draft.notes}</output>
      </main>;
    }
    export function TransportedForm() {
      const [draft, setDraft] = useState(EMPTY_DRAFT);
      return <main><Header /><Summary /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Metrics />
        <Editor draft={draft} onChange={setDraft} />
      </main>;
    }
    export function OpaqueCallbackForm() {
      const [draft, setDraft] = useState(EMPTY_DRAFT);
      const submit = () => save(draft.title, draft.notes);
      return <main><Header /><Summary /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Metrics />
        <Field value={draft.title} onChange={value => setDraft(previous => ({ ...previous, title: value }))} />
        <Field value={draft.notes} onChange={value => setDraft(previous => ({ ...previous, notes: value }))} />
        <button onClick={submit}>Save</button>
      </main>;
    }
    export function ShadowedSeed({ BASE_DRAFT }: { BASE_DRAFT: Draft }) {
      const [draft, setDraft] = useState(BASE_DRAFT);
      const submit = () => save(draft.title, draft.notes);
      return <main><Header /><Summary /><Help /><Preview /><History /><Status /><Aside /><Footer /><Actions /><Metrics />
        <input value={draft.title} onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} />
        <textarea value={draft.notes} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} />
        <button onClick={submit}>Save</button>
      </main>;
    }
  `,
    "fixture.tsx",
  );

  assert.equal(
    requireValue(findings.find((finding) => finding.name === "draft")).action,
    "use-observable",
  );
  assert.match(
    requireValue(findings.find((finding) => finding.name === "draft")).message ?? "",
    /property leaf/u,
  );
  for (const draftFinding of findings.filter((candidate) => candidate.name === "draft").slice(1)) {
    assert.doesNotMatch(draftFinding.message, /object draft/u);
  }
});

test("groups a co-written cursor and editable name into one observable draft", () => {
  const source = (independentCursorWrite: string, extraControl = ""): string => `
    import { useCallback, useState } from "react";
    interface Item { id: string; name: string }
    function Screen({ items }: { items: Item[] }) {
      const [draftId, setDraftId] = useState<string | null>(null);
      const [draftName, setDraftName] = useState("");
      const begin = useCallback((item: Item) => {
        setDraftId(item.id);
        setDraftName(item.name);
      }, []);
      const finish = useCallback(() => {
        if (!draftId) return;
        save(draftId, draftName.trim());
        setDraftId(null);
      }, [draftId, draftName]);
      ${independentCursorWrite}
      ${"\n".repeat(100)}
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button disabled={draftId !== null} onClick={() => begin(items[0]!)}>Add</button>
        ${extraControl}
        {items.map(item => item.id === draftId
          ? <Editor key={item.id} value={draftName} onChange={value => setDraftName(value)} onBlur={finish} />
          : <Row key={item.id} item={item} onRename={() => begin(item)} />)}
      </main>;
    }
  `;
  const findings = analyzeSource(source(""), "fixture.tsx");
  const grouped = findings.filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, ["draftId", "draftName"]);
  assert.match(requireValue(grouped[0]).message ?? "", /atomic/iu);
  assert.equal(agentFindings(findings).filter((finding) => finding.group).length, 1);

  const closeOnly = analyzeSource(
    source("const close = () => setDraftId(null);", "<button onClick={close}>Close</button>"),
    "fixture.tsx",
  );
  const closeOnlyFinding = requireValue(closeOnly.find((finding) => finding.name === "draftId"));
  assert.deepEqual(requireValue(closeOnlyFinding.group).members, ["draftId", "draftName"]);

  const staleDraft = analyzeSource(
    source(
      "const switchWithoutDraft = () => setDraftId(items[0]!.id);",
      "<button onClick={switchWithoutDraft}>Switch</button>",
    ),
    "fixture.tsx",
  );
  const staleDraftFinding = requireValue(staleDraft.find((finding) => finding.name === "draftId"));
  assert.notEqual(
    staleDraftFinding.group && staleDraftFinding.group.members.join(","),
    "draftId,draftName",
  );
});

test("groups selection mode with its independently editable ID collection", () => {
  const source = (partialModeWrite: string): string => `
    import { useCallback, useState } from "react";
    function Screen({ rows }: { rows: Array<{ id: number }> }) {
      const [selectionMode, setSelectionMode] = useState(false);
      const [selectedIds, setSelectedIds] = useState<number[]>([]);
      const enter = useCallback(() => {
        setSelectionMode(true);
        setSelectedIds([]);
      }, []);
      const cancel = useCallback(() => {
        setSelectionMode(false);
        setSelectedIds([]);
      }, []);
      const toggle = useCallback((id: number) => {
        setSelectedIds(previous => previous.includes(id)
          ? previous.filter(value => value !== id)
          : [...previous, id]);
      }, []);
      ${partialModeWrite}
      ${"\n".repeat(100)}
      return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help />
        <SelectionHeader active={selectionMode} count={selectedIds.length} onEnter={enter} onCancel={cancel} />
        {rows.map(row => <Row key={row.id} selected={selectedIds.includes(row.id)} onToggle={() => toggle(row.id)} />)}
      </main>;
    }
  `;
  const findings = analyzeSource(source(""), "fixture.tsx");
  const grouped = findings.filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, [
    "selectionMode",
    "selectedIds",
  ]);
  assert.match(requireValue(grouped[0]).message ?? "", /atomic/iu);
  assert.equal(agentFindings(findings).filter((finding) => finding.group).length, 1);

  const unsafe = analyzeSource(
    source("const suspend = () => setSelectionMode(false);"),
    "fixture.tsx",
  );
  const unsafeFinding = requireValue(unsafe.find((finding) => finding.name === "selectionMode"));
  assert.notEqual(
    unsafeFinding.group && unsafeFinding.group.members.join(","),
    "selectionMode,selectedIds",
  );
});

test("does not merge mutually exclusive switch branches into one state cluster", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    interface Item { id: string }
    function ItemDialog(_props: unknown) { return null; }
    function EditDialog(_props: unknown) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [editTarget, setEditTarget] = useState<Item | null>(null);
      const [linkTarget, setLinkTarget] = useState<Item | null>(null);
      const [linkOpen, setLinkOpen] = useState(false);
      const act = (kind: "edit" | "link") => {
        switch (kind) {
          case "edit": setEditTarget(item); return;
          case "link": setLinkTarget(item); setLinkOpen(true); return;
        }
      };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions />
        <EditDialog target={editTarget} onAct={act} />
        <ItemDialog target={linkTarget} open={linkOpen} onOpenChange={setLinkOpen} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const primary = findings.find((finding) => finding.group && finding.group.primary);
  assert.deepEqual(requireValue(requireValue(primary).group).members, ["linkTarget", "linkOpen"]);
  assert.equal(
    requireValue(findings.find((finding) => finding.name === "editTarget")).group,
    undefined,
  );
});
