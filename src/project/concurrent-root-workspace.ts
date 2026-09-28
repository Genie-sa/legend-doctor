import type { Package } from "@manypkg/get-packages";
import { domRootInventory } from "./dom-root-creation.js";
import { getPackages } from "@manypkg/get-packages";
import { hostRunsNewArchitecture } from "./native-architecture.js";
import { parse as parseYaml } from "yaml";
import path from "node:path";
import { readFile } from "node:fs/promises";

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

interface Workspace {
  readonly packages: readonly Package[];
  readonly rootDir: string;
}

async function workspaceOf(directory: string): Promise<Workspace | null> {
  try {
    const { packages, rootDir, rootPackage } = await getPackages(directory);
    return {
      packages:
        rootPackage && !packages.includes(rootPackage) ? [rootPackage, ...packages] : packages,
      rootDir,
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
 * Each React DOM 18 package must create a root with `react-dom/client` in its own source or run under a
 * framework that does, and no source file in the workspace may create a root any other way.
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
  const hosts = new Set(inventory.clientRootFiles.map((file) => owningPackage(workspace, file)));
  return packages.every((pkg) => hosts.has(pkg) || nextCreatesClientRoots(pkg, catalogs));
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
 * runs under its consumers' renderers, so its peer ranges must qualify too.
 */
function rendererVerdicts(pkg: Package, catalogs: Catalogs): ReadonlySet<RendererVerdict> {
  const fields = pkg.packageJson.private === true ? LOCAL_FIELDS : PUBLISHED_FIELDS;
  return new Set(
    fields.flatMap((field) =>
      Object.entries(pkg.packageJson[field] ?? {}).flatMap(([name, range]) => {
        const floor = RENDERER_FLOORS.get(name);
        return floor ? [declarationVerdict({ catalogs, field, floor, name, range })] : [];
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
