import type { Package } from "@manypkg/get-packages";
import { getPackages } from "@manypkg/get-packages";
import { parse as parseYaml } from "yaml";
import path from "node:path";
import { readFile } from "node:fs/promises";

/** React Native 0.82 removed the legacy architecture, so every root it creates is concurrent. */
const FIRST_CONCURRENT_ONLY_NATIVE: Version = { major: 0, minor: 82 };
/** React DOM 19 removed `render` and `hydrate`, so every root it creates is concurrent. */
const FIRST_CONCURRENT_ONLY_DOM: Version = { major: 19, minor: 0 };
const RENDERER_FLOORS: ReadonlyMap<string, Version> = new Map([
  ["react-dom", FIRST_CONCURRENT_ONLY_DOM],
  ["react-native", FIRST_CONCURRENT_ONLY_NATIVE],
  ["react-native-macos", FIRST_CONCURRENT_ONLY_NATIVE],
  ["react-native-windows", FIRST_CONCURRENT_ONLY_NATIVE],
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
type RendererVerdict = "concurrent" | "none" | "unproven";

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
  const verdicts = new Set(workspace.packages.map((pkg) => rendererVerdict(pkg, catalogs)));
  return verdicts.has("concurrent") && !verdicts.has("unproven");
}

/** A published package also runs under its consumers' renderers, so its peer ranges must qualify too. */
function rendererVerdict(pkg: Package, catalogs: Catalogs): RendererVerdict {
  const fields = pkg.packageJson.private === true ? LOCAL_FIELDS : PUBLISHED_FIELDS;
  const declarations = fields.flatMap((field) => Object.entries(pkg.packageJson[field] ?? {}));
  const renderers = declarations.flatMap(([name, range]) => {
    const floor = RENDERER_FLOORS.get(name);
    return floor ? [{ floor, name, range }] : [];
  });
  if (renderers.length === 0) {
    return "none";
  }
  return renderers.every(({ floor, name, range }) => {
    const minimum = minimumVersion(resolveRange(name, range, catalogs));
    return minimum !== null && compareVersions(minimum, floor) >= 0;
  })
    ? "concurrent"
    : "unproven";
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
