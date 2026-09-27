import { ConcurrentRootResolver } from "../../src/project/concurrent-root-workspace.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { withProject } from "./with-project.js";

const APP_FILE = "src/app.tsx";
const FORCED_PODFILE = `ENV['RCT_NEW_ARCH_ENABLED'] = '1'\nplatform :macos, '14.0'\n`;
const ENV_GATED_PODFILE = `use_react_native!(:fabric_enabled => ENV['RCT_NEW_ARCH_ENABLED'] == '1')\n`;

/** Relative file paths mapped to their contents. */
type ProjectFiles = Readonly<Record<string, string>>;

function app(dependencies: Readonly<Record<string, string>>): string {
  return JSON.stringify({ dependencies, name: "app", private: true });
}

async function rendersConcurrently(files: ProjectFiles): Promise<boolean> {
  let verdict = false;
  await withProject({ [APP_FILE]: "export {};", ...files }, async (root) => {
    verdict = await new ConcurrentRootResolver().rendersFileConcurrently(path.join(root, APP_FILE));
  });
  return verdict;
}

test("an app host that enables the New Architecture on every platform proves React Native 0.74+", async () => {
  for (const [label, files] of [
    [
      "forced macOS Podfile",
      {
        "macos/Podfile": FORCED_PODFILE,
        "package.json": app({ "react-native": "0.81.6", "react-native-macos": "0.81.7" }),
      },
    ],
    [
      "prebuilt Expo platforms",
      {
        "android/gradle.properties": "newArchEnabled=true\n",
        "android/settings.gradle": "",
        "ios/Podfile": "",
        "ios/Podfile.properties.json": '{ "newArchEnabled": "true" }',
        "package.json": app({ "react-native": "0.76.9" }),
      },
    ],
    [
      "managed Expo config flag",
      {
        "app.config.ts": "export default { newArchEnabled: true };",
        "package.json": app({ expo: "~52.0.0", "react-native": "0.76.9" }),
      },
    ],
    [
      "managed Expo SDK 54 default",
      {
        "app.json": JSON.stringify({ expo: { name: "app" } }),
        "package.json": app({ expo: "~54.0.33", "react-native": "0.81.4" }),
      },
    ],
  ] as const) {
    assert.equal(await rendersConcurrently(files), true, label);
  }
});

test("an app host that may still build a legacy platform keeps React Native below 0.82 unproven", async () => {
  for (const [label, files] of [
    [
      "Podfile compares the environment instead of setting it",
      { "macos/Podfile": ENV_GATED_PODFILE, "package.json": app({ "react-native": "0.78.2" }) },
    ],
    [
      "app delegate switches it off",
      {
        "macos/Podfile": FORCED_PODFILE,
        "macos/App/AppDelegate.mm": "- (BOOL)newArchEnabled {\n    return false;\n}\n",
        "package.json": app({ "react-native": "0.76.9" }),
      },
    ],
    [
      "one platform without a setting",
      {
        "android/settings.gradle": "",
        "ios/Podfile": FORCED_PODFILE,
        "package.json": app({ "react-native": "0.79.2" }),
      },
    ],
    [
      "Expo config turns it off",
      {
        "app.json": JSON.stringify({ expo: { newArchEnabled: false } }),
        "package.json": app({ expo: "~54.0.0", "react-native": "0.81.4" }),
      },
    ],
    [
      "Expo SDK 52 without a flag",
      {
        "app.config.js": "module.exports = { name: 'app' };",
        "package.json": app({ expo: "~52.0.0", "react-native": "0.76.9" }),
      },
    ],
    [
      "New Architecture before concurrent roots were its default",
      { "ios/Podfile": FORCED_PODFILE, "package.json": app({ "react-native": "0.73.6" }) },
    ],
    ["no app host", { "package.json": app({ "react-native": "0.81.6" }) }],
  ] as const) {
    assert.equal(await rendersConcurrently(files), false, label);
  }
});

test("native module packages are not app hosts, but every real host must qualify", async () => {
  const workspace = {
    "package-lock.json": "{}",
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    "packages/shell/macos/Podfile": FORCED_PODFILE,
    "packages/shell/package.json": JSON.stringify({
      dependencies: { "react-native-macos": "0.81.7" },
      name: "shell",
      private: true,
    }),
    "packages/sidebar/macos/Sidebar.swift": "",
    "packages/sidebar/package.json": JSON.stringify({
      dependencies: { "react-native": "0.81.6" },
      name: "sidebar",
      private: true,
    }),
  };
  assert.equal(await rendersConcurrently(workspace), true);
  assert.equal(
    await rendersConcurrently({
      ...workspace,
      "packages/legacy/macos/Podfile": ENV_GATED_PODFILE,
      "packages/legacy/package.json": JSON.stringify({
        dependencies: { "react-native-macos": "0.78.3" },
        name: "legacy",
        private: true,
      }),
    }),
    false,
  );
  assert.equal(
    await rendersConcurrently({
      ...workspace,
      "packages/sidebar/package.json": JSON.stringify({
        name: "sidebar",
        peerDependencies: { "react-native": "^0.81.0" },
      }),
    }),
    false,
  );
});
