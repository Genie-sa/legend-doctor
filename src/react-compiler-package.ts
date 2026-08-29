import { readFile } from "node:fs/promises";
import path from "node:path";

const COMPILER_PACKAGES = ["babel-plugin-react-compiler", "react-compiler-runtime"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];

export class ReactCompilerResolver {
  private readonly directories = new Map<string, Promise<boolean>>();

  packageCompilesFile(filePath: string): Promise<boolean> {
    return this.directoryCompiles(path.dirname(path.resolve(filePath)));
  }

  private directoryCompiles(directory: string): Promise<boolean> {
    const cached = this.directories.get(directory);
    if (cached) return cached;
    const result = this.resolveDirectory(directory);
    this.directories.set(directory, result);
    return result;
  }

  private async resolveDirectory(directory: string): Promise<boolean> {
    if (await manifestDeclaresReactCompiler(path.join(directory, "package.json"))) return true;
    if (await expoConfigEnablesReactCompiler(directory)) return true;
    const parent = path.dirname(directory);
    return parent === directory ? false : this.directoryCompiles(parent);
  }
}

async function manifestDeclaresReactCompiler(manifestPath: string): Promise<boolean> {
  const manifest = await readJson(manifestPath);
  if (!manifest) return false;
  return DEPENDENCY_FIELDS.some(field => {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null) return false;
    return COMPILER_PACKAGES.some(name => name in (dependencies as Record<string, unknown>));
  });
}

async function expoConfigEnablesReactCompiler(directory: string): Promise<boolean> {
  for (const name of ["app.json", "app.config.json"]) {
    const config = await readJson(path.join(directory, name));
    if (config && experimentsEnableReactCompiler(config)) return true;
  }
  for (const name of ["app.config.js", "app.config.ts", "app.config.mjs"]) {
    const text = await readText(path.join(directory, name));
    if (text && /\breactCompiler\b\s*:\s*true\b/.test(text)) return true;
  }
  return false;
}

function experimentsEnableReactCompiler(config: Record<string, unknown>): boolean {
  const expo = config["expo"];
  const roots = [config, typeof expo === "object" && expo !== null ? (expo as Record<string, unknown>) : null];
  return roots.some(root => {
    const experiments = root?.["experiments"];
    return typeof experiments === "object" &&
      experiments !== null &&
      (experiments as Record<string, unknown>)["reactCompiler"] === true;
  });
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  const text = await readText(filePath);
  if (!text) return null;
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
