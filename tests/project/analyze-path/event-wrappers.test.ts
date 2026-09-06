import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("resolves a defaulted intrinsic branch through a polymorphic event wrapper", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-polymorphic-event-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Controls.tsx"),
    `
      import { forwardRef } from "react";

      function EagerSlot({ onClick }: { onClick?: () => void }) {
        onClick?.();
        return <span />;
      }

      interface ButtonProps {
        delegate?: boolean;
        disabled: boolean;
        onClick: () => void;
      }

      export const PolymorphicButton = forwardRef<HTMLButtonElement, ButtonProps>(({
        delegate = false,
        disabled,
        ...props
      }, ref) => {
        const Component = delegate ? EagerSlot : "button";
        return <Component ref={ref} aria-disabled={disabled} {...props} />;
      });

      export function MutableButton({ disabled, onClick }: Omit<ButtonProps, "delegate">) {
        let Component = "button";
        return <Component aria-disabled={disabled} onClick={onClick} />;
      }

      export function ReassignedButton({ delegate = false, disabled, onClick }: ButtonProps) {
        for (delegate of [true]) {}
        const Component = delegate ? EagerSlot : "button";
        return <Component aria-disabled={disabled} onClick={onClick} />;
      }

      export function DefaultDialog({ loading, onRun }: { loading: boolean; onRun: () => void }) {
        return <PolymorphicButton disabled={loading} onClick={onRun} />;
      }

      export function SlotDialog({ loading, onRun }: { loading: boolean; onRun: () => void }) {
        return <PolymorphicButton delegate disabled={loading} onClick={onRun} />;
      }

      export function DynamicDialog({ delegate, loading, onRun }: {
        delegate: boolean;
        loading: boolean;
        onRun: () => void;
      }) {
        return <PolymorphicButton delegate={delegate} disabled={loading} onClick={onRun} />;
      }

      export function SpreadDialog({ buttonProps, loading, onRun }: {
        buttonProps: { delegate?: boolean };
        loading: boolean;
        onRun: () => void;
      }) {
        return <PolymorphicButton {...buttonProps} disabled={loading} onClick={onRun} />;
      }

      export function MutableDialog({ loading, onRun }: { loading: boolean; onRun: () => void }) {
        return <MutableButton disabled={loading} onClick={onRun} />;
      }

      export function ReassignedDialog({ loading, onRun }: { loading: boolean; onRun: () => void }) {
        return <ReassignedButton disabled={loading} onClick={onRun} />;
      }

      export function Status({ loading }: { loading: boolean }) {
        return <output>{loading ? "Busy" : "Ready"}</output>;
      }
    `,
    "utf8",
  );
  const broadOwner =
    "<Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><History /><Aside /><Footer /><Actions />";
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { DefaultDialog, DynamicDialog, MutableDialog, ReassignedDialog, SlotDialog, SpreadDialog, Status } from "./Controls";

      export function DefaultScreen() {
        const [loading, setLoading] = useState(false);
        const run = async () => { setLoading(true); await save(); setLoading(false); };
        return <main>${broadOwner}<DefaultDialog loading={loading} onRun={run} /><Status loading={loading} /></main>;
      }

      export function SlotScreen() {
        const [slotLoading, setSlotLoading] = useState(false);
        const run = async () => { setSlotLoading(true); await save(); setSlotLoading(false); };
        return <main>${broadOwner}<SlotDialog loading={slotLoading} onRun={run} /><Status loading={slotLoading} /></main>;
      }

      export function DynamicScreen({ delegate }: { delegate: boolean }) {
        const [dynamicLoading, setDynamicLoading] = useState(false);
        const run = async () => { setDynamicLoading(true); await save(); setDynamicLoading(false); };
        return <main>${broadOwner}<DynamicDialog delegate={delegate} loading={dynamicLoading} onRun={run} /><Status loading={dynamicLoading} /></main>;
      }

      export function SpreadScreen({ buttonProps }: { buttonProps: { delegate?: boolean } }) {
        const [spreadLoading, setSpreadLoading] = useState(false);
        const run = async () => { setSpreadLoading(true); await save(); setSpreadLoading(false); };
        return <main>${broadOwner}<SpreadDialog buttonProps={buttonProps} loading={spreadLoading} onRun={run} /><Status loading={spreadLoading} /></main>;
      }

      export function MutableScreen() {
        const [mutableLoading, setMutableLoading] = useState(false);
        const run = async () => { setMutableLoading(true); await save(); setMutableLoading(false); };
        return <main>${broadOwner}<MutableDialog loading={mutableLoading} onRun={run} /><Status loading={mutableLoading} /></main>;
      }

      export function ReassignedScreen() {
        const [reassignedLoading, setReassignedLoading] = useState(false);
        const run = async () => { setReassignedLoading(true); await save(); setReassignedLoading(false); };
        return <main>${broadOwner}<ReassignedDialog loading={reassignedLoading} onRun={run} /><Status loading={reassignedLoading} /></main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const actions = new Map(report.findings.map((finding) => [finding.name, finding.action]));
  assert.equal(actions.get("loading"), "use-observable");
  assert.equal(actions.get("slotLoading"), "review-state");
  assert.equal(actions.get("dynamicLoading"), "review-state");
  assert.equal(actions.get("spreadLoading"), "review-state");
  assert.equal(actions.get("mutableLoading"), "review-state");
  assert.equal(actions.get("reassignedLoading"), "review-state");
});

test("traces a conditionally selected event callback through prop spreads", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-conditional-event-callback-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Pressable.tsx"),
    `
      import { Pressable } from "react-native";
      export function AppPressable({ onLongPress, ...props }: {
        disabled: boolean;
        onLongPress?: () => void;
        onPress: () => void;
      }) {
        return <Pressable onLongPress={onLongPress} {...props} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "IconButton.tsx"),
    `
      import { AppPressable } from "./Pressable";
      export function IconButton({ loading, ...rest }: {
        loading: boolean;
        onPress: () => void;
      }) {
        return <AppPressable disabled={loading} {...rest} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "ControlBar.tsx"),
    `
      import { IconButton } from "./IconButton";
      type Props = {
        fallback: () => void;
        loading: boolean;
        primary: () => void;
        primaryEnabled: boolean;
      };
      export function ControlBar({ fallback, loading, primary, primaryEnabled }: Props) {
        return <IconButton loading={loading} onPress={primaryEnabled ? primary : fallback} />;
      }
      export function EagerControlBar({ fallback, loading, primary, primaryEnabled }: Props) {
        return <IconButton loading={loading} onPress={primaryEnabled ? primary() : fallback} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useState } from "react";
      import { ControlBar, EagerControlBar } from "./ControlBar";
      export function SafeScreen() {
        const [preparing, setPreparing] = useState(false);
        const prepare = async () => {
          setPreparing(true);
          try { await connect(); } finally { setPreparing(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <ControlBar
            fallback={() => submit()}
            loading={preparing}
            primary={prepare}
            primaryEnabled={featureEnabled}
          />
        </main>;
      }
      export function EagerScreen() {
        const [eagerPreparing, setEagerPreparing] = useState(false);
        const prepare = async () => {
          setEagerPreparing(true);
          try { await connect(); } finally { setEagerPreparing(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <EagerControlBar
            fallback={() => submit()}
            loading={eagerPreparing}
            primary={prepare}
            primaryEnabled={featureEnabled}
          />
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const findings = new Map(report.findings.map((finding) => [finding.name, finding]));
  assert.equal(
    requireValue(findings.get("preparing")).action,
    "use-observable",
    requireValue(findings.get("preparing")).message,
  );
  assert.equal(
    requireValue(findings.get("eagerPreparing")).action,
    "review-state",
    requireValue(findings.get("eagerPreparing")).message,
  );
});
