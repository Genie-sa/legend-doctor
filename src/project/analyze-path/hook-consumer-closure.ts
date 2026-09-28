import type { ClosureIndex, ComputedLoad, UnresolvedImport } from "./hook-closure-index.js";
import { closureIndex, isPublishedManifest } from "./hook-closure-index.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { AnalysisFile } from "../analysis-project.js";
import type { ResolvedSymbol } from "../source-components/model.js";
import { isNonProductionHarness } from "../../core/ast.js";
import { isSupportedAnalysisFile } from "../analysis-project.js";
import { isWithin } from "../workspace/packages.js";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";
import ts from "typescript";

export interface ClosedHookBinding {
  readonly file: AnalysisFile;
  readonly harness: boolean;
  readonly hookBinding: string;
}

export interface HookClosure {
  readonly bindings: readonly ClosedHookBinding[];
  /** Test or story files that may reach the hook without a traceable binding. */
  readonly opaqueHarnesses: readonly AnalysisFile[];
}

interface ClosureQuery {
  readonly declaration: ResolvedSymbol;
  readonly exposing: ReadonlySet<string>;
}

/**
 * Every source binding of one hook when the scanned root is a closed world for it: the root holds
 * the hook's whole package, and that package is not published. Test and story harnesses may reach
 * it opaquely; production code that could reach it through a namespace, dynamic, or computed load,
 * an unparsable file, or an unresolved import of its name returns null.
 */
export function closedHookConsumers(
  context: AnalysisContext,
  declaration: ResolvedSymbol,
): HookClosure | null {
  const declaringFile = context.project.getFile(declaration.file);
  const index = closureIndex(context);
  if (
    !declaringFile ||
    isNonProductionHarness(declaringFile.originalPath) ||
    !isClosedPackageFile(context, index, declaringFile)
  ) {
    return null;
  }
  const query: ClosureQuery = {
    declaration,
    exposing: exposingModules(index, pathIdentityKey(declaration.file)),
  };
  const opaqueHarnesses = opaqueReaches(index, query);
  const bindings = opaqueHarnesses.every((file) => isNonProductionHarness(file.originalPath))
    ? traceableBindings(context, index, query)
    : null;
  return (
    bindings && {
      bindings: [
        ...bindings,
        { file: declaringFile, harness: false, hookBinding: declaration.localName },
      ],
      opaqueHarnesses,
    }
  );
}

/** Code outside the scan root can import any module of a package the root holds only in part. */
function isClosedPackageFile(
  context: AnalysisContext,
  index: ClosureIndex,
  file: AnalysisFile,
): boolean {
  const manifest = ts.findConfigFile(
    path.dirname(file.originalPath),
    ts.sys.fileExists,
    "package.json",
  );
  return (
    manifest !== undefined &&
    isWithin(context.root, path.dirname(manifest)) &&
    !isPublishedManifest(index, manifest)
  );
}

function opaqueReaches(
  index: ClosureIndex,
  { declaration, exposing }: ClosureQuery,
): AnalysisFile[] {
  return [
    ...index.opaqueLoads.filter((load) => exposing.has(load.target)).map((load) => load.file),
    ...index.computedLoads
      .filter((load) => computedLoadMayReach(load, declaration.file))
      .map((load) => load.file),
    ...index.erroredFiles.filter((file) => file.sourceFile.text.includes(declaration.localName)),
    ...index.unresolvedImports
      .filter((entry) => mayImportHook(entry, declaration))
      .map((entry) => entry.file),
  ];
}

function traceableBindings(
  context: AnalysisContext,
  index: ClosureIndex,
  { declaration, exposing }: ClosureQuery,
): ClosedHookBinding[] | null {
  const bindings: ClosedHookBinding[] = [];
  for (const binding of index.bindings) {
    if (!exposing.has(binding.target)) {
      continue;
    }
    const resolved = context.sourceIndex.hookDeclarationFor(
      binding.file.identityPath,
      binding.localName,
    );
    // An export chain beyond the resolver's depth leaves a same-named import unresolved.
    if (resolved === null && binding.importedName === declaration.localName) {
      return null;
    }
    if (resolved && sameSymbol(resolved, declaration)) {
      bindings.push({
        file: binding.file,
        harness: isNonProductionHarness(binding.file.originalPath),
        hookBinding: binding.localName,
      });
    }
  }
  return bindings;
}

function sameSymbol(left: ResolvedSymbol, right: ResolvedSymbol): boolean {
  return (
    left.localName === right.localName && pathIdentityKey(left.file) === pathIdentityKey(right.file)
  );
}

function mayImportHook(entry: UnresolvedImport, declaration: ResolvedSymbol): boolean {
  if (entry.importedNames.has(declaration.localName)) {
    return true;
  }
  const moduleName = path.basename(declaration.file).replace(/\.[^.]+$/u, "");
  return entry.defaultImport && path.basename(entry.specifier) === moduleName;
}

/**
 * A template specifier ending in a non-source extension, such as `../locales/${language}.json`, or
 * one whose static relative directory excludes the hook's module cannot load it; any other computed
 * load can.
 */
function computedLoadMayReach({ file, specifier }: ComputedLoad, target: string): boolean {
  if (!specifier || !ts.isTemplateExpression(specifier)) {
    return true;
  }
  if (!templateMayNameSourceFile(specifier)) {
    return false;
  }
  const directory = staticRelativeDirectory(file, specifier.head.text);
  return directory === null || isWithin(directory, target);
}

function templateMayNameSourceFile(specifier: ts.TemplateExpression): boolean {
  const tail = specifier.templateSpans.at(-1)?.literal.text ?? "";
  const extension = /\.[a-z0-9]+$/iu.exec(tail)?.[0];
  return extension === undefined || isSupportedAnalysisFile(`module${extension}`);
}

function staticRelativeDirectory(file: AnalysisFile, head: string): string | null {
  const directoryEnd = head.lastIndexOf("/");
  return head.startsWith(".") && directoryEnd !== -1
    ? path.resolve(path.dirname(file.originalPath), head.slice(0, directoryEnd))
    : null;
}

function exposingModules(index: ClosureIndex, file: string): ReadonlySet<string> {
  const exposing = new Set([file]);
  const pending = [file];
  for (const module of pending) {
    for (const reexporter of index.reexporters.get(module) ?? []) {
      if (!exposing.has(reexporter)) {
        exposing.add(reexporter);
        pending.push(reexporter);
      }
    }
  }
  return exposing;
}
