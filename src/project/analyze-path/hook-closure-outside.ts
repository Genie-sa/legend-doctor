import { AnalysisProject, isSupportedAnalysisFile } from "../analysis-project.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { ClosureIndex } from "./hook-closure-index.js";
import { indexFiles } from "./hook-closure-index.js";
import { isWithin } from "../workspace/packages.js";
import ts from "typescript";

export interface OutsideRootSources {
  readonly index: ClosureIndex;
  readonly project: AnalysisProject;
}

const IGNORED_DIRECTORIES = [
  "**/.git",
  "**/.next",
  "**/.turbo",
  "**/build",
  "**/coverage",
  "**/dist",
  "**/node_modules",
  "**/vendor",
];
const SOURCE_EXTENSIONS = [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"];

// Context identity owns the snapshot: a new scan re-reads every package directory.
const outsideByContext = new WeakMap<AnalysisContext, Map<string, OutsideRootSources>>();

/**
 * The module loads of a package's sources that the scan root leaves out, such as tests or scripts
 * beside a scanned `src` directory.
 */
export function outsideRootSources(
  context: AnalysisContext,
  packageDirectory: string,
): OutsideRootSources {
  const byPackage = outsideByContext.get(context) ?? new Map<string, OutsideRootSources>();
  outsideByContext.set(context, byPackage);
  const cached = byPackage.get(packageDirectory);
  if (cached) {
    return cached;
  }
  const project = new AnalysisProject(readOutsideSources(context, packageDirectory));
  const sources = { index: indexFiles(context, project.files), project };
  byPackage.set(packageDirectory, sources);
  return sources;
}

function readOutsideSources(
  context: AnalysisContext,
  packageDirectory: string,
): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  const files = ts.sys.readDirectory(packageDirectory, SOURCE_EXTENSIONS, IGNORED_DIRECTORIES);
  for (const file of files) {
    const text = isOutsideSource(context, file) ? ts.sys.readFile(file) : undefined;
    if (text !== undefined) {
      sources.set(file, text);
    }
  }
  return sources;
}

function isOutsideSource(context: AnalysisContext, file: string): boolean {
  return (
    isSupportedAnalysisFile(file) &&
    !/\.d\.[cm]?ts$/u.test(file) &&
    !isWithin(context.root, file) &&
    context.project.getFile(file) === undefined
  );
}
