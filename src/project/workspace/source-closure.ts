import {
  cachedModuleResolutionHost,
  normalizeFile,
  resolveSourceModule,
} from "../source-components/module-resolution.js";
import { isWithin, workspaceLinks, workspacePackages } from "./packages.js";
import type { SourceResolutionContext } from "../source-components/module-resolution.js";
import { isSupportedAnalysisFile } from "../analysis-project.js";
import path from "node:path";
import ts from "typescript";
import { workspaceResolutionHost } from "./resolution-host.js";

interface SourceClosureContext extends SourceResolutionContext {
  directories: readonly string[];
  sources: Map<string, string>;
  loaded: Set<string>;
}

export async function loadWorkspaceSources(
  root: string,
  sources: Map<string, string>,
): Promise<ts.ModuleResolutionHost> {
  const packages = await workspacePackages(root);
  const base = cachedModuleResolutionHost(new Set(sources.keys()));
  if (packages.length === 0) {
    return base;
  }
  const host = workspaceResolutionHost(base, workspaceLinks(packages));
  const context: SourceClosureContext = {
    root,
    sources,
    loaded: new Set([...sources.keys()].map((file) => sourceIdentity(host, file))),
    directories: packages.flatMap((pkg) => [pkg.dir, ts.sys.realpath?.(pkg.dir) ?? pkg.dir]),
    moduleResolutionHost: host,
    compilerContexts: new Map(),
    compilerContextsByImporter: new Map(),
    configFilesByDirectory: new Map(),
  };
  // Map iteration visits appended entries and deduplicates cycles before parsing another module.
  for (const [file, source] of sources) {
    loadImports(context, file, source);
  }
  return host;
}

function loadImports(context: SourceClosureContext, file: string, source: string): void {
  for (const reference of ts.preProcessFile(source, true, true).importedFiles) {
    const resolved = resolveSourceModule(context, file, reference.fileName);
    if (resolved && canLoad(context, resolved)) {
      const text = context.moduleResolutionHost.readFile(resolved);
      if (text !== undefined) {
        context.sources.set(resolved, text);
        context.loaded.add(sourceIdentity(context.moduleResolutionHost, resolved));
      }
    }
  }
}

function canLoad(context: SourceClosureContext, file: string): boolean {
  return (
    !context.loaded.has(sourceIdentity(context.moduleResolutionHost, file)) &&
    isSupportedAnalysisFile(file) &&
    !file.split(path.sep).includes("node_modules") &&
    context.directories.some((directory) => isWithin(directory, file))
  );
}

function sourceIdentity(host: ts.ModuleResolutionHost, file: string): string {
  return normalizeFile(host.realpath?.(file) ?? file);
}
