import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("traces a command payload through memoized options and source component wrappers", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-option-command-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "useShortcut.ts"),
    `
      import { useEffect } from "react";
      export function useShortcut(callback: () => void) {
        useEffect(() => subscribe(callback), [callback]);
      }
      export function useOptionShortcut({ options }: { options: { onConfirm: () => void } }) {
        useShortcut(() => options.onConfirm());
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Button.tsx"),
    `
      function ButtonBase({ onPress = () => {} }: { onPress?: () => void }) {
        return <button onClick={onPress}>Confirm</button>;
      }
      const Button = Object.assign(ButtonBase, { Text: () => null });
      export default Button;
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Footer.tsx"),
    `
      import React from "react";
      import Button from "./Button";
      import { useShortcut } from "./useShortcut";
      type Options = { onConfirm: () => void };
      function Footer({ options }: { options?: Options }) {
        const { onConfirm } = options ?? {};
        useShortcut(onConfirm!);
        return <Button onPress={onConfirm}>Confirm</Button>;
      }
      export default React.memo(Footer) as typeof Footer;
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Selection.tsx"),
    `
      import Footer from "./Footer";
      import { useOptionShortcut } from "./useShortcut";
      type Options = { onConfirm: () => void };
      export function Selection({ ref, ...props }: { ref?: unknown; options: Options }) {
        return <BaseSelection {...props} />;
      }
      function BaseSelection(props: { options: Options }) {
        return <SelectionImpl {...props} />;
      }
      function SelectionImpl({ options }: { options: Options }) {
        useOptionShortcut({ options });
        return <Footer options={options} />;
      }
      export function EagerSelection({ options }: { options: Options }) {
        options.onConfirm();
        return <button>Unsafe</button>;
      }
      function EagerButton({ onConfirm }: { onConfirm: () => void }) {
        onConfirm();
        return <button>Unsafe wrapper</button>;
      }
      export function EagerPropSelection({ options }: { options: Options }) {
        return <EagerButton onConfirm={options.onConfirm} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useCallback, useEffect, useMemo, useState } from "react";
      import { EagerPropSelection, EagerSelection, Selection } from "./Selection";
      export function SafeScreen() {
        const [payload, setPayload] = useState<string>();
        useEffect(() => load((value: string) => setPayload(value)), []);
        const confirm = useCallback(() => send(payload), [payload]);
        const onConfirm = useCallback(() => prompt().then(() => confirm()), [confirm]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <Selection options={options} />;
      }
      export function UnsafeScreen() {
        const [unsafePayload, setUnsafePayload] = useState<string>();
        useEffect(() => load((value: string) => setUnsafePayload(value)), []);
        const confirm = useCallback(() => send(unsafePayload), [unsafePayload]);
        const onConfirm = useCallback(() => prompt().then(() => confirm()), [confirm]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <EagerSelection options={options} />;
      }
      export function UnsafePropScreen() {
        const [unsafePropPayload, setUnsafePropPayload] = useState<string>();
        useEffect(() => load((value: string) => setUnsafePropPayload(value)), []);
        const confirm = useCallback(() => send(unsafePropPayload), [unsafePropPayload]);
        const onConfirm = useCallback(() => prompt().then(() => confirm()), [confirm]);
        const options = useMemo(() => ({ onConfirm }), [onConfirm]);
        return <EagerPropSelection options={options} />;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "payload")).action,
    "use-ref",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "unsafePayload")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "unsafePropPayload")).action,
    "review-state",
  );
});

test("proves memoized option commands through a resolved deferred child", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-option-command-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "useDeferredHandler.ts"),
    `
      import { useEffect } from "react";
      export function useDeferredHandler(callback: () => void) {
        useEffect(() => {
          window.addEventListener("click", callback);
          return () => window.removeEventListener("click", callback);
        }, [callback]);
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "ActionMenu.tsx"),
    `
      import { useDeferredHandler } from "./useDeferredHandler";
      export function ActionMenu({ ref, ...props }: { ref?: unknown; options: Array<{ onSelected?: () => void }> }) {
        const { options } = props;
        const first = options.at(0);
        const runFirst = () => first?.onSelected?.();
        useDeferredHandler(() => runFirst());
        return <section>
          <button onClick={runFirst}>Run</button>
          <Menu items={options.map(item => ({ ...item, onSelected: () => item.onSelected?.() }))} />
        </section>;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "ImmediateMenu.tsx"),
    `
      import { useEffect } from "react";
      export function ImmediateMenu({ options }: { options: Array<{ onSelected?: () => void }> }) {
        const first = options.at(0);
        first?.onSelected?.();
        useEffect(() => first?.onSelected?.(), [first]);
        return <section />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "SynchronousMenu.tsx"),
    `
      export function SynchronousMenu({ options }: { options: Array<{ onSelected?: () => void }> }) {
        options.map(item => runImmediately(() => item.onSelected?.()));
        return <section />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "UnknownHookMenu.tsx"),
    `
      export function UnknownHookMenu({ options }: { options: Array<{ onSelected?: () => void }> }) {
        const first = options.at(0);
        const runFirst = () => first?.onSelected?.();
        useLibraryLifecycle(() => runFirst());
        return <section />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useMemo, useState } from "react";
      import { ActionMenu } from "./ActionMenu";
      import { ImmediateMenu } from "./ImmediateMenu";
      import { SynchronousMenu } from "./SynchronousMenu";
      import { UnknownHookMenu } from "./UnknownHookMenu";
      function DecisionModal(_props: unknown) { return null; }
      export function SafeScreen() {
        const [visible, setVisible] = useState(false);
        const options = useMemo(() => [{ onSelected: () => download(() => setVisible(true)) }], []);
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          {options.length > 0 && <ActionMenu options={options} />}
          <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
        </main>;
      }
      export function UnsafeScreen() {
        const [unsafeVisible, setUnsafeVisible] = useState(false);
        const options = useMemo(() => [{ onSelected: () => download(() => setUnsafeVisible(true)) }], []);
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          <ImmediateMenu options={options} />
          <DecisionModal isVisible={unsafeVisible} onClose={() => setUnsafeVisible(false)} />
        </main>;
      }
      export function SynchronousScreen() {
        const [syncVisible, setSyncVisible] = useState(false);
        const options = useMemo(() => [{ onSelected: () => download(() => setSyncVisible(true)) }], []);
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          <SynchronousMenu options={options} />
          <DecisionModal isVisible={syncVisible} onClose={() => setSyncVisible(false)} />
        </main>;
      }
      export function UnknownHookScreen() {
        const [hookVisible, setHookVisible] = useState(false);
        const options = useMemo(() => [{ onSelected: () => download(() => setHookVisible(true)) }], []);
        ${"\n".repeat(100)}
        return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
          <UnknownHookMenu options={options} />
          <DecisionModal isVisible={hookVisible} onClose={() => setHookVisible(false)} />
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "visible")).action,
    "use-observable",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "unsafeVisible")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "syncVisible")).action,
    "review-state",
  );
  assert.equal(
    requireValue(report.findings.find((finding) => finding.name === "hookVisible")).action,
    "review-state",
  );
});
