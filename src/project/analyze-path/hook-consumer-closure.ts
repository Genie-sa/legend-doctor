import type { ClosureIndex, ComputedLoad, UnresolvedImport } from "./hook-closure-index.js";
import { closureIndex, isPublishedManifest } from "./hook-closure-index.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { AnalysisFile } from "../analysis-project.js";
import type { OutsideRootSources } from "./hook-closure-outside.js";
import type { ResolvedSymbol } from "../source-components/model.js";
import { isNonProductionHarness } from "../../core/ast.js";
import { isSupportedAnalysisFile } from "../analysis-project.js";
import { isWithin } from "../workspace/packages.js";
import { outsideRootSources } from "./hook-closure-outside.js";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";
import ts from "typescript";

export interface ClosedBinding {
  readonly file: AnalysisFile;
  readonly localName: string;
}

export interface SymbolClosure {
  /** Production source bindings of the symbol, including its declaring file. */
  readonly consumers: readonly ClosedBinding[];
  /** Test and story files that import the symbol or may reach it without a traceable binding. */
  readonly harnesses: readonly AnalysisFile[];
}

type SymbolResolver = (file: string, localName: string) => ResolvedSymbol | null;

interface ClosureQuery {
  readonly declaration: ResolvedSymbol;
  readonly exposing: ReadonlySet<string>;
  readonly resolve: SymbolResolver;
}

/**
 * Every source binding of one hook when its unpublished package is a closed world, reading the
 * package's sources beside a partial scan root. Test and story harnesses may reach it opaquely;
 * production code that could reach it through a namespace, dynamic, computed, or mocked load, an
 * unparsable file, an unresolved import of its name, or an untraceable source outside the scan root
 * returns null.
 */
export function closedHookConsumers(
  context: AnalysisContext,
  declaration: ResolvedSymbol,
): SymbolClosure | null {
  return closedSymbolBindings(context, declaration, (file, localName) =>
    context.sourceIndex.hookDeclarationFor(file, localName),
  );
}

/** Every source binding of one component, under the same closed-world proof as a hook's. */
export function closedComponentBindings(
  context: AnalysisContext,
  declaration: ResolvedSymbol,
): SymbolClosure | null {
  return closedSymbolBindings(context, declaration, (file, localName) =>
    context.sourceIndex.componentDeclarationFor(file, localName),
  );
}

function closedSymbolBindings(
  context: AnalysisContext,
  declaration: ResolvedSymbol,
  resolve: SymbolResolver,
): SymbolClosure | null {
  const declaringFile = context.project.getFile(declaration.file);
  const index = closureIndex(context);
  const scope =
    declaringFile && !isHarnessFile(declaringFile)
      ? packageScope(context, index, declaringFile)
      : null;
  if (!declaringFile || !scope) {
    return null;
  }
  const query: ClosureQuery = {
    declaration,
    exposing: exposingModules(index, pathIdentityKey(declaration.file)),
    resolve,
  };
  const opaque = [
    ...opaqueReaches(index, query),
    ...(scope.outside === null
      ? []
      : outsideReaches(outsideRootSources(context, scope.outside), query)),
  ];
  const bindings = opaque.every((file) => isHarnessFile(file))
    ? traceableBindings(index, query)
    : null;
  return (
    bindings &&
    splitHarnesses([...bindings, { file: declaringFile, localName: declaration.localName }], opaque)
  );
}

function splitHarnesses(
  bindings: readonly ClosedBinding[],
  opaque: readonly AnalysisFile[],
): SymbolClosure {
  const traced = bindings.filter((binding) => isHarnessFile(binding.file));
  return {
    consumers: bindings.filter((binding) => !isHarnessFile(binding.file)),
    harnesses: [...new Set([...opaque, ...traced.map((binding) => binding.file)])],
  };
}

function isHarnessFile(file: AnalysisFile): boolean {
  return isNonProductionHarness(file.originalPath);
}

interface PackageScope {
  /** The package directory when the scan root holds only part of it. */
  readonly outside: string | null;
}

/**
 * Unseen code can import a published package, so it has no closed world. Without a manifest there
 * is no package, and the scan root is the whole program.
 */
function packageScope(
  context: AnalysisContext,
  index: ClosureIndex,
  file: AnalysisFile,
): PackageScope | null {
  const manifest = ts.findConfigFile(
    path.dirname(file.originalPath),
    ts.sys.fileExists,
    "package.json",
  );
  if (manifest === undefined) {
    return { outside: null };
  }
  const directory = path.dirname(manifest);
  return isPublishedManifest(index, manifest)
    ? null
    : { outside: isWithin(context.root, directory) ? null : directory };
}

/**
 * Sources outside the scan root have no hook resolution, so an import of the hook's name, of a
 * default export, or of anything through a barrel counts as a reach, as does a re-export.
 */
function outsideReaches(
  { index, project }: OutsideRootSources,
  query: ClosureQuery,
): AnalysisFile[] {
  const declaringModule = pathIdentityKey(query.declaration.file);
  const reexporters = [...query.exposing].flatMap((module) => [
    ...(index.reexporters.get(module) ?? []),
  ]);
  return [
    ...opaqueReaches(index, query),
    ...index.bindings
      .filter(
        (binding) =>
          query.exposing.has(binding.target) &&
          (binding.importedName === query.declaration.localName ||
            binding.importedName === "default" ||
            binding.target !== declaringModule),
      )
      .map((binding) => binding.file),
    ...reexporters.flatMap((key) => project.getFile(key) ?? []),
  ];
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
      .filter((entry) => mayImportSymbol(entry, declaration))
      .map((entry) => entry.file),
  ];
}

function traceableBindings(
  index: ClosureIndex,
  { declaration, exposing, resolve }: ClosureQuery,
): ClosedBinding[] | null {
  const bindings: ClosedBinding[] = [];
  for (const binding of index.bindings) {
    if (!exposing.has(binding.target)) {
      continue;
    }
    const resolved = resolve(binding.file.identityPath, binding.localName);
    // An export chain beyond the resolver's depth leaves a same-named import unresolved.
    if (resolved === null && binding.importedName === declaration.localName) {
      return null;
    }
    if (resolved && sameSymbol(resolved, declaration)) {
      bindings.push({ file: binding.file, localName: binding.localName });
    }
  }
  return bindings;
}

function sameSymbol(left: ResolvedSymbol, right: ResolvedSymbol): boolean {
  return (
    left.localName === right.localName && pathIdentityKey(left.file) === pathIdentityKey(right.file)
  );
}

function mayImportSymbol(entry: UnresolvedImport, declaration: ResolvedSymbol): boolean {
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
