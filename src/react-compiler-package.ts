import path from "node:path";
import { readFile } from "node:fs/promises";

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

export class ReactCompilerResolver {
  private readonly directories = new Map<string, Promise<boolean>>();

  public packageCompilesFile(filePath: string): Promise<boolean> {
    return this.directoryCompiles(path.dirname(path.resolve(filePath)));
  }

  private directoryCompiles(directory: string): Promise<boolean> {
    const cached = this.directories.get(directory);
    if (cached) {
      return cached;
    }
    const result = this.resolveDirectory(directory);
    this.directories.set(directory, result);
    return result;
  }

  private async resolveDirectory(directory: string): Promise<boolean> {
    if (await manifestDeclaresReactCompiler(path.join(directory, "package.json"))) {
      return true;
    }
    if (await configEnablesReactCompiler(directory)) {
      return true;
    }
    const parent = path.dirname(directory);
    return parent === directory ? false : this.directoryCompiles(parent);
  }
}

interface ManifestFacts {
  readonly declaresCompilerDependency: boolean;
  readonly babelConfigText: string;
}

async function manifestDeclaresReactCompiler(manifestPath: string): Promise<boolean> {
  const text = await readText(manifestPath);
  if (text === null) {
    return false;
  }
  const facts = readManifestFacts(text);
  if (facts === null) {
    return false;
  }
  return facts.declaresCompilerDependency || CONFIG_MARKER.test(facts.babelConfigText);
}

function readManifestFacts(text: string): ManifestFacts | null {
  const manifest = parseJsonObject(text);
  if (manifest === null) {
    return null;
  }
  const babel = manifest.get("babel");
  return {
    babelConfigText: babel === undefined ? "" : JSON.stringify(babel),
    declaresCompilerDependency: DEPENDENCY_FIELDS.some((field) => {
      const dependencies = manifest.get(field);
      const names = dependencies instanceof Object ? Object.keys(dependencies) : [];
      return COMPILER_PACKAGES.some((packageName) => names.includes(packageName));
    }),
  };
}

function configEnablesReactCompiler(directory: string): Promise<boolean> {
  return anyFileMarksCompiler(CONFIG_FILES.map((name) => path.join(directory, name)));
}

async function anyFileMarksCompiler(filePaths: readonly string[]): Promise<boolean> {
  const [head, ...rest] = filePaths;
  if (head === undefined) {
    return false;
  }
  const text = await readText(head);
  if (text !== null && CONFIG_MARKER.test(text)) {
    return true;
  }
  return anyFileMarksCompiler(rest);
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

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
