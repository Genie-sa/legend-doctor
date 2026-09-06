import { URL, fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export interface AnalyzerIdentity {
  readonly build: string;
  readonly version: string;
}

const BUILD_DIGEST_LENGTH = 16;

export async function analyzerIdentity(): Promise<AnalyzerIdentity> {
  const [version, build] = await Promise.all([packageVersion(), buildDigest()]);
  return { build, version };
}

async function packageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const declared =
    manifest instanceof Object ? new Map(Object.entries(manifest)).get("version") : undefined;
  if (String(declared) !== declared) {
    throw new Error("package.json does not declare a string version");
  }
  return declared;
}

/** Digests every compiled module in dependency-free order so equal builds compare equal. */
async function buildDigest(): Promise<string> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = await compiledModules(root);
  const contents = await Promise.all(files.map((file) => readFile(file)));
  const hash = createHash("sha256");
  for (const [index, file] of files.entries()) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(contents[index]!);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, BUILD_DIGEST_LENGTH);
}

function entryModules(directory: string, entry: Dirent): Promise<readonly string[]> {
  const full = path.join(directory, entry.name);
  if (entry.isDirectory()) {
    return compiledModules(full);
  }
  return Promise.resolve(entry.name.endsWith(".js") ? [full] : []);
}

async function compiledModules(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sorted = entries.toSorted((left, right) => left.name.localeCompare(right.name));
  const nested = await Promise.all(sorted.map((entry) => entryModules(directory, entry)));
  return nested.flat();
}
