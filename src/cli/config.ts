import { isAction, isMaterialityTier } from "./options.js";
import { readFile, stat } from "node:fs/promises";
import type { Action } from "./options.js";
import type { MaterialityTier } from "../analysis/constants.js";
import { UsageError } from "./usage-error.js";
import path from "node:path";

export const CONFIG_FILE_NAME = "legend-doctor.config.json";

/** Project defaults read from the nearest `legend-doctor.config.json` at or above the scan root. */
export interface ScanConfig {
  readonly ignoreActions: readonly Action[];
  readonly materiality: MaterialityTier | null;
  /** Absolute path of the file the values came from, or null when no file was found. */
  readonly source: string | null;
}

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;

const EMPTY_CONFIG: ScanConfig = { ignoreActions: [], materiality: null, source: null };

const KNOWN_KEYS: ReadonlySet<string> = new Set(["ignoreActions", "materiality"]);

/** The nearest config at or above `root`, or empty defaults when the tree carries none. */
export async function discoverConfig(root: string): Promise<ScanConfig> {
  const candidates = ancestors(path.resolve(root)).map((directory) =>
    path.join(directory, CONFIG_FILE_NAME),
  );
  const present = await Promise.all(candidates.map((candidate) => isFile(candidate)));
  const nearest = candidates.find((_candidate, index) => present[index]);
  return nearest === undefined
    ? EMPTY_CONFIG
    : parseConfig(await readFile(nearest, "utf8"), nearest);
}

export function parseConfig(text: string, source: string): ScanConfig {
  const label = path.basename(source);
  const parsed = parseJson(text, label);
  if (!isJsonObject(parsed)) {
    throw new UsageError(`${label}: expected a JSON object at the top level`);
  }
  const unknownKey = Object.keys(parsed).find((key) => !KNOWN_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new UsageError(
      `${label}: unknown key '${unknownKey}'; supported keys are ${[...KNOWN_KEYS].join(", ")}`,
    );
  }
  return {
    ignoreActions: parseIgnoreActions(parsed.ignoreActions, label),
    materiality: parseMateriality(parsed.materiality, label),
    source,
  };
}

function parseJson(text: string, label: string): JsonValue {
  try {
    const parsed: JsonValue = JSON.parse(text);
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new UsageError(`${label}: ${detail}`);
  }
}

function parseIgnoreActions(value: JsonValue | undefined, label: string): readonly Action[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new UsageError(`${label}: ignoreActions must be an array of action names`);
  }
  const names = value.map((entry) => (isJsonString(entry) ? entry : ""));
  const invalid = names.find((name) => !isAction(name));
  if (invalid !== undefined) {
    throw new UsageError(
      `${label}: ignoreActions contains an unknown action '${invalid}'; see ACTIONS.md`,
    );
  }
  return [...new Set(names.filter((name) => isAction(name)))];
}

function parseMateriality(value: JsonValue | undefined, label: string): MaterialityTier | null {
  if (value === undefined) {
    return null;
  }
  if (!isJsonString(value) || !isMaterialityTier(value)) {
    throw new UsageError(`${label}: materiality must be "broad" or "compact"`);
  }
  return value;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return value?.constructor === String;
}

function ancestors(start: string): readonly string[] {
  const directories = [start];
  let current = start;
  let parent = path.dirname(current);
  while (parent !== current) {
    directories.push(parent);
    current = parent;
    parent = path.dirname(current);
  }
  return directories;
}

function isFile(candidate: string): Promise<boolean> {
  return stat(candidate).then(
    (entry) => entry.isFile(),
    () => false,
  );
}
