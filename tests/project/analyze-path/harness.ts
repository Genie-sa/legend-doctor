import { mkdtemp, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

export type FindingSignature = [
  HookFinding["hook"],
  HookFinding["name"],
  HookFinding["action"],
  HookFinding["disposition"],
];

export const requireValue = <Value>(value: Value | undefined): Value => {
  assert.ok(value);
  return value;
};

export const CLONE_WRITE_COMPONENT = `
import { observable } from "@legendapp/state";
import { useValue } from "@legendapp/state/react";

const pages$ = observable<Array<{ id: string } | null>>([null]);
const open$ = observable(false);

export function Pages() {
  const pages = useValue(pages$);
  return (
    <button
      onClick={() => pages$.set([...pages$.peek(), { id: "next" }])}
      onFocus={() => open$.set(!open$.peek())}
    >
      {pages.length}
    </button>
  );
}
`;

export async function cloneWriteRoot<Manifest extends object>(
  prefix: string,
  manifest: Manifest,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest), "utf8");
  await writeFile(path.join(root, "pages.tsx"), CLONE_WRITE_COMPONENT, "utf8");
  return root;
}

export const STYLED_SWITCH_PANEL = `
  import * as React from "react";
  import Switch from "./Switch";

  export function Panel({ share, canPublish }: { share: { save(o: object): Promise<void> } | null; canPublish: boolean }) {
    const [creating, setCreating] = React.useState(false);
    const handlePublishedChange = React.useCallback(
      async (checked: boolean) => {
        try {
          setCreating(true);
          await share?.save({ published: checked });
        } finally {
          setCreating(false);
        }
      },
      [share]
    );
    return (
      <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />
        <Switch checked={canPublish} onChange={handlePublishedChange} disabled={!canPublish || creating} />
      </main>
    );
  }
`;

export function styledSwitchWrapper(useCallbackCall: string): string {
  return `
    import * as RadixSwitch from "@radix-ui/react-switch";
    import * as React from "react";
    import * as Lookalike from "./lookalike";
    import styled from "styled-components";

    interface Props {
      checked?: boolean;
      disabled?: boolean;
      onChange?: (checked: boolean) => void;
    }

    function Switch({ checked, disabled, onChange, ...props }: Props, ref: React.Ref<HTMLButtonElement>) {
      const handleCheckedChange = ${useCallbackCall}(
        (checkedState: boolean) => {
          if (onChange) {
            onChange(checkedState);
          }
        },
        [onChange]
      );
      return (
        <StyledSwitchRoot ref={ref} checked={checked} onCheckedChange={handleCheckedChange} disabled={disabled} {...props}>
          <span />
        </StyledSwitchRoot>
      );
    }

    const StyledSwitchRoot = styled(RadixSwitch.Root)<{ width?: number }>\`position: relative;\`;

    export default React.forwardRef(Switch);
  `;
}

export function memoHandlerSwitchWrapper(handlerDeclaration: string): string {
  return `
    import * as RadixSwitch from "@radix-ui/react-switch";
    import * as React from "react";
    import styled from "styled-components";

    interface Props {
      checked?: boolean;
      disabled?: boolean;
      onChange?: (checked: boolean) => void;
    }

    function Switch({ checked, disabled, onChange, ...props }: Props, ref: React.Ref<HTMLButtonElement>) {
      ${handlerDeclaration}
      return (
        <StyledSwitchRoot ref={ref} checked={checked} onCheckedChange={handleCheckedChange} disabled={disabled} {...props}>
          <span />
        </StyledSwitchRoot>
      );
    }

    const StyledSwitchRoot = styled(RadixSwitch.Root)<{ width?: number }>\`position: relative;\`;

    export default React.forwardRef(Switch);
  `;
}
