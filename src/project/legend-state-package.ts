import type { InstalledLegendState, SyncExport, UseValueExport } from "../core/types.js";
import path from "node:path";
import { readFile } from "node:fs/promises";

export type { InstalledLegendState, SyncExport, UseValueExport } from "../core/types.js";

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;

const REACT_TYPE_CANDIDATES = [
  "react.d.ts",
  path.join("react", "index.d.ts"),
  path.join("dist", "react.d.ts"),
];
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/u;
const USE_VALUE_ALIAS_PATTERN = /\buseSelector\s+as\s+useValue\b/u;
const USE_VALUE_PATTERN = /\buseValue\b/u;
const SYNC_ENTRY = "./sync";
const SYNC_DECLARATION_FILE = "sync.d.ts";

export function resolveInstalledLegendState(root: string): Promise<InstalledLegendState | null> {
  return resolveFromAncestor(path.resolve(root));
}

async function resolveFromAncestor(directory: string): Promise<InstalledLegendState | null> {
  const packageDirectory = path.join(directory, "node_modules", "@legendapp", "state");
  const manifest = await readJson(path.join(packageDirectory, "package.json"));
  if (isJsonObject(manifest)) {
    return resolveFromManifest(packageDirectory, manifest);
  }
  const parent = path.dirname(directory);
  return parent === directory ? null : resolveFromAncestor(parent);
}

async function resolveFromManifest(
  packageDirectory: string,
  manifest: JsonObject,
): Promise<InstalledLegendState | null> {
  const { version } = manifest;
  if (!isJsonString(version) || version.length === 0) {
    return null;
  }
  const [syncExport, useValueExport] = await Promise.all([
    resolveSyncExport(packageDirectory, manifest),
    resolveUseValueExport(packageDirectory, manifest),
  ]);
  return { syncExport, useValueExport, version };
}

async function resolveSyncExport(
  packageDirectory: string,
  manifest: JsonObject,
): Promise<SyncExport> {
  const exportsField = manifest["exports"];
  if (isJsonObject(exportsField)) {
    return Object.hasOwn(exportsField, SYNC_ENTRY) ? "available" : "missing";
  }
  const declaration = await readText(path.join(packageDirectory, SYNC_DECLARATION_FILE));
  return declaration === null ? "unknown" : "available";
}

async function resolveUseValueExport(
  packageDirectory: string,
  manifest: JsonObject,
): Promise<UseValueExport> {
  const candidates = [...reactTypesFromExports(manifest), ...REACT_TYPE_CANDIDATES];
  const declarations = await Promise.all(
    candidates.map((candidate) => readText(path.join(packageDirectory, candidate))),
  );
  const declaration = declarations.find((text) => text !== null && text.length > 0) ?? null;
  if (declaration === null) {
    return "unknown";
  }
  if (USE_VALUE_ALIAS_PATTERN.test(declaration)) {
    return "alias";
  }
  return USE_VALUE_PATTERN.test(declaration) ? "distinct" : "missing";
}

function reactTypesFromExports(manifest: JsonObject): string[] {
  const exportsField = manifest["exports"];
  if (!isJsonObject(exportsField)) {
    return [];
  }
  const candidates: string[] = [];
  collectDeclarationFiles(exportsField["./react"], candidates);
  return candidates;
}

function collectDeclarationFiles(entry: JsonValue | undefined, candidates: string[]): void {
  if (isJsonString(entry)) {
    if (DECLARATION_FILE_PATTERN.test(entry)) {
      candidates.push(entry);
    }
    return;
  }
  if (!isJsonCollection(entry)) {
    return;
  }
  for (const value of Object.values(entry)) {
    collectDeclarationFiles(value, candidates);
  }
}

function isJsonCollection(
  value: JsonValue | undefined,
): value is JsonObject | readonly JsonValue[] {
  return value instanceof Object;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return value?.constructor === String;
}

async function readJson(filePath: string): Promise<JsonValue> {
  const text = await readText(filePath);
  if (!text) {
    return null;
  }
  try {
    const parsed: JsonValue = JSON.parse(text);
    return parsed;
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
