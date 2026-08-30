import { readFile } from "node:fs/promises";
import path from "node:path";

export type UseValueExport = "alias" | "distinct" | "missing" | "unknown";

export interface InstalledLegendState {
  /** How the installed react entry point exports useValue relative to useSelector. */
  useValueExport: UseValueExport;
  version: string;
}

const REACT_TYPE_CANDIDATES = [
  "react.d.ts",
  path.join("react", "index.d.ts"),
  path.join("dist", "react.d.ts"),
];

export async function resolveInstalledLegendState(
  root: string,
): Promise<InstalledLegendState | null> {
  for (
    let current = path.resolve(root), previous = "";
    current !== previous;
    previous = current, current = path.dirname(current)
  ) {
    const packageDirectory = path.join(current, "node_modules", "@legendapp", "state");
    const manifest = await readJson(path.join(packageDirectory, "package.json"));
    if (!manifest) {
      continue;
    }
    const version = typeof manifest.version === "string" ? manifest.version : null;
    if (!version) {
      return null;
    }
    return {
      useValueExport: await resolveUseValueExport(packageDirectory, manifest),
      version,
    };
  }
  return null;
}

async function resolveUseValueExport(
  packageDirectory: string,
  manifest: Record<string, unknown>,
): Promise<UseValueExport> {
  const candidates = [...reactTypesFromExports(manifest), ...REACT_TYPE_CANDIDATES];
  for (const candidate of candidates) {
    const declaration = await readText(path.join(packageDirectory, candidate));
    if (!declaration) {
      continue;
    }
    if (/\buseSelector\s+as\s+useValue\b/.test(declaration)) {
      return "alias";
    }
    return /\buseValue\b/.test(declaration) ? "distinct" : "missing";
  }
  return "unknown";
}

function reactTypesFromExports(manifest: Record<string, unknown>): string[] {
  const exportsField = manifest["exports"];
  if (typeof exportsField !== "object" || exportsField === null) {
    return [];
  }
  const reactEntry = (exportsField as Record<string, unknown>)["./react"];
  const candidates: string[] = [];
  const collect = (entry: unknown): void => {
    if (typeof entry === "string") {
      if (/\.d\.[cm]?ts$/.test(entry)) {
        candidates.push(entry);
      }
      return;
    }
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    for (const value of Object.values(entry)) {
      collect(value);
    }
  };
  collect(reactEntry);
  return candidates;
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  const text = await readText(filePath);
  if (!text) {
    return null;
  }
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
