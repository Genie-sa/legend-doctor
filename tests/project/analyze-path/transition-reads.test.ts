import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates a resolved leaf updated outside a named React transition", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-named-transition-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "AvatarLeaf.tsx"),
    `
      export function AvatarLeaf({ url, onChange }: { url: string; onChange: (url: string) => void }) {
        return <input value={url} onChange={event => onChange(event.target.value)} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState, useTransition } from "react";
      import { AvatarLeaf } from "./AvatarLeaf";
      export function Screen() {
        const [url, setUrl] = useState("");
        const [busy, setBusy] = useState(false);
        const [, startSaving] = useTransition();
        const performSave = async () => {
          setBusy(true);
          const steps = [{ run: async () => saveAvatar(url) }];
          await Promise.all(steps.map(step => step.run()));
          setBusy(false);
        };
        const submit = () => startSaving(performSave);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><AvatarLeaf url={url} onChange={setUrl} />
          <button onClick={submit} disabled={busy}>Save</button></main>;
      }
      export function Published() {
        const [publishedUrl, setPublishedUrl] = useState("");
        const [, startSaving] = useTransition();
        const performSave = async () => saveAvatar(publishedUrl);
        const task = { run: performSave };
        const submit = () => startSaving(performSave);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><AvatarLeaf url={publishedUrl} onChange={setPublishedUrl} />
          <Registry task={task} /><button onClick={submit}>Save</button></main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "url")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "busy")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "publishedUrl")).action,
    "review-state",
  );
});

test("keeps nested transition reads when the transition is not event-rooted", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-effect-transition-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "AvatarLeaf.tsx"),
    `
      export function AvatarLeaf({ url, onChange }: { url: string; onChange: (url: string) => void }) {
        return <input value={url} onChange={event => onChange(event.target.value)} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useEffect, useState, useTransition } from "react";
      import { AvatarLeaf } from "./AvatarLeaf";
      export function Screen({ save }: { save: boolean }) {
        const [url, setUrl] = useState("");
        const [, startSaving] = useTransition();
        const performSave = async () => {
          const steps = [{ run: async () => saveAvatar(url) }];
          await Promise.all(steps.map(step => step.run()));
        };
        useEffect(() => {
          if (save) startSaving(performSave);
        }, [save]);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status />
          <Actions /><Preview /><AvatarLeaf url={url} onChange={setUrl} /></main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "url")).action,
    "review-state",
  );
});
