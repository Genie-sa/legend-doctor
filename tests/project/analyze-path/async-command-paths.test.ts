import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("proves every async command path through source wrappers and inline event adapters", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-async-wrapper-stack-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Button.tsx"),
    `
      function EagerSlot({ onClick }: { onClick: () => void }) {
        onClick();
        return <span />;
      }
      export function Button({ asChild = false, ...props }: {
        asChild?: boolean;
        disabled: boolean;
        onClick: () => void;
      }) {
        const Component = asChild ? EagerSlot : "button";
        return <Component {...props} />;
      }
      export function AlertButton({ children, ...props }: {
        asChild?: boolean;
        children: React.ReactNode;
        disabled: boolean;
        onClick: () => void;
      }) {
        return <div><Button {...props}>{children}</Button></div>;
      }
    `,
  );
  await writeFile(
    path.join(root, "DeleteDialog.tsx"),
    `
      import { Button } from "./Button";
      export function DeleteDialog({ deleting, onDelete }: {
        deleting: boolean;
        onDelete: () => void;
      }) {
        return <aside><Button disabled={deleting} onClick={onDelete} /></aside>;
      }
    `,
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { AlertButton, Button } from "./Button";
      import { DeleteDialog } from "./DeleteDialog";
      export function Screen() {
        const [deleting, setDeleting] = useState(false);
        const remove = async () => {
          setDeleting(true);
          try { await destroy(); } finally { setDeleting(false); }
        };
        return <main>
          <Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status />
          <DeleteDialog deleting={deleting} onDelete={remove} />
          <form onSubmit={async event => { event.preventDefault(); await remove(); }} />
        </main>;
      }

      export function EagerCaller() {
        const [eagerDeleting, setEagerDeleting] = useState(false);
        const remove = async () => {
          setEagerDeleting(true);
          try { await destroy(); } finally { setEagerDeleting(false); }
        };
        remove();
        return <main>
          <Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status />
          <DeleteDialog deleting={eagerDeleting} onDelete={remove} />
        </main>;
      }

      export function InlineAdapter() {
        const [saving, setSaving] = useState(false);
        const save = async () => {
          setSaving(true);
          try { await persist(); } finally { setSaving(false); }
        };
        return <main>
          <Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status />
          <Button disabled={saving} onClick={() => { void save(); }} />
        </main>;
      }

      export function EagerInlineAdapter() {
        const [eagerSaving, setEagerSaving] = useState(false);
        const save = async () => {
          setEagerSaving(true);
          try { await persist(); } finally { setEagerSaving(false); }
        };
        return <main>
          <Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status />
          <Button asChild disabled={eagerSaving} onClick={() => { void save(); }} />
        </main>;
      }

      export function RestForwardedInlineAdapter() {
        const [alertSaving, setAlertSaving] = useState(false);
        const save = async () => {
          setAlertSaving(true);
          try { await persist(); } finally { setAlertSaving(false); }
        };
        return <main>
          <Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status />
          <AlertButton disabled={alertSaving} onClick={() => { void save(); }}>Save</AlertButton>
        </main>;
      }

      export function EagerRestForwardedInlineAdapter() {
        const [eagerAlertSaving, setEagerAlertSaving] = useState(false);
        const save = async () => {
          setEagerAlertSaving(true);
          try { await persist(); } finally { setEagerAlertSaving(false); }
        };
        return <main>
          <Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions /><Status />
          <AlertButton asChild disabled={eagerAlertSaving} onClick={() => { void save(); }}>Save</AlertButton>
        </main>;
      }
    `,
  );

  const report = await analyzePath(root);
  const findings = new Map(report.findings.map((finding) => [finding.name, finding]));
  assert.equal(
    requireValue(findings.get("deleting")).action,
    "use-observable",
    requireValue(findings.get("deleting")).message,
  );
  assert.equal(
    requireValue(findings.get("saving")).action,
    "use-observable",
    requireValue(findings.get("saving")).message,
  );
  assert.equal(
    requireValue(findings.get("alertSaving")).action,
    "use-observable",
    requireValue(findings.get("alertSaving")).message,
  );
  assert.equal(
    requireValue(findings.get("eagerDeleting")).action,
    "review-state",
    requireValue(findings.get("eagerDeleting")).message,
  );
  assert.equal(
    requireValue(findings.get("eagerSaving")).action,
    "review-state",
    requireValue(findings.get("eagerSaving")).message,
  );
  assert.equal(
    requireValue(findings.get("eagerAlertSaving")).action,
    "review-state",
    requireValue(findings.get("eagerAlertSaving")).message,
  );
});

test("traces an async command through a child action array", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-action-array-command-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Button.tsx"),
    `
      export function Button({ onClick, loading }: { onClick?: () => void; loading: boolean }) {
        return <button onClick={onClick}>{String(loading)}</button>;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "ActionBar.tsx"),
    `
      import { Button } from "./Button";
      type Action = { loading: boolean; onClick?: () => void; visible: boolean };
      export function ActionBar({ actions }: { actions: Action[] }) {
        const visible = actions.filter(candidate => candidate.visible);
        return <nav>{visible.map(action =>
          <Button key={String(action.loading)} loading={action.loading} onClick={action.onClick} />
        )}</nav>;
      }
      export function EagerActionBar({ actions }: { actions: Action[] }) {
        actions.forEach(candidate => candidate.onClick?.());
        return <nav>{actions.map(action => <span>{String(action.loading)}</span>)}</nav>;
      }
      export function EscapingActionBar({ actions }: { actions: Action[] }) {
        return <nav>{actions.map(action => {
          inspect(action);
          return <Button key={String(action.loading)} loading={action.loading} onClick={action.onClick} />;
        })}</nav>;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "ControlBar.tsx"),
    `
      import { ActionBar, EagerActionBar, EscapingActionBar } from "./ActionBar";
      export function ControlBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
        const actions = [{ loading: saving, onClick: onSave, visible: true }];
        return <ActionBar actions={actions} />;
      }
      export function EagerControlBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
        const actions = [{ loading: saving, onClick: onSave, visible: true }];
        return <EagerActionBar actions={actions} />;
      }
      export function EscapingControlBar({ saving, onSave }: { saving: boolean; onSave: () => void }) {
        const actions = [{ loading: saving, onClick: onSave, visible: true }];
        return <EscapingActionBar actions={actions} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useState } from "react";
      import { ControlBar, EagerControlBar, EscapingControlBar } from "./ControlBar";
      export function SafeScreen() {
        const [saving, setSaving] = useState(false);
        const save = async () => {
          setSaving(true);
          try { await persist(); } finally { setSaving(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <ControlBar saving={saving} onSave={save} />
        </main>;
      }
      export function EagerScreen() {
        const [eagerSaving, setEagerSaving] = useState(false);
        const save = async () => {
          setEagerSaving(true);
          try { await persist(); } finally { setEagerSaving(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <EagerControlBar saving={eagerSaving} onSave={save} />
        </main>;
      }
      export function EscapingScreen() {
        const [escapingSaving, setEscapingSaving] = useState(false);
        const save = async () => {
          setEscapingSaving(true);
          try { await persist(); } finally { setEscapingSaving(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <EscapingControlBar saving={escapingSaving} onSave={save} />
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const findings = new Map(report.findings.map((finding) => [finding.name, finding]));
  assert.equal(
    requireValue(findings.get("saving")).action,
    "use-observable",
    requireValue(findings.get("saving")).message,
  );
  assert.equal(
    requireValue(findings.get("eagerSaving")).action,
    "review-state",
    requireValue(findings.get("eagerSaving")).message,
  );
  assert.equal(
    requireValue(findings.get("escapingSaving")).action,
    "review-state",
    requireValue(findings.get("escapingSaving")).message,
  );
});
