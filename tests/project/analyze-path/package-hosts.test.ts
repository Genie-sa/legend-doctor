import {
  STYLED_SWITCH_PANEL,
  memoHandlerSwitchWrapper,
  requireValue,
  styledSwitchWrapper,
} from "./harness.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("proves Radix dropdown events through source wrappers without trusting lookalike packages", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-radix-dropdown-events-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "MenuItems.tsx"),
    `
      import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
      import * as LookalikeMenu from "@radix-ui/react-dropdown-menu-addon";
      type Props = { disabled: boolean; onClick: () => void };
      export function MenuItem({ disabled, onClick }: Props) {
        return <DropdownMenu.Item disabled={disabled} onClick={onClick} />;
      }
      export function EagerMenuItem({ disabled, onClick }: Props) {
        onClick();
        return <DropdownMenu.Item disabled={disabled} onClick={onClick} />;
      }
      export function LookalikeMenuItem({ disabled, onClick }: Props) {
        return <LookalikeMenu.Item disabled={disabled} onClick={onClick} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "ShadowedMenuItem.tsx"),
    `
      import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
      type Props = { disabled: boolean; onClick: () => void };
      export function ShadowedMenuItem({
        disabled,
        onClick,
        DropdownMenu,
      }: Props & { DropdownMenu: { Item: (props: Props) => JSX.Element } }) {
        return <DropdownMenu.Item disabled={disabled} onClick={onClick} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screens.tsx"),
    `
      import { useState } from "react";
      import { EagerMenuItem, LookalikeMenuItem, MenuItem } from "./MenuItems";
      import { ShadowedMenuItem } from "./ShadowedMenuItem";
      export function SafeScreen() {
        const [duplicating, setDuplicating] = useState(false);
        const duplicate = async () => {
          setDuplicating(true);
          try { await duplicateWork(); } finally { setDuplicating(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <MenuItem disabled={duplicating} onClick={duplicate} />
        </main>;
      }
      export function EagerScreen() {
        const [eagerDuplicating, setEagerDuplicating] = useState(false);
        const duplicate = async () => {
          setEagerDuplicating(true);
          try { await duplicateWork(); } finally { setEagerDuplicating(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <EagerMenuItem disabled={eagerDuplicating} onClick={duplicate} />
        </main>;
      }
      export function LookalikeScreen() {
        const [lookalikeDuplicating, setLookalikeDuplicating] = useState(false);
        const duplicate = async () => {
          setLookalikeDuplicating(true);
          try { await duplicateWork(); } finally { setLookalikeDuplicating(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <LookalikeMenuItem disabled={lookalikeDuplicating} onClick={duplicate} />
        </main>;
      }
      export function ShadowedScreen() {
        const [shadowedDuplicating, setShadowedDuplicating] = useState(false);
        const duplicate = async () => {
          setShadowedDuplicating(true);
          try { await duplicateWork(); } finally { setShadowedDuplicating(false); }
        };
        return <main>
          <Header/><Toolbar/><Summary/><Fields/><Preview/><Help/><Status/><History/><Aside/><Footer/><Actions/>
          <ShadowedMenuItem
            disabled={shadowedDuplicating}
            DropdownMenu={UnknownMenu}
            onClick={duplicate}
          />
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const findings = new Map(report.findings.map((finding) => [finding.name, finding]));
  assert.equal(
    requireValue(findings.get("duplicating")).action,
    "use-observable",
    requireValue(findings.get("duplicating")).message,
  );
  assert.equal(
    requireValue(findings.get("eagerDuplicating")).action,
    "review-state",
    requireValue(findings.get("eagerDuplicating")).message,
  );
  assert.equal(
    requireValue(findings.get("lookalikeDuplicating")).action,
    "review-state",
    requireValue(findings.get("lookalikeDuplicating")).message,
  );
  assert.equal(
    requireValue(findings.get("shadowedDuplicating")).action,
    "review-state",
    requireValue(findings.get("shadowedDuplicating")).message,
  );
});

test("proves async pending status through a React.useCallback adapter and a plain styled package host", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-styled-switch-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "lookalike.ts"),
    "export const useCallback = (fn: unknown, deps: unknown) => fn;",
    "utf8",
  );
  await writeFile(path.join(root, "Switch.tsx"), styledSwitchWrapper("React.useCallback"), "utf8");
  await writeFile(path.join(root, "Panel.tsx"), STYLED_SWITCH_PANEL, "utf8");

  const report = await analyzePath(root);
  const creating = report.findings.find((finding) => finding.name === "creating");
  assert.equal(requireValue(creating).action, "use-observable");
});

test("keeps async pending status under review behind a lookalike namespace useCallback", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-lookalike-callback-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "lookalike.ts"),
    "export const useCallback = (fn: unknown, deps: unknown) => fn;",
    "utf8",
  );
  await writeFile(
    path.join(root, "Switch.tsx"),
    styledSwitchWrapper("Lookalike.useCallback"),
    "utf8",
  );
  await writeFile(path.join(root, "Panel.tsx"), STYLED_SWITCH_PANEL, "utf8");

  const report = await analyzePath(root);
  const creating = report.findings.find((finding) => finding.name === "creating");
  assert.equal(requireValue(creating).action, "review-state");
});

test("proves async pending status through a concise React.useMemo handler factory", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-memo-handler-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Switch.tsx"),
    memoHandlerSwitchWrapper(
      "const handleCheckedChange = React.useMemo(() => (checkedState: boolean) => { onChange?.(checkedState); }, [onChange]);",
    ),
    "utf8",
  );
  await writeFile(path.join(root, "Panel.tsx"), STYLED_SWITCH_PANEL, "utf8");

  const report = await analyzePath(root);
  const creating = report.findings.find((finding) => finding.name === "creating");
  assert.equal(requireValue(creating).action, "use-observable");
});

test("keeps async pending status under review behind a block-bodied useMemo handler factory", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-memo-block-handler-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "Switch.tsx"),
    memoHandlerSwitchWrapper(
      "const handleCheckedChange = React.useMemo(() => { return (checkedState: boolean) => { onChange?.(checkedState); }; }, [onChange]);",
    ),
    "utf8",
  );
  await writeFile(path.join(root, "Panel.tsx"), STYLED_SWITCH_PANEL, "utf8");

  const report = await analyzePath(root);
  const creating = report.findings.find((finding) => finding.name === "creating");
  assert.equal(requireValue(creating).action, "review-state");
});
