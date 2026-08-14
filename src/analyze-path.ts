import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { analyzeLegendPractices } from "./analyze-legend-practices.js";
import { analyzeSource } from "./analyze-source.js";
import { buildSourceIndex, type SourceIndex } from "./source-components.js";
import type { AnalysisReport, HookFinding, LegendPracticeFinding } from "./types.js";

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
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

export interface AnalysisContext {
  sourceIndex: SourceIndex;
  root: string;
  sources: ReadonlyMap<string, string>;
}

export async function createAnalysisContext(rootPath: string): Promise<AnalysisContext> {
  const root = path.resolve(rootPath);
  const files = await collectSourceFiles(root);
  const sources = new Map<string, string>();
  for (const file of files) sources.set(file, await readFile(file, "utf8"));
  return {
    sourceIndex: buildSourceIndex(root, sources),
    root,
    sources,
  };
}

export async function analyzePath(
  targetPath: string,
  sharedContext?: AnalysisContext
): Promise<AnalysisReport> {
  const absoluteTarget = path.resolve(targetPath);
  const targetStats = await stat(absoluteTarget);
  const analysisRoot = targetStats.isDirectory() ? absoluteTarget : path.dirname(absoluteTarget);
  const files = targetStats.isDirectory() ? await collectSourceFiles(absoluteTarget) : [absoluteTarget];
  const context = sharedContext ?? await createAnalysisContext(analysisRoot);
  const findings: HookFinding[] = [];
  const practices: LegendPracticeFinding[] = [];
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const sourceText = context.sources.get(file) ?? await readFile(file, "utf8");
    findings.push(
      ...analyzeSource(
        sourceText,
        path.relative(analysisRoot, file) || path.basename(file),
        context.sourceIndex.componentsFor(file)
      )
    );
    const mayContainLegendPractice =
      /\.(?:get|set)\s*\(/.test(sourceText) || /\buseValue\s*\(/.test(sourceText);
    const importedObservables = mayContainLegendPractice
      ? context.sourceIndex.observablesFor(file)
      : new Set<string>();
    if (
      mayContainLegendPractice &&
      (sourceText.includes("@legendapp/state") || importedObservables.size > 0)
    ) {
      practices.push(
        ...analyzeLegendPractices(
          sourceText,
          path.relative(analysisRoot, file) || path.basename(file),
          importedObservables
        )
      );
    }
  }

  const states = findings.filter(finding => finding.hook === "useState").length;
  const effects = findings.filter(finding => finding.hook === "useEffect").length;
  return {
    files: files.length,
    findings,
    hooks: { effects, states, total: states + effects },
    practices,
  };
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(entryPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files;
}
