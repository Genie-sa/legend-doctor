import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

test("isolates a compact transported leaf only with an independent sibling render cut", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-compact-leaf-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "NativeMenu.tsx"),
    `
      import { NativeRoot } from "native-menu";
      export function NativeMenu({ expanded, onDismiss }: { expanded: boolean; onDismiss: () => void }) {
        return <NativeRoot expanded={expanded} onDismiss={onDismiss} />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { NativeMenu } from "./NativeMenu";
      export function CompactMenu() {
        const [expanded, setExpanded] = useState(false);
        const open = () => setExpanded(true);
        const dismiss = () => setExpanded(false);
        return <main>
          <Toolbar />
          <button onClick={open}>Open</button>
          <Host><NativeMenu expanded={expanded} onDismiss={dismiss} /></Host>
        </main>;
      }
      export function CohesiveMenu() {
        const [cohesiveOpen, setCohesiveOpen] = useState(false);
        return <NativeMenu
          expanded={cohesiveOpen}
          onDismiss={() => setCohesiveOpen(false)}
        />;
      }
      export function CoupledMenu() {
        const [coupledOpen, setCoupledOpen] = useState(false);
        const [mode, setMode] = useState("idle");
        const open = () => { setCoupledOpen(true); setMode("active"); };
        const dismiss = () => { setCoupledOpen(false); setMode("idle"); };
        return <main>
          <Toolbar />
          <button onClick={open}>Open</button>
          <Host data-mode={mode}><NativeMenu expanded={coupledOpen} onDismiss={dismiss} /></Host>
        </main>;
      }
      export function OrderedMenu() {
        const [orderedOpen, setOrderedOpen] = useState(false);
        const open = () => setOrderedOpen(true);
        const dismiss = () => { setOrderedOpen(false); navigateAway(); };
        return <main>
          <Toolbar />
          <button onClick={open}>Open</button>
          <Host><NativeMenu expanded={orderedOpen} onDismiss={dismiss} /></Host>
        </main>;
      }
      export function ForwardedSetterMenu() {
        const [forwardedOpen, setForwardedOpen] = useState(false);
        const open = () => setForwardedOpen(true);
        return <main>
          <Toolbar />
          <button onClick={open}>Open</button>
          <Host><NativeMenu expanded={forwardedOpen} onDismiss={setForwardedOpen} /></Host>
        </main>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  const compact = report.findings.find((finding) => finding.name === "expanded");
  const cohesive = report.findings.find((finding) => finding.name === "cohesiveOpen");
  const coupled = report.findings.find((finding) => finding.name === "coupledOpen");
  const ordered = report.findings.find((finding) => finding.name === "orderedOpen");
  const forwarded = report.findings.find((finding) => finding.name === "forwardedOpen");
  assert.equal(requireValue(compact).action, "use-observable");
  assert.match(requireValue(compact).message ?? "", /independent sibling render cut/u);
  assert.notEqual(requireValue(cohesive).action, "use-observable");
  assert.notEqual(requireValue(coupled).action, "use-observable");
  assert.notEqual(requireValue(ordered).action, "use-observable");
  assert.notEqual(requireValue(forwarded).action, "use-observable");
});

test("isolates a source-resolved search filter in one repeated producer slot", async (testContext) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-filtered-controlled-leaf-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(
    path.join(root, "QuickSearch.tsx"),
    `
      export function QuickSearch({ onChange }: { onChange: (value: string) => void }) {
        return <input onChange={event => onChange(event.target.value.trim().toLowerCase())} />;
      }
      export function EagerQuickSearch({ onChange }: { onChange: (value: string) => void }) {
        onChange("");
        return <input />;
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "Screen.tsx"),
    `
      import { useState } from "react";
      import { EagerQuickSearch, QuickSearch } from "./QuickSearch";
      type User = { current: boolean; id: string; name?: string };
      type UserCollection = {
        filter: (predicate: (user: User) => boolean) => User[];
        find: (predicate: (user: User) => boolean) => User | undefined;
      };
      const matches = (user: User, query: string) => user.name?.toLowerCase().includes(query);

      export function SafeScreen({ users, mobile }: { users: User[]; mobile: boolean }) {
        const [query, setQuery] = useState("");
        const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
        const currentUser = users.find(user => user.current);
        const otherUsers = users.filter(user => !user.current);
        const visibleUsers = otherUsers.slice(0, 8);
        const shownUsers = currentUser ? [...visibleUsers, currentUser] : visibleUsers;
        const avatars = shownUsers.map(user => {
          const avatar = <Avatar user={user} />;
          if (!user.current) return avatar;
          return <Popover key={user.id}><Trigger>{avatar}</Trigger><Content>
            <QuickSearch onChange={setQuery} />
            <List>{filtered.length ? filtered.map(item => <Row key={item.id} item={item} />) : null}</List>
          </Content></Popover>;
        });
        return mobile
          ? <Mobile><MobileHeader />{users.map(user => <Avatar key={user.id} user={user} />)}</Mobile>
          : <Desktop><Header /><Toolbar /><Status /><Controls /><Summary /><Aside />{avatars}</Desktop>;
      }

      export function OpaquePredicate({ users }: { users: User[] }) {
        const [query, setQuery] = useState("");
        const filtered = users.filter(user => matches(user, query));
        const first = users.find(user => user.current);
        const others = users.filter(user => !user.current);
        const rows = users.map(user => <Content key={user.id}><QuickSearch onChange={setQuery} />
          {filtered.map(item => <Row key={item.id} item={item} />)}</Content>);
        return <main><Header /><Toolbar /><Status /><Controls /><Summary /><Aside /><Footer /><Debug /><Help />
          {first ? others.length : 0}{rows}
        </main>;
      }

      export function EscapedResults({ users }: { users: User[] }) {
        const [query, setQuery] = useState("");
        const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
        const first = users.find(user => user.current);
        const others = users.filter(user => !user.current);
        const rows = users.map(user => <Content key={user.id}><QuickSearch onChange={setQuery} />
          {filtered.map(item => <Row key={item.id} item={item} />)}</Content>);
        return <main><Header /><Toolbar /><Status /><Controls /><Summary /><Aside /><Footer /><Debug /><Help />
          <Output count={filtered.length} />
          {first ? others.length : 0}{rows}
        </main>;
      }

      export function EagerAdapter({ users }: { users: User[] }) {
        const [query, setQuery] = useState("");
        const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
        const first = users.find(user => user.current);
        const others = users.filter(user => !user.current);
        const rows = users.map(user => <Content key={user.id}><EagerQuickSearch onChange={setQuery} />
          {filtered.map(item => <Row key={item.id} item={item} />)}</Content>);
        return <main><Header /><Toolbar /><Status /><Controls /><Summary /><Aside /><Footer /><Debug /><Help />
          {first ? others.length : 0}{rows}
        </main>;
      }

      export function InlineProducer({ users }: { users: User[] }) {
        const [query, setQuery] = useState("");
        const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
        return <main><Header /><Toolbar /><Status /><Controls /><Summary /><Aside />
          {users.map(user => <Content><QuickSearch onChange={setQuery} />
            {filtered.map(item => <Row key={item.id} item={item} />)}</Content>)}
        </main>;
      }

      export function MutatedSource({ users }: { users: User[] }) {
        const [query, setQuery] = useState("");
        users.push({ current: false, id: "temporary" });
        const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
        const first = users.find(user => user.current);
        const others = users.filter(user => !user.current);
        const rows = users.map(user => <Content key={user.id}><QuickSearch onChange={setQuery} />
          {filtered.map(item => <Row key={item.id} item={item} />)}</Content>);
        return <main><Header /><Toolbar /><Status /><Controls /><Summary /><Aside /><Footer /><Debug /><Help />
          {first ? others.length : 0}{rows}
        </main>;
      }

      export function ConditionalOwnerWork({ users, enabled }: { users: User[]; enabled: boolean }) {
        const [query, setQuery] = useState("");
        const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
        const first = enabled ? users.find(user => user.current) : undefined;
        const others = enabled ? users.filter(user => !user.current) : [];
        const rows = users.map(user => <Content key={user.id}><QuickSearch onChange={setQuery} />
          {filtered.map(item => <Row key={item.id} item={item} />)}</Content>);
        return <main><Header /><Toolbar /><Status /><Controls /><Summary /><Aside /><Footer /><Debug /><Help />
          {first ? others.length : 0}{rows}
        </main>;
      }

      export function PropProducer({ users }: { users: User[] }) {
        const [query, setQuery] = useState("");
        const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
        const first = users.find(user => user.current);
        const others = users.filter(user => !user.current);
        const rows = users.map(user => <Content key={user.id}><QuickSearch onChange={setQuery} />
          {filtered.map(item => <Row key={item.id} item={item} />)}</Content>);
        return <main><Header /><Toolbar /><Status /><Controls /><Summary /><Aside /><Footer /><Debug /><Help />
          {first ? others.length : 0}<List items={rows} />
        </main>;
      }

      export function CustomCollection({ users }: { users: UserCollection }) {
        const [query, setQuery] = useState("");
        const filtered = users.filter(user => user.name?.toLowerCase().includes(query));
        const currentUser = users.find(user => user.current);
        const otherUsers = users.filter(user => !user.current);
        const visibleUsers = otherUsers.slice(0, 8);
        const shownUsers = currentUser ? [...visibleUsers, currentUser] : visibleUsers;
        const avatars = shownUsers.map(user => {
          const avatar = <Avatar user={user} />;
          if (!user.current) return avatar;
          return <Popover key={user.id}><Trigger>{avatar}</Trigger><Content>
            <QuickSearch onChange={setQuery} />
            <List>{filtered.map(item => <Row key={item.id} item={item} />)}</List>
          </Content></Popover>;
        });
        return <Desktop><Header /><Toolbar /><Status /><Controls /><Summary /><Aside />{avatars}</Desktop>;
      }
    `,
    "utf8",
  );

  const report = await analyzePath(root);
  assert.deepEqual(
    report.findings.filter((finding) => finding.name === "query").map((finding) => finding.action),
    [
      "use-observable",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "review-state",
      "use-observable",
    ],
  );
});
