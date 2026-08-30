import { readFile } from "node:fs/promises";
import path from "node:path";

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
  /babel-plugin-react-compiler|react-compiler-runtime|reactCompilerPreset|\breactCompiler\b['"]?\s*:\s*(?:true|\{)/;

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

async function manifestDeclaresReactCompiler(manifestPath: string): Promise<boolean> {
  const text = await readText(manifestPath);
  if (!text) {
    return false;
  }
  const manifest = parseJson(text);
  if (!manifest) {
    return false;
  }
  const declared = DEPENDENCY_FIELDS.some((field) => {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null) {
      return false;
    }
    return COMPILER_PACKAGES.some((name) => name in (dependencies as Record<string, unknown>));
  });
  if (declared) {
    return true;
  }
  const { babel } = manifest;
  return babel !== undefined && CONFIG_MARKER.test(JSON.stringify(babel));
}

async function configEnablesReactCompiler(directory: string): Promise<boolean> {
  for (const name of CONFIG_FILES) {
    const text = await readText(path.join(directory, name));
    if (text && CONFIG_MARKER.test(text)) {
      return true;
    }
  }
  return false;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
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
