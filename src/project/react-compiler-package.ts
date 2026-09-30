import path from "node:path";
import { readOptionalText } from "./read-optional-text.js";
import { readdir } from "node:fs/promises";

const COMPILER_PACKAGES = ["babel-plugin-react-compiler", "react-compiler-runtime"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];
const CONFIG_FILES = [
  "app.json",
  "app.config.js",
  "app.config.ts",
  "app.config.cjs",
  "app.config.mjs",
  "app.config.json",
  "babel.config.js",
  "babel.config.cjs",
  "babel.config.mjs",
  "babel.config.ts",
  "babel.config.json",
  ".babelrc",
  ".babelrc.js",
  ".babelrc.cjs",
  ".babelrc.json",
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cjs",
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.mts",
];
// Matches every known enablement spelling: the Babel plugin name (Babel, Vite,
// Metro configs), the pre-19 runtime package, @vitejs/plugin-react's
// ReactCompilerPreset, and the `reactCompiler: true | {...}` config key used by
// Next.js and Expo `experiments`. `reactCompiler: false` stays unmatched.
const CONFIG_MARKER =
  /babel-plugin-react-compiler|react-compiler-runtime|reactCompilerPreset|\breactCompiler\b['"]?\s*:\s*(?:true|\{)/u;

interface Toolchain {
  readonly config: RegExp;
  readonly packages: readonly string[];
}

export const REACT_COMPILER: Toolchain = { config: CONFIG_MARKER, packages: COMPILER_PACKAGES };
/** Only a listed plugin enables it: every Legend app depends on the package that ships it. */
export const LEGEND_BABEL: Toolchain = {
  config: /["'`]@legendapp\/state\/babel["'`]/u,
  packages: [],
};

export class ToolchainResolver {
  private readonly directories = new Map<string, Promise<boolean>>();
  private readonly toolchain: Toolchain;

  public constructor(toolchain: Toolchain) {
    this.toolchain = toolchain;
  }

  public packageEnablesFile(filePath: string): Promise<boolean> {
    return this.directoryEnables(path.dirname(path.resolve(filePath)));
  }

  public enablesDirectory(directory: string): Promise<boolean> {
    return this.directoryEnables(path.resolve(directory));
  }

  private directoryEnables(directory: string): Promise<boolean> {
    const cached = this.directories.get(directory);
    if (cached) {
      return cached;
    }
    const result = this.resolveDirectory(directory);
    this.directories.set(directory, result);
    return result;
  }

  private async resolveDirectory(directory: string): Promise<boolean> {
    if (await manifestEnables(path.join(directory, "package.json"), this.toolchain)) {
      return true;
    }
    if (await configEnables(directory, this.toolchain.config)) {
      return true;
    }
    const parent = path.dirname(directory);
    return parent === directory ? false : this.directoryEnables(parent);
  }
}

interface ManifestFacts {
  readonly declaresDependency: boolean;
  readonly babelConfigText: string;
}

async function manifestEnables(manifestPath: string, toolchain: Toolchain): Promise<boolean> {
  const text = await readOptionalText(manifestPath);
  if (text === null) {
    return false;
  }
  const facts = readManifestFacts(text, toolchain.packages);
  if (facts === null) {
    return false;
  }
  return facts.declaresDependency || toolchain.config.test(facts.babelConfigText);
}

function readManifestFacts(text: string, packages: readonly string[]): ManifestFacts | null {
  const manifest = parseJsonObject(text);
  if (manifest === null) {
    return null;
  }
  const babel = manifest.get("babel");
  return {
    babelConfigText: babel === undefined ? "" : JSON.stringify(babel),
    declaresDependency: DEPENDENCY_FIELDS.some((field) => {
      const dependencies = manifest.get(field);
      const names = dependencies instanceof Object ? Object.keys(dependencies) : [];
      return packages.some((packageName) => names.includes(packageName));
    }),
  };
}

async function configEnables(directory: string, config: RegExp): Promise<boolean> {
  const names = await directoryEntryNames(directory);
  const candidates = names ? CONFIG_FILES.filter((name) => names.has(name)) : CONFIG_FILES;
  return anyFileMatches(
    candidates.map((name) => path.join(directory, name)),
    config,
  );
}

async function directoryEntryNames(directory: string): Promise<ReadonlySet<string> | null> {
  try {
    // Keep case-insensitive filesystem matches; readFile still decides whether a candidate exists.
    const entries = await readdir(directory);
    return new Set(entries.map((name) => name.toLowerCase()));
  } catch {
    // Searchable directories can permit known-file reads without permitting a listing.
    return null;
  }
}

async function anyFileMatches(filePaths: readonly string[], config: RegExp): Promise<boolean> {
  const [head, ...rest] = filePaths;
  if (head === undefined) {
    return false;
  }
  const text = await readOptionalText(head);
  if (text !== null && config.test(text)) {
    return true;
  }
  return anyFileMatches(rest, config);
}

function parseJsonObject(text: string): ReadonlyMap<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!(parsed instanceof Object)) {
      return null;
    }
    const entries: readonly (readonly [string, unknown])[] = Object.entries(parsed);
    return new Map(entries);
  } catch {
    return null;
  }
}
