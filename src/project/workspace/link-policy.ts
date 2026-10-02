import { isJsonObject, isJsonString } from "../../core/json.js";
import type { JsonValue } from "../../core/json.js";
import { parse as parseYaml } from "yaml";
import path from "node:path";
import { readOptionalText } from "../read-optional-text.js";

/** Which dependency specifiers a workspace's package manager installs as a link to the sibling package. */
export interface WorkspaceLinkPolicy {
  /** Plain semver ranges link when the sibling's version satisfies them. */
  readonly semverRanges: boolean;
  /** `workspace:` specifiers link. */
  readonly workspaceProtocol: boolean;
}

const NO_LINKS = { semverRanges: false, workspaceProtocol: false } satisfies WorkspaceLinkPolicy;
const RANGE_LINKS = { semverRanges: true, workspaceProtocol: false } satisfies WorkspaceLinkPolicy;
const PROTOCOL_LINKS = {
  semverRanges: false,
  workspaceProtocol: true,
} satisfies WorkspaceLinkPolicy;
/** From pnpm 9, plain ranges link only when `link-workspace-packages` asks for it. */
const FIRST_PNPM_WITHOUT_RANGE_LINKS = 9;
/** From pnpm 10, settings can live in pnpm-workspace.yaml. */
const FIRST_PNPM_WITH_WORKSPACE_SETTINGS = 10;
/** From pnpm 11, settings in .npmrc are ignored. */
const FIRST_PNPM_WITHOUT_NPMRC_SETTINGS = 11;
/** Yarn 2 introduced the `workspace:` protocol and `.yarnrc.yml`. */
const FIRST_YARN_WITH_PROTOCOL = 2;
const PACKAGE_MANAGER = /^(?<name>[^@\s]+)@(?<major>\d+)\./u;
const INI_ENTRY = /^\s*(?<key>[^\s#;=]+)\s*=\s*(?<value>.*?)\s*$/u;
const BUNFIG_LINK_SETTING = /^[^#]*\blinkWorkspacePackages\s*=\s*(?<value>[^\s#]+)/gmu;
const QUOTES = /^["']|["']$/gu;
const NPMRC_LINK_KEY = "link-workspace-packages";

const POLICIES: ReadonlyMap<string, (rootDir: string) => Promise<WorkspaceLinkPolicy>> = new Map([
  ["bun", bunPolicy],
  ["lerna", () => Promise.resolve(RANGE_LINKS)],
  ["npm", () => Promise.resolve(RANGE_LINKS)],
  ["pnpm", pnpmPolicy],
  ["rush", () => Promise.resolve(PROTOCOL_LINKS)],
  ["yarn", yarnPolicy],
]);

/** Unreadable settings keep the manager's default, and an unknown tool links nothing. */
export function workspaceLinkPolicy(tool: string, rootDir: string): Promise<WorkspaceLinkPolicy> {
  return POLICIES.get(tool)?.(rootDir) ?? Promise.resolve(NO_LINKS);
}

async function bunPolicy(rootDir: string): Promise<WorkspaceLinkPolicy> {
  const [npmrc, bunfig] = await Promise.all([
    npmrcSetting(rootDir, NPMRC_LINK_KEY),
    readOptionalText(path.join(rootDir, "bunfig.toml")),
  ]);
  const bunfigSettings = [...(bunfig ?? "").matchAll(BUNFIG_LINK_SETTING)].map((match) =>
    linkSetting(match.groups?.["value"]),
  );
  return { semverRanges: ![npmrc, ...bunfigSettings].includes(false), workspaceProtocol: true };
}

async function pnpmPolicy(rootDir: string): Promise<WorkspaceLinkPolicy> {
  const [major, npmrc, workspaceFile] = await Promise.all([
    packageManagerMajor(rootDir, "pnpm"),
    npmrcSetting(rootDir, NPMRC_LINK_KEY),
    readYaml(path.join(rootDir, "pnpm-workspace.yaml")),
  ]);
  const honored = [
    major === null || major >= FIRST_PNPM_WITH_WORKSPACE_SETTINGS
      ? linkSetting(objectField(workspaceFile, "linkWorkspacePackages"))
      : null,
    major !== null && major < FIRST_PNPM_WITHOUT_NPMRC_SETTINGS ? npmrc : null,
  ].filter((setting) => setting !== null);
  const linksByDefault = major !== null && major < FIRST_PNPM_WITHOUT_RANGE_LINKS;
  return {
    semverRanges: honored.length === 0 ? linksByDefault : honored.every(Boolean),
    workspaceProtocol: true,
  };
}

async function yarnPolicy(rootDir: string): Promise<WorkspaceLinkPolicy> {
  const [major, yarnrc] = await Promise.all([
    packageManagerMajor(rootDir, "yarn"),
    readOptionalText(path.join(rootDir, ".yarnrc.yml")),
  ]);
  const berry = major === null ? yarnrc !== null : major >= FIRST_YARN_WITH_PROTOCOL;
  if (!berry) {
    return RANGE_LINKS;
  }
  const settings = parseDocument(yarnrc, parseYaml);
  const transparent = linkSetting(objectField(settings, "enableTransparentWorkspaces"));
  return { semverRanges: transparent !== false, workspaceProtocol: true };
}

/** `true` and pnpm's `deep` link; any other present value is treated as disabling links. */
function linkSetting(value: JsonValue | undefined): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).replaceAll(QUOTES, "");
  return normalized === "true" || normalized === "deep";
}

async function packageManagerMajor(rootDir: string, name: string): Promise<number | null> {
  const manifest = parseDocument(
    await readOptionalText(path.join(rootDir, "package.json")),
    JSON.parse,
  );
  const declared = objectField(manifest, "packageManager");
  const groups = isJsonString(declared) ? PACKAGE_MANAGER.exec(declared)?.groups : undefined;
  return groups?.["name"] === name ? Number(groups["major"]) : null;
}

/** In the ini format a later assignment overrides an earlier one. */
async function npmrcSetting(rootDir: string, key: string): Promise<boolean | null> {
  const text = await readOptionalText(path.join(rootDir, ".npmrc"));
  const values = (text ?? "")
    .split(/\r?\n/u)
    .map((line) => INI_ENTRY.exec(line)?.groups)
    .filter((groups) => groups?.["key"] === key)
    .map((groups) => groups?.["value"]);
  return linkSetting(values.at(-1));
}

function objectField(document: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(document) ? document[key] : undefined;
}

async function readYaml(filePath: string): Promise<JsonValue> {
  return parseDocument(await readOptionalText(filePath), parseYaml);
}

function parseDocument(text: string | null, parseText: (text: string) => JsonValue): JsonValue {
  try {
    return text === null ? null : parseText(text);
  } catch {
    // A malformed settings file declares nothing, which leaves the manager's default.
    return null;
  }
}
