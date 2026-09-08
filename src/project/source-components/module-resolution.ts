import type { CompilerContext, SourceIndexState } from "./model.js";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";
import ts from "typescript";

const MISSING_BASE_CONFIG_DIAGNOSTIC_CODE = 6053;

export function resolveModule(
  state: SourceIndexState,
  importer: string,
  specifier: string,
): string | null {
  const key = `${importer}\0${specifier}`;
  if (state.resolvedModules.has(key)) {
    return state.resolvedModules.get(key) ?? null;
  }
  const local = resolveLocalModule(state, importer, specifier);
  state.resolvedModules.set(key, local);
  return local;
}

function resolveLocalModule(
  state: SourceIndexState,
  importer: string,
  specifier: string,
): string | null {
  const resolved = resolveSourceModule(state, importer, specifier);
  const key = resolved ? normalizeFile(resolved) : null;
  return key && state.records.has(key) ? key : null;
}

export interface SourceResolutionContext extends CompilerContextCaches {
  root: string;
  moduleResolutionHost: ts.ModuleResolutionHost;
}

export function resolveSourceModule(
  context: SourceResolutionContext,
  importer: string,
  specifier: string,
): string | null {
  const { cache, options } = compilerContextFor(importer, context.root, context);
  const resolution = ts.resolveModuleName(
    specifier,
    importer,
    options,
    context.moduleResolutionHost,
    cache,
    undefined,
    resolutionModeFor(importer, options, context.moduleResolutionHost),
  ).resolvedModule;
  // A declaration describes a type contract, never the callback's execution timing.
  if (!resolution || /\.d\.(?:ts|mts|cts)$/u.test(resolution.resolvedFileName)) {
    return null;
  }
  return resolution.resolvedFileName;
}

function resolutionModeFor(
  importer: string,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
): ts.ResolutionMode {
  return options.moduleResolution === ts.ModuleResolutionKind.Node16 ||
    options.moduleResolution === ts.ModuleResolutionKind.NodeNext ||
    options.module === ts.ModuleKind.Node16 ||
    options.module === ts.ModuleKind.NodeNext
    ? ts.getImpliedNodeFormatForFile(importer, undefined, host, options)
    : undefined;
}

export function cachedModuleResolutionHost(
  sourceFiles: ReadonlySet<string>,
): ts.ModuleResolutionHost {
  const directories = new Map<string, boolean>();
  const files = new Map<string, boolean>();
  const reads = new Map<string, string | undefined>();
  const realPaths = new Map<string, string>();
  return {
    directoryExists: (directory) =>
      cachedByFileKey(directories, directory, () => ts.sys.directoryExists?.(directory) ?? false),
    fileExists: (file) =>
      sourceFiles.has(normalizeFile(file)) ||
      cachedByFileKey(files, file, () => ts.sys.fileExists(file)),
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getDirectories: ts.sys.getDirectories,
    readFile: (file) => cachedFileRead(reads, file),
    realpath: (file) => cachedByFileKey(realPaths, file, () => ts.sys.realpath?.(file) ?? file),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}

function cachedByFileKey<Value>(
  cache: Map<string, Value>,
  file: string,
  compute: () => Value,
): Value {
  const key = normalizeFile(file);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const value = compute();
  cache.set(key, value);
  return value;
}

function cachedFileRead(cache: Map<string, string | undefined>, file: string): string | undefined {
  const key = normalizeFile(file);
  if (cache.has(key)) {
    return cache.get(key);
  }
  const value = ts.sys.readFile(file);
  cache.set(key, value);
  return value;
}

interface CompilerContextCaches {
  compilerContexts: Map<string, CompilerContext>;
  compilerContextsByImporter: Map<string, CompilerContext>;
  configFilesByDirectory: Map<string, string | null>;
}

function compilerContextFor(
  importer: string,
  fallbackRoot: string,
  caches: CompilerContextCaches,
): CompilerContext {
  const importerKey = normalizeFile(importer);
  const importerContext = caches.compilerContextsByImporter.get(importerKey);
  if (importerContext) {
    return importerContext;
  }
  const configFile = nearestConfigFile(path.dirname(importer), caches.configFilesByDirectory);
  const key = configFile ? normalizeFile(configFile) : normalizeFile(fallbackRoot);
  const context =
    caches.compilerContexts.get(key) ??
    createCompilerContext(configFile ? path.dirname(configFile) : fallbackRoot);
  caches.compilerContexts.set(key, context);
  caches.compilerContextsByImporter.set(importerKey, context);
  return context;
}

function createCompilerContext(base: string): CompilerContext {
  const options = compilerOptionsFor(base);
  return {
    cache: ts.createModuleResolutionCache(
      base,
      (file) => (ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase()),
      options,
    ),
    options,
  };
}

function nearestConfigFile(
  startDirectory: string,
  cache: Map<string, string | null>,
): string | null {
  const directory = normalizeFile(startDirectory);
  if (cache.has(directory)) {
    return cache.get(directory) ?? null;
  }
  const candidate = path.join(directory, "tsconfig.json");
  const configFile = ts.sys.fileExists(candidate)
    ? candidate
    : parentDirectoryConfigFile(directory, cache);
  cache.set(directory, configFile);
  return configFile;
}

function parentDirectoryConfigFile(
  directory: string,
  cache: Map<string, string | null>,
): string | null {
  const parent = path.dirname(directory);
  return parent === directory ? null : nearestConfigFile(parent, cache);
}

function compilerOptionsFor(root: string): ts.CompilerOptions {
  const configFile = ts.findConfigFile(root, ts.sys.fileExists);
  if (!configFile) {
    return { jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler };
  }
  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  if (read.error) {
    return { jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler };
  }
  // This index uses compiler options, never the tsconfig's expanded input file list.
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    { ...ts.sys, readDirectory: () => [] },
    path.dirname(configFile),
  );
  const { options } = parsed;
  const missingBaseConfig = parsed.errors.some(
    (diagnostic) => diagnostic.code === MISSING_BASE_CONFIG_DIAGNOSTIC_CODE,
  );
  return options.moduleResolution === undefined && missingBaseConfig
    ? { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler }
    : options;
}

export function normalizeFile(file: string): string {
  return pathIdentityKey(file);
}
