import { loadWorkspace, workspaceLinks } from "../../src/project/workspace/packages.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { withProject } from "./with-project.js";

/** Relative file paths mapped to their contents. */
type ProjectFiles = Readonly<Record<string, string>>;

interface LinkCase {
  readonly files?: ProjectFiles;
  readonly label: string;
  readonly links: boolean;
  readonly specifier: string;
  readonly version?: string;
}

/** Workspaces under npm, Yarn, and Bun are recognized only beside their lockfile. */
type Lockfile = "bun.lock" | "package-lock.json" | "yarn.lock";

const WORKSPACES = ["apps/*", "packages/*"];

function managerRoot(lockfile: Lockfile, packageManager?: string): ProjectFiles {
  return Object.fromEntries([
    [lockfile, "{}"],
    ["package.json", JSON.stringify({ name: "root", packageManager, workspaces: WORKSPACES })],
  ]);
}

function pnpmRoot(packageManager?: string, settings = ""): ProjectFiles {
  return Object.fromEntries([
    ["package.json", JSON.stringify({ name: "root", packageManager })],
    ["pnpm-workspace.yaml", `packages:\n  - apps/*\n  - packages/*\n${settings}`],
  ]);
}

async function linksSibling(root: ProjectFiles, entry: LinkCase): Promise<boolean> {
  const files = {
    ...root,
    ...entry.files,
    "apps/web/package.json": JSON.stringify({
      name: "@fixture/web",
      dependencies: { "@fixture/lib": entry.specifier },
    }),
    "packages/lib/package.json": JSON.stringify({ name: "@fixture/lib", version: entry.version }),
  };
  let linked = false;
  await withProject(files, async (directory) => {
    const workspace = await loadWorkspace(directory);
    assert.ok(workspace, entry.label);
    const links = workspaceLinks(workspace);
    assert.ok(links.length <= 1, entry.label);
    linked = links.some(
      (link) =>
        link.from === path.join(directory, "apps/web/node_modules/@fixture/lib") &&
        link.to === path.join(directory, "packages/lib"),
    );
  });
  return linked;
}

async function assertLinks(root: ProjectFiles, cases: readonly LinkCase[]): Promise<void> {
  for (const entry of cases) {
    assert.equal(await linksSibling(root, entry), entry.links, entry.label);
  }
}

test("Bun links a sibling whenever its version satisfies the declared range", async () => {
  await assertLinks(managerRoot("bun.lock"), [
    { label: "exact version", links: true, specifier: "0.0.0", version: "0.0.0" },
    { label: "caret range", links: true, specifier: "^1.0.0", version: "1.2.0" },
    { label: "unsatisfied range", links: false, specifier: "^2.0.0", version: "1.2.0" },
    { label: "any-version protocol", links: true, specifier: "workspace:*", version: "1.2.0" },
    { label: "caret protocol", links: true, specifier: "workspace:^" },
    { label: "protocol range", links: true, specifier: "workspace:^1.0.0", version: "1.2.0" },
    {
      label: "unsatisfied protocol",
      links: false,
      specifier: "workspace:^2.0.0",
      version: "1.2.0",
    },
    { label: "unnamed prerelease", links: false, specifier: "^1.0.0", version: "1.0.0-beta.1" },
    { label: "named prerelease", links: true, specifier: "^1.0.0-beta.0", version: "1.0.0-beta.1" },
    { label: "dist tag", links: false, specifier: "latest", version: "1.2.0" },
    { label: "empty specifier", links: false, specifier: "", version: "1.2.0" },
    { label: "unversioned sibling", links: false, specifier: "^1.0.0" },
    {
      label: "path specifier",
      links: false,
      specifier: "file:../../packages/lib",
      version: "1.2.0",
    },
  ]);
});

test("Bun settings that disable workspace linking keep only the workspace protocol", async () => {
  for (const [label, files] of [
    ["bunfig.toml", { "bunfig.toml": "[install]\nlinkWorkspacePackages = false\n" }],
    [".npmrc", { ".npmrc": "link-workspace-packages=false\n" }],
    [
      "later .npmrc assignment",
      { ".npmrc": "link-workspace-packages=true\nlink-workspace-packages = false\n" },
    ],
  ] as const) {
    await assertLinks({ ...managerRoot("bun.lock"), ...files }, [
      { label: `${label} range`, links: false, specifier: "^1.0.0", version: "1.2.0" },
      { label: `${label} protocol`, links: true, specifier: "workspace:*", version: "1.2.0" },
    ]);
  }
  await assertLinks(
    { ...managerRoot("bun.lock"), "bunfig.toml": "# linkWorkspacePackages = false\n" },
    [{ label: "commented setting", links: true, specifier: "^1.0.0", version: "1.2.0" }],
  );
});

test("npm and Yarn 1 link satisfied ranges and reject the workspace protocol", async () => {
  for (const root of [
    managerRoot("package-lock.json"),
    managerRoot("yarn.lock"),
    managerRoot("yarn.lock", "yarn@1.22.22"),
    { ...managerRoot("yarn.lock", "yarn@1.22.22"), ".yarnrc.yml": "nodeLinker: node-modules\n" },
  ]) {
    await assertLinks(root, [
      { label: "satisfied range", links: true, specifier: "1.2.0", version: "1.2.0" },
      { label: "unsatisfied range", links: false, specifier: "^2.0.0", version: "1.2.0" },
      { label: "workspace protocol", links: false, specifier: "workspace:*", version: "1.2.0" },
    ]);
  }
});

test("Yarn Berry links the workspace protocol and transparent workspace ranges", async () => {
  for (const root of [
    { ...managerRoot("yarn.lock"), ".yarnrc.yml": "" },
    managerRoot("yarn.lock", "yarn@4.11.0"),
  ]) {
    await assertLinks(root, [
      { label: "workspace protocol", links: true, specifier: "workspace:*", version: "1.2.0" },
      { label: "satisfied range", links: true, specifier: "^1.0.0", version: "1.2.0" },
      { label: "unsatisfied range", links: false, specifier: "^2.0.0", version: "1.2.0" },
    ]);
  }
  await assertLinks(
    { ...managerRoot("yarn.lock"), ".yarnrc.yml": "enableTransparentWorkspaces: false\n" },
    [
      { label: "opaque range", links: false, specifier: "^1.0.0", version: "1.2.0" },
      { label: "opaque protocol", links: true, specifier: "workspace:*", version: "1.2.0" },
    ],
  );
});

test("pnpm links plain ranges only where link-workspace-packages is in effect", async () => {
  const range = { specifier: "^1.0.0", version: "1.2.0" };
  for (const [label, root, links] of [
    ["pnpm 11 default", pnpmRoot("pnpm@11.13.1"), false],
    ["unknown pnpm default", pnpmRoot(), false],
    ["pnpm 8 default", pnpmRoot("pnpm@8.15.9"), true],
    [
      "pnpm 8 disabled",
      { ...pnpmRoot("pnpm@8.15.9"), ".npmrc": "link-workspace-packages=false" },
      false,
    ],
    [
      "pnpm 9 .npmrc",
      { ...pnpmRoot("pnpm@9.15.0"), ".npmrc": "link-workspace-packages=deep" },
      true,
    ],
    ["pnpm 9 ignores yaml", pnpmRoot("pnpm@9.15.0", "linkWorkspacePackages: true\n"), false],
    ["pnpm 11 yaml", pnpmRoot("pnpm@11.13.1", "linkWorkspacePackages: true\n"), true],
    ["unknown pnpm yaml", pnpmRoot(undefined, "linkWorkspacePackages: deep\n"), true],
    [
      "pnpm 11 ignores .npmrc",
      { ...pnpmRoot("pnpm@11.13.1"), ".npmrc": "link-workspace-packages=true" },
      false,
    ],
    [
      "unknown pnpm ignores .npmrc",
      { ...pnpmRoot(), ".npmrc": "link-workspace-packages=true" },
      false,
    ],
    [
      "pnpm 10 conflicting settings",
      {
        ...pnpmRoot("pnpm@10.12.1", "linkWorkspacePackages: true\n"),
        ".npmrc": "link-workspace-packages=false",
      },
      false,
    ],
  ] as const) {
    await assertLinks(root, [{ ...range, label, links: links === true }]);
  }
  await assertLinks(pnpmRoot("pnpm@11.13.1"), [
    { label: "any-version protocol", links: true, specifier: "workspace:*" },
    { label: "tilde protocol", links: true, specifier: "workspace:~", version: "1.2.0" },
    {
      label: "unsatisfied protocol",
      links: false,
      specifier: "workspace:^2.0.0",
      version: "1.2.0",
    },
  ]);
});

test("ambiguous or installed siblings never link", async () => {
  await assertLinks(managerRoot("bun.lock"), [
    {
      files: { "packages/copy/package.json": '{"name":"@fixture/lib","version":"1.2.0"}' },
      label: "duplicate package name",
      links: false,
      specifier: "1.2.0",
      version: "1.2.0",
    },
    {
      files: { "node_modules/@fixture/lib/package.json": '{"name":"@fixture/lib"}' },
      label: "installed package",
      links: false,
      specifier: "1.2.0",
      version: "1.2.0",
    },
  ]);
});
