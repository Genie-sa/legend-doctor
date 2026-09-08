import { AnalysisProject, isSupportedAnalysisFile } from "../analysis-project.js";
import { readFile, readdir } from "node:fs/promises";
import type { InstalledLegendState } from "../legend-state-package.js";
import type { SourceIndex } from "../source-components/source-components.js";
import { buildSourceIndexFromFiles } from "../source-components/source-components.js";
import { loadWorkspaceSources } from "../workspace/source-closure.js";
import path from "node:path";
import { resolveInstalledLegendState } from "../legend-state-package.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

const SOURCE_READ_BATCH_SIZE = 64;

export interface AnalysisContext {
  installedLegendState: InstalledLegendState | null;
  project: AnalysisProject;
  sourceIndex: SourceIndex;
  root: string;
}

export async function createAnalysisContext(rootPath: string): Promise<AnalysisContext> {
  const root = path.resolve(rootPath);
  const files = await collectSourceFiles(root);
  return createAnalysisContextFromFiles(root, files);
}

export async function createAnalysisContextFromFiles(
  root: string,
  files: readonly string[],
): Promise<AnalysisContext> {
  const sources = new Map<string, string>();
  await readSourceBatch(files, 0, sources);
  const host = await loadWorkspaceSources(root, sources);
  const project = new AnalysisProject(sources);
  return {
    installedLegendState: await resolveInstalledLegendState(root),
    project,
    root,
    sourceIndex: buildSourceIndexFromFiles(root, project.files, host),
  };
}

async function readSourceBatch(
  files: readonly string[],
  start: number,
  sources: Map<string, string>,
): Promise<void> {
  if (start >= files.length) {
    return;
  }
  const batch = files.slice(start, start + SOURCE_READ_BATCH_SIZE);
  const results = await Promise.allSettled(batch.map((file) => readFile(file, "utf8")));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      throw result.reason;
    }
    sources.set(batch[index]!, result.value);
  }
  await readSourceBatch(files, start + SOURCE_READ_BATCH_SIZE, sources);
}

export async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        if (entry.isSymbolicLink()) {
          return [];
        }
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return IGNORED_DIRECTORIES.has(entry.name) ? [] : await collectSourceFiles(entryPath);
        }
        return entry.isFile() && isSupportedAnalysisFile(entry.name) ? [entryPath] : [];
      }),
  );
  return collected.flat();
}
