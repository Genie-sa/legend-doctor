import { parse as parseYaml } from "yaml";
import path from "node:path";
import { readFile } from "node:fs/promises";

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;

type LockfileParser = (text: string) => readonly string[];

const PACKAGE_NAME = "@legendapp/state";
const PACKAGE_LOCK_KEY = `node_modules/${PACKAGE_NAME}`;
const BUN_ENTRY = /"(?:[^"\n]*\/)?@legendapp\/state": \["@legendapp\/state@(?<version>[^"]+)"/gu;
const PNPM_KEY = /^\/?@legendapp\/state[@/](?<version>[^(/@]+)/u;
const YARN_VERSION = /^\s+version:? "?(?<version>[^"\s]+)"?$/mu;
const YARN_BLOCK_SEPARATOR = /\n\s*\n/u;

/** Lockfiles in the order a directory is checked; the first one present decides. */
const LOCKFILES = [
  ["package-lock.json", packageLockVersions],
  ["npm-shrinkwrap.json", packageLockVersions],
  ["bun.lock", bunLockVersions],
  ["pnpm-lock.yaml", pnpmLockVersions],
  ["yarn.lock", yarnLockVersions],
] as const satisfies readonly (readonly [string, LockfileParser])[];

/**
 * The single `@legendapp/state` version locked by the nearest lockfile at or above `root`. A
 * lockfile that locks several versions, or none, yields `null`: no one version answers for every file.
 */
export async function lockedLegendStateVersion(root: string): Promise<string | null> {
  const candidates = ancestorDirectories(path.resolve(root)).flatMap((directory) =>
    LOCKFILES.map(([fileName, parse]) => ({ filePath: path.join(directory, fileName), parse })),
  );
  const texts = await Promise.all(candidates.map(({ filePath }) => readText(filePath)));
  const nearest = texts.findIndex((text) => text !== null);
  if (nearest === -1) {
    return null;
  }
  const distinct = new Set(candidates[nearest]!.parse(texts[nearest]!));
  return distinct.size === 1 ? [...distinct][0]! : null;
}

function ancestorDirectories(directory: string): readonly string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...ancestorDirectories(parent)];
}

function packageLockVersions(text: string): readonly string[] {
  const lock = parseDocument(text, JSON.parse);
  const packages = isJsonObject(lock) ? lock["packages"] : null;
  if (isJsonObject(packages)) {
    return Object.entries(packages)
      .filter(([key]) => key === PACKAGE_LOCK_KEY || key.endsWith(`/${PACKAGE_LOCK_KEY}`))
      .map(([, entry]) => versionField(entry))
      .filter((version) => version !== null);
  }
  const dependencies = isJsonObject(lock) ? lock["dependencies"] : null;
  const version = isJsonObject(dependencies) ? versionField(dependencies[PACKAGE_NAME]) : null;
  return version === null ? [] : [version];
}

function bunLockVersions(text: string): readonly string[] {
  return [...text.matchAll(BUN_ENTRY)].map((match) => match.groups!["version"]!);
}

function pnpmLockVersions(text: string): readonly string[] {
  const lock = parseDocument(text, parseYaml);
  const packages = isJsonObject(lock) ? lock["packages"] : null;
  if (!isJsonObject(packages)) {
    return [];
  }
  return Object.keys(packages)
    .map((key) => PNPM_KEY.exec(key)?.groups?.["version"] ?? null)
    .filter((version) => version !== null);
}

/** Classic and Berry entries: a header naming the descriptors, then an indented `version` line. */
function yarnLockVersions(text: string): readonly string[] {
  return text
    .split(YARN_BLOCK_SEPARATOR)
    .filter((block) => blockDescriptors(block).some((descriptor) => namesPackage(descriptor)))
    .map((block) => YARN_VERSION.exec(block)?.groups?.["version"] ?? null)
    .filter((version) => version !== null);
}

function blockDescriptors(block: string): readonly string[] {
  const header = block.split("\n").find((line) => line.length > 0 && !line.startsWith("#"));
  if (!header || header.startsWith(" ")) {
    return [];
  }
  return header
    .replace(/:$/u, "")
    .split(",")
    .map((descriptor) => descriptor.trim().replaceAll('"', ""));
}

function namesPackage(descriptor: string): boolean {
  return descriptor.startsWith(`${PACKAGE_NAME}@`);
}

function versionField(entry: JsonValue | undefined): string | null {
  const version = isJsonObject(entry) ? entry["version"] : null;
  return isJsonString(version) && version.length > 0 ? version : null;
}

function parseDocument(text: string, parseText: (text: string) => JsonValue): JsonValue {
  try {
    return parseText(text);
  } catch {
    // A malformed lockfile pins no version.
    return null;
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return value?.constructor === String;
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
