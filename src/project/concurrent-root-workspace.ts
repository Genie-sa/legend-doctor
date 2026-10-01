import { minVersion, validRange } from "semver";
import type { Package } from "@manypkg/get-packages";
import type { WorkspaceLinkPolicy } from "./workspace/link-policy.js";
import { domRootInventory } from "./dom-root-creation.js";
import { getPackages } from "@manypkg/get-packages";
import { hostRunsNewArchitecture } from "./native-architecture.js";
import { linksToSibling } from "./workspace/packages.js";
import { parse as parseYaml } from "yaml";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { workspaceLinkPolicy } from "./workspace/link-policy.js";

/** React Native 0.82 removed the legacy architecture, so every root it creates is concurrent. */
const FIRST_CONCURRENT_ONLY_NATIVE: Version = { major: 0, minor: 82 };
/** From React Native 0.74 the New Architecture creates concurrent roots without a separate flag. */
const FIRST_CONCURRENT_NEW_ARCHITECTURE: Version = { major: 0, minor: 74 };
/** Expo SDK 53 enables the New Architecture unless the app config turns it off. */
const FIRST_NEW_ARCHITECTURE_EXPO: Version = { major: 53, minor: 0 };
/** React DOM 19 removed `render` and `hydrate`, so every root it creates is concurrent. */
const FIRST_CONCURRENT_ONLY_DOM: Version = { major: 19, minor: 0 };
/** React DOM 18 added `createRoot` and `hydrateRoot`, which create concurrent roots beside the legacy APIs. */
const FIRST_CLIENT_ROOT_DOM: Version = { major: 18, minor: 0 };
/**
 * From Next.js 13.1 the pages client imports only `react-dom/client` and hydrates with `hydrateRoot`, and the
 * app router, from 13.0, creates its roots with `createRoot` or `hydrateRoot`. 13.0.0's pages client still
 * fell back to `ReactDOM.render` without a React 18 build flag.
 */
const FIRST_CLIENT_ROOT_NEXT: Version = { major: 13, minor: 1 };
/**
 * Expo 48 and 49 mount the web root with `createRoot` from `react-dom/client`. From Expo 50, React Native Web's
 * `AppRegistry.runApplication` mounts it, concurrently by default from React Native Web 0.19.
 */
const FIRST_CLIENT_ROOT_EXPO: Version = { major: 48, minor: 0 };
const FIRST_CONCURRENT_DEFAULT_NATIVE_WEB: Version = { major: 0, minor: 19 };
/** React 19 renders a store notification's sync lane together with every pending default-lane update. */
const FIRST_UNIFIED_LANES_REACT: Version = { major: 19, minor: 0 };
const RENDERER_FLOORS: ReadonlyMap<string, Version> = new Map([
  ["react-dom", FIRST_CONCURRENT_ONLY_DOM],
  ["react-native", FIRST_CONCURRENT_ONLY_NATIVE],
  ["react-native-macos", FIRST_CONCURRENT_ONLY_NATIVE],
  ["react-native-windows", FIRST_CONCURRENT_ONLY_NATIVE],
]);
const NATIVE_HOST_FLOOR: ConditionalFloor = {
  floor: FIRST_CONCURRENT_NEW_ARCHITECTURE,
  verdict: "new-architecture-host",
};
/** Below its floor, a locally installed renderer still creates only concurrent roots when a host proof holds. */
const CONDITIONAL_FLOORS: ReadonlyMap<string, ConditionalFloor> = new Map([
  ["react-dom", { floor: FIRST_CLIENT_ROOT_DOM, verdict: "client-root" }],
  ["react-native", NATIVE_HOST_FLOOR],
  ["react-native-macos", NATIVE_HOST_FLOOR],
  ["react-native-windows", NATIVE_HOST_FLOOR],
]);
const LOCAL_FIELDS = ["dependencies", "devDependencies"] as const;
const PUBLISHED_FIELDS = [...LOCAL_FIELDS, "peerDependencies"] as const;
const DEFAULT_CATALOG = "default";
const SIMPLE_RANGE =
  /^(?:[\^~]|>=)?\s*v?(?<major>\d+)(?:\.(?<minor>\d+))?(?:\.[\dx*]+)?(?:-[\w.]+)?$/u;
const CATALOG_REFERENCE = /^catalog:(?<name>.*)$/u;
const NPM_ALIAS = /^npm:(?:@[^/@]+\/)?[^/@]+@(?<range>.+)$/u;
const ANY_VERSION = /^[*xX]?$/u;

interface Version {
  readonly major: number;
  readonly minor: number;
}

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;
type Catalogs = ReadonlyMap<string, ReadonlyMap<string, string>>;
/**
 * `new-architecture-host`: concurrent only when every app host in the workspace runs the New Architecture.
 * `client-root`: concurrent only when the package creates its roots with `react-dom/client` and no workspace
 * source can create a root any other way.
 */
type RendererVerdict = "client-root" | "concurrent" | "new-architecture-host" | "unproven";
type DependencyField = (typeof PUBLISHED_FIELDS)[number];

interface ConditionalFloor {
  readonly floor: Version;
  readonly verdict: Exclude<RendererVerdict, "concurrent" | "unproven">;
}

interface RendererDeclaration {
  readonly catalogs: Catalogs;
  readonly field: DependencyField;
  readonly floor: Version;
  readonly name: string;
  readonly range: string;
}

/**
 * Decides whether every React renderer in a file's workspace can only create concurrent roots, where
 * React already coalesces separate store notifications into one render.
 */
export class ConcurrentRootResolver {
  private readonly directories = new Map<string, Promise<boolean>>();
  private readonly workspaces = new Map<string, Promise<boolean>>();

  public rendersFileConcurrently(filePath: string): Promise<boolean> {
    return this.rendersDirectoryConcurrently(path.dirname(path.resolve(filePath)));
  }

  public rendersDirectoryConcurrently(directory: string): Promise<boolean> {
    const resolved = path.resolve(directory);
    const cached = this.directories.get(resolved);
    if (cached) {
      return cached;
    }
    const result = this.resolveDirectory(resolved);
    this.directories.set(resolved, result);
    return result;
  }

  private async resolveDirectory(directory: string): Promise<boolean> {
    const workspace = await workspaceOf(directory);
    if (workspace === null) {
      return false;
    }
    const cached = this.workspaces.get(workspace.rootDir);
    if (cached) {
      return cached;
    }
    const result = workspaceRendersConcurrently(workspace);
    this.workspaces.set(workspace.rootDir, result);
    return result;
  }
}

/**
 * The files that may run under a React below 19, which renders the sync lane alone. A private package
 * that installs React runs its own files under that React; any other file may run under the React of
 * any workspace package.
 */
export async function filesRenderingSyncLaneAlone(
  files: readonly string[],
): Promise<ReadonlySet<string>> {
  const verdicts = new Map<string, Promise<boolean>>();
  const alone = await Promise.all(
    files.map(async (file) => {
      const directory = path.dirname(path.resolve(file));
      const verdict = verdicts.get(directory) ?? directoryRendersSyncLaneAlone(directory);
      verdicts.set(directory, verdict);
      return (await verdict) ? [file] : [];
    }),
  );
  return new Set(alone.flat());
}

async function directoryRendersSyncLaneAlone(directory: string): Promise<boolean> {
  const workspace = await workspaceOf(directory);
  if (workspace === null) {
    return false;
  }
  const catalogs = await workspaceCatalogs(workspace.rootDir);
  const owner = owningPackage(workspace, directory);
  const peerRange = owner && publishedReactPeerRange(owner);
  if (peerRange) {
    return admitsReactBelowUnifiedLanes(resolveRange("react", peerRange, catalogs));
  }
  const reactPackages = owner && installsOwnReact(owner) ? [owner] : workspace.packages;
  return reactPackages.some((pkg) => {
    const minimum = localMinimumVersion(pkg, "react", catalogs);
    return minimum !== null && compareVersions(minimum, FIRST_UNIFIED_LANES_REACT) < 0;
  });
}

/** A published package's consumers bring any React its constraining peer range admits. */
function publishedReactPeerRange(pkg: Package): string | null {
  const { packageJson } = pkg;
  const range = packageJson.peerDependencies?.["react"];
  return packageJson.private !== true && range !== undefined && !ANY_VERSION.test(range.trim())
    ? range
    : null;
}

/** Whether the lowest React a range admits, alternatives included, is below 19; an invalid range may admit one. */
function admitsReactBelowUnifiedLanes(range: string | null): boolean {
  const lowest = range !== null && validRange(range) !== null ? minVersion(range) : null;
  return lowest === null || lowest.major < FIRST_UNIFIED_LANES_REACT.major;
}

/** A published package or a React peer range defers to its consumers' React. */
function installsOwnReact(pkg: Package): boolean {
  const { packageJson } = pkg;
  return (
    packageJson.private === true &&
    packageJson.peerDependencies?.["react"] === undefined &&
    LOCAL_FIELDS.some((field) => packageJson[field]?.["react"] !== undefined)
  );
}

interface Workspace {
  readonly packages: readonly Package[];
  readonly rootDir: string;
  readonly tool: string;
}

async function workspaceOf(directory: string): Promise<Workspace | null> {
  try {
    const { packages, rootDir, rootPackage, tool } = await getPackages(directory);
    return {
      packages:
        rootPackage && !packages.includes(rootPackage) ? [rootPackage, ...packages] : packages,
      rootDir,
      tool: tool.type,
    };
  } catch {
    // Without a readable manifest graph no renderer can be proven, which keeps the legacy-root default.
    return null;
  }
}

async function workspaceRendersConcurrently(workspace: Workspace): Promise<boolean> {
  const catalogs = await workspaceCatalogs(workspace.rootDir);
  const renderers = workspace.packages.map((pkg) => ({
    pkg,
    verdicts: rendererVerdicts(pkg, catalogs),
  }));
  const verdicts = new Set(renderers.flatMap((renderer) => [...renderer.verdicts]));
  if (verdicts.size === 0 || verdicts.has("unproven")) {
    return false;
  }
  const clientRootPackages = renderers
    .filter((renderer) => renderer.verdicts.has("client-root"))
    .map((renderer) => renderer.pkg);
  return (
    (!verdicts.has("new-architecture-host") ||
      (await everyHostRunsNewArchitecture(workspace, catalogs))) &&
    (clientRootPackages.length === 0 ||
      (await everyPackageCreatesClientRoots(workspace, clientRootPackages, catalogs)))
  );
}

/**
 * Each React DOM 18 package must create a root with `react-dom/client` in its own source, run under a
 * framework that does, or be a private library such a host reaches through local dependencies, and no
 * source file in the workspace may create a root any other way.
 */
async function everyPackageCreatesClientRoots(
  workspace: Workspace,
  packages: readonly Package[],
  catalogs: Catalogs,
): Promise<boolean> {
  const inventory = await domRootInventory(workspace.rootDir);
  if (inventory.otherRootCreation) {
    return false;
  }
  const sourceHosts = new Set(
    inventory.clientRootFiles.map((file) => owningPackage(workspace, file)),
  );
  const hosts = workspace.packages.filter(
    (pkg) =>
      sourceHosts.has(pkg) ||
      nextCreatesClientRoots(pkg, catalogs) ||
      expoCreatesClientRoots(pkg, catalogs),
  );
  const linkPolicy = await workspaceLinkPolicy(workspace.tool, workspace.rootDir);
  const rendered = hostsWithPrivateDependencies(workspace, hosts, linkPolicy);
  return packages.every((pkg) => rendered.has(pkg));
}

/** A private package cannot be installed from a registry, so only the workspace packages that depend on it render it. */
function hostsWithPrivateDependencies(
  workspace: Workspace,
  hosts: readonly Package[],
  linkPolicy: WorkspaceLinkPolicy,
): ReadonlySet<Package> {
  const byName = new Map(workspace.packages.map((pkg) => [pkg.packageJson.name, pkg]));
  const reached = new Set(hosts);
  const pending = [...hosts];
  for (let pkg = pending.pop(); pkg !== undefined; pkg = pending.pop()) {
    for (const dependency of privateWorkspaceDependencies(pkg, byName, linkPolicy)) {
      if (!reached.has(dependency)) {
        reached.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return reached;
}

function privateWorkspaceDependencies(
  pkg: Package,
  byName: ReadonlyMap<string, Package>,
  linkPolicy: WorkspaceLinkPolicy,
): Package[] {
  return LOCAL_FIELDS.flatMap((field) =>
    Object.entries(pkg.packageJson[field] ?? {}).flatMap(([name, range]) => {
      const dependency = byName.get(name);
      return dependency?.packageJson.private === true &&
        linksToSibling(linkPolicy, range, dependency)
        ? [dependency]
        : [];
    }),
  );
}

function owningPackage(workspace: Workspace, file: string): Package | undefined {
  return workspace.packages
    .filter((pkg) => isWithin(pkg.dir, file))
    .toSorted((left, right) => right.dir.length - left.dir.length)[0];
}

function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
}

function nextCreatesClientRoots(pkg: Package, catalogs: Catalogs): boolean {
  const minimum = localMinimumVersion(pkg, "next", catalogs);
  return minimum !== null && compareVersions(minimum, FIRST_CLIENT_ROOT_NEXT) >= 0;
}

function expoCreatesClientRoots(pkg: Package, catalogs: Catalogs): boolean {
  const expo = localMinimumVersion(pkg, "expo", catalogs);
  const nativeWeb = localMinimumVersion(pkg, "react-native-web", catalogs);
  return (
    expo !== null &&
    nativeWeb !== null &&
    compareVersions(expo, FIRST_CLIENT_ROOT_EXPO) >= 0 &&
    compareVersions(nativeWeb, FIRST_CONCURRENT_DEFAULT_NATIVE_WEB) >= 0
  );
}

async function everyHostRunsNewArchitecture(
  workspace: Workspace,
  catalogs: Catalogs,
): Promise<boolean> {
  const hosts = await Promise.all(
    workspace.packages.map((pkg) =>
      hostRunsNewArchitecture(pkg.dir, {
        expoDefaultsToNewArchitecture: expoDefaultsToNewArchitecture(pkg, catalogs),
      }),
    ),
  );
  const proofs = hosts.filter((host) => host !== null);
  return proofs.length > 0 && proofs.every(Boolean);
}

/**
 * The verdict of each renderer the package declares; empty when it declares none. A published package also
 * runs under its consumers' renderers, so its peer ranges must qualify too. A peer range that admits every
 * version constrains nothing, exactly like an omitted peer.
 */
function rendererVerdicts(pkg: Package, catalogs: Catalogs): ReadonlySet<RendererVerdict> {
  const fields = pkg.packageJson.private === true ? LOCAL_FIELDS : PUBLISHED_FIELDS;
  return new Set(
    fields.flatMap((field) =>
      Object.entries(pkg.packageJson[field] ?? {}).flatMap(([name, range]) => {
        const floor = RENDERER_FLOORS.get(name);
        const unconstrained = field === "peerDependencies" && ANY_VERSION.test(range.trim());
        return floor && !unconstrained
          ? [declarationVerdict({ catalogs, field, floor, name, range })]
          : [];
      }),
    ),
  );
}

/** A peer range answers for consumers' hosts, which no local proof covers. */
function declarationVerdict(declaration: RendererDeclaration): RendererVerdict {
  const minimum = minimumVersion(
    resolveRange(declaration.name, declaration.range, declaration.catalogs),
  );
  if (minimum === null) {
    return "unproven";
  }
  if (compareVersions(minimum, declaration.floor) >= 0) {
    return "concurrent";
  }
  const conditional = CONDITIONAL_FLOORS.get(declaration.name);
  return conditional &&
    declaration.field !== "peerDependencies" &&
    compareVersions(minimum, conditional.floor) >= 0
    ? conditional.verdict
    : "unproven";
}

function expoDefaultsToNewArchitecture(pkg: Package, catalogs: Catalogs): boolean {
  const minimum = localMinimumVersion(pkg, "expo", catalogs);
  return minimum !== null && compareVersions(minimum, FIRST_NEW_ARCHITECTURE_EXPO) >= 0;
}

function localMinimumVersion(pkg: Package, name: string, catalogs: Catalogs): Version | null {
  const range = LOCAL_FIELDS.map((field) => pkg.packageJson[field]?.[name]).find(
    (declared) => declared !== undefined,
  );
  return range === undefined ? null : minimumVersion(resolveRange(name, range, catalogs));
}

function resolveRange(name: string, range: string, catalogs: Catalogs): string | null {
  const catalog = CATALOG_REFERENCE.exec(range)?.groups;
  if (catalog) {
    return catalogs.get(catalog["name"] || DEFAULT_CATALOG)?.get(name) ?? null;
  }
  return NPM_ALIAS.exec(range)?.groups?.["range"] ?? range;
}

/** The lowest version a single caret, tilde, `>=`, or exact range admits; anything wider is unknown. */
function minimumVersion(range: string | null): Version | null {
  const groups = range === null ? undefined : SIMPLE_RANGE.exec(range.trim())?.groups;
  if (!groups) {
    return null;
  }
  return { major: Number(groups["major"]), minor: Number(groups["minor"] ?? 0) };
}

function compareVersions(left: Version, right: Version): number {
  return left.major === right.major ? left.minor - right.minor : left.major - right.major;
}

/** Catalogs declared in pnpm-workspace.yaml or, for Bun, in the root manifest. */
async function workspaceCatalogs(rootDir: string): Promise<Catalogs> {
  const [pnpm, manifest] = await Promise.all([
    readDocument(path.join(rootDir, "pnpm-workspace.yaml"), parseYaml),
    readDocument(path.join(rootDir, "package.json"), JSON.parse),
  ]);
  const bunWorkspaces = isJsonObject(manifest) ? manifest["workspaces"] : null;
  const catalogs = new Map<string, Map<string, string>>();
  const sources = [pnpm, manifest, bunWorkspaces].filter((document) => isJsonObject(document));
  for (const source of sources) {
    addCatalog(catalogs, DEFAULT_CATALOG, source["catalog"]);
    const named = source["catalogs"];
    for (const [name, entries] of isJsonObject(named) ? Object.entries(named) : []) {
      addCatalog(catalogs, name, entries);
    }
  }
  return catalogs;
}

function addCatalog(
  catalogs: Map<string, Map<string, string>>,
  name: string,
  entries: JsonValue | undefined,
): void {
  if (!isJsonObject(entries)) {
    return;
  }
  const catalog = catalogs.get(name) ?? new Map<string, string>();
  for (const [dependency, range] of Object.entries(entries)) {
    if (isJsonString(range) && !catalog.has(dependency)) {
      catalog.set(dependency, range);
    }
  }
  catalogs.set(name, catalog);
}

async function readDocument(
  filePath: string,
  parseText: (text: string) => JsonValue,
): Promise<JsonValue> {
  try {
    return parseText(await readFile(filePath, "utf8"));
  } catch {
    // A missing or malformed workspace file declares no catalog.
    return null;
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return value?.constructor === String;
}
