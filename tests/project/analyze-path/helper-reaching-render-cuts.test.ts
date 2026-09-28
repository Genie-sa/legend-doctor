import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

async function actionOf(
  root: string,
  files: Readonly<Record<string, string>>,
  name: string,
): Promise<string> {
  await Promise.all(
    Object.entries(files).map(([file, source]) => writeFile(path.join(root, file), source, "utf8")),
  );
  const report = await analyzePath(root);
  return requireValue(report.findings.find((finding) => finding.name === name)).action;
}

const QUICK_SEARCH = `
  export function QuickSearch({ onChange }: { onChange: (value: string) => void }) {
    return <input onChange={event => onChange(event.target.value.trim().toLowerCase())} />;
  }
`;

function filteredScreen(avatar: string, outside: string): string {
  return `
    import { useState } from "react";
    import { QuickSearch } from "./QuickSearch";
    type User = { current: boolean; id: string; name?: string };
    export function Screen({ users, mobile }: { users: User[]; mobile: boolean }) {
      const [query, setQuery] = useState("");
      const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
      const currentUser = users.find(user => user.current);
      const otherUsers = users.filter(user => !user.current);
      const visibleUsers = otherUsers.slice(0, 8);
      const shownUsers = currentUser ? [...visibleUsers, currentUser] : visibleUsers;
      const renderCard = (user: User) => <Card><Avatar user={user} /><Name /><Role /><Badge /><Presence /><Since /><Team /></Card>;
      const avatars = shownUsers.map(user => {
        const avatar = ${avatar};
        if (!user.current) return avatar;
        return <Popover key={user.id}><Trigger>{avatar}</Trigger><Content>
          <QuickSearch onChange={setQuery} />
          <List>{filtered.length ? filtered.map(item => <Row key={item.id} item={item} />) : null}</List>
        </Content></Popover>;
      });
      return mobile
        ? <Mobile>{users.map(user => <Avatar key={user.id} user={user} />)}</Mobile>
        : <Desktop><Header />${outside}{avatars}</Desktop>;
    }
  `;
}

test("keeps a filtered control up when its repeated producer calls a large owner-local helper", async (testContext) => {
  const control = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-helper-filter-"));
  const adversarial = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-helper-filter-"));
  testContext.after(() =>
    Promise.all([control, adversarial].map((root) => rm(root, { force: true, recursive: true }))),
  );
  assert.equal(
    await actionOf(
      control,
      {
        "QuickSearch.tsx": QUICK_SEARCH,
        "Screen.tsx": filteredScreen(
          "<Avatar user={user} />",
          "<Card><Avatar /><Name /><Role /><Badge /><Presence /><Since /><Team /></Card>",
        ),
      },
      "query",
    ),
    "use-observable",
  );
  assert.notEqual(
    await actionOf(
      adversarial,
      { "QuickSearch.tsx": QUICK_SEARCH, "Screen.tsx": filteredScreen("renderCard(user)", "") },
      "query",
    ),
    "use-observable",
  );
});

const NATIVE_HOST = `
  import { requireNativeComponent } from "react-native";
  export const NativeHost = requireNativeComponent<{
    onNativeLayout?: (event: { nativeEvent: { width: number } }) => void;
    children?: React.ReactNode;
  }>("NativeHost");
`;

const MEASURED_SHELL = `
  import { NativeHost } from "./NativeHost";
  export function MeasuredShell({ onLayout, children }: {
    onLayout: (layout: { width: number }) => void;
    children: React.ReactNode;
  }) {
    return <NativeHost onNativeLayout={onLayout ? event => onLayout(event.nativeEvent) : undefined}>{children}</NativeHost>;
  }
`;

interface MeasuredSurfaces {
  readonly helpers: string;
  readonly label: string;
  readonly marks: string;
  readonly outside: string;
}

function measuredScreen({ helpers, label, marks, outside }: MeasuredSurfaces): string {
  return `
    import { useCallback, useState } from "react";
    import { MeasuredShell } from "./MeasuredShell";
    export function Screen({ native }: { native: boolean }) {
      const [outerWidth, setOuterWidth] = useState(0);
      const width = Math.max(outerWidth - 8, 0);
      const onLayout = useCallback(
        (layout: { width: number }) => setOuterWidth(layout.width),
        [setOuterWidth],
      );
      ${helpers}
      if (native) {
        return <MeasuredShell onLayout={onLayout}>
          <label style={{ width: width + 2 }}>${label}</label>
          <div style={{ width }}><span/><span/>${marks}</div>
          <aside/><footer/><header/><main/><nav/><output/><section/><strong/><em/>${outside}
        </MeasuredShell>;
      }
      return <main><span/><span/><span/></main>;
    }
  `;
}

test("keeps an event measurement up when its leaves call owner-local helpers", async (testContext) => {
  const temporaryRoot = (): Promise<string> =>
    mkdtemp(path.join(os.tmpdir(), "legend-doctor-helper-scalar-"));
  const control = await temporaryRoot();
  const oversizedLeaf = await temporaryRoot();
  const oversizedShare = await temporaryRoot();
  testContext.after(() =>
    Promise.all(
      [control, oversizedLeaf, oversizedShare].map((root) =>
        rm(root, { force: true, recursive: true }),
      ),
    ),
  );
  const shared = { "MeasuredShell.tsx": MEASURED_SHELL, "NativeHost.tsx": NATIVE_HOST };
  const smallHelpers = `
    const renderIcon = () => <svg><path/><path/><path/><path/></svg>;
    const renderMarks = () => <ol><li/><li/></ol>;
  `;
  const measured = (root: string, surfaces: MeasuredSurfaces): Promise<string> =>
    actionOf(root, { ...shared, "Screen.tsx": measuredScreen(surfaces) }, "outerWidth");

  assert.equal(
    await measured(control, {
      helpers: smallHelpers,
      label: "",
      marks: "",
      outside: "{renderIcon()}{renderMarks()}",
    }),
    "use-observable",
  );
  assert.notEqual(
    await measured(oversizedLeaf, {
      helpers: "const renderMarks = () => <ol><a/><b/><i/><s/><u/><q/><p/><dl/><dt/><dd/></ol>;",
      label: "",
      marks: "{renderMarks()}",
      outside: "",
    }),
    "use-observable",
  );
  assert.notEqual(
    await measured(oversizedShare, {
      helpers: smallHelpers,
      label: "{renderIcon()}",
      marks: "{renderMarks()}",
      outside: "",
    }),
    "use-observable",
  );
});
