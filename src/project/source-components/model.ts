import type { ReactComponentWrappers } from "../../core/react-component-wrappers.js";
import type ts from "typescript";

export interface ImportBinding {
  importedName: string;
  moduleSpecifier: string;
}

interface ReexportBinding {
  importedName: string;
  moduleSpecifier: string;
}

export interface IndexedImportBinding extends ImportBinding {
  file: string;
  localName: string;
}

export interface IndexedReexportBinding extends ReexportBinding {
  exportName: string;
  file: string;
}

export type ComponentFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

export interface ModuleRecord {
  componentDeclarations: ReadonlyMap<string, ComponentFunction>;
  contextReaderHooks: ReadonlyMap<string, string>;
  deferredCallbackOwners: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  frameworkEventComponents: ReadonlySet<string>;
  hookDeclarations: ReadonlyMap<string, ComponentFunction>;
  imports: ReadonlyMap<string, ImportBinding>;
  legendValueHooks: ReadonlyMap<string, string>;
  legendValueWriters: ReadonlyMap<string, string>;
  localExports: ReadonlyMap<string, string>;
  /** Per observable or `container.member$` declaration, the dotted paths whose initial value is an array literal. */
  observableArrayPaths: ReadonlyMap<string, ReadonlySet<string>>;
  observableDeclarations: ReadonlySet<string>;
  observableKeys: ReadonlyMap<string, ReadonlySet<string>>;
  observableMemberDeclarations: ReadonlyMap<string, ReadonlySet<string>>;
  observableFactoryCalls: ReadonlyMap<string, string>;
  observableFactoryDeclarations: ReadonlySet<string>;
  pureProjectionDeclarations: ReadonlySet<string>;
  reactContexts: ReadonlySet<string>;
  reexports: ReadonlyMap<string, ReexportBinding>;
  shadowedImports: ReadonlySet<string>;
  starExports: readonly string[];
}

export interface ResolvedSymbol {
  file: string;
  localName: string;
}

export type SourceSymbolKind =
  | "component"
  | "context-reader-hook"
  | "deferred-callback-owner"
  | "deferred-callback-hook"
  | "framework-event-component"
  | "hook"
  | "legend-value-hook"
  | "legend-value-writer"
  | "observable"
  | "observable-container"
  | "observable-factory"
  | "pure-projection"
  | "react-context";

export interface StarExporter {
  file: string;
  moduleSpecifier: string;
}

export interface CrossModuleBindings {
  importsByName: ReadonlyMap<string, readonly IndexedImportBinding[]>;
  reexportsByName: ReadonlyMap<string, readonly IndexedReexportBinding[]>;
  starExporters: readonly StarExporter[];
}

export interface SourceIndexState extends CrossModuleBindings {
  availableSymbolKinds: ReadonlySet<SourceSymbolKind>;
  aliasesBySymbol: Map<string, ReadonlyMap<string, ReadonlySet<string>>>;
  compilerContexts: Map<string, CompilerContext>;
  compilerContextsByImporter: Map<string, CompilerContext>;
  configFilesByDirectory: Map<string, string | null>;
  contextReaders: Map<string, ReadonlyMap<string, ReadonlySet<string>>>;
  contextReadersBySymbol: Map<string, ReadonlyMap<string, ReadonlySet<string>>>;
  moduleResolutionHost: ts.ModuleResolutionHost;
  records: ReadonlyMap<string, ModuleRecord>;
  resolvedByKind: Map<SourceSymbolKind, Map<string, ReadonlyMap<string, ResolvedSymbol>>>;
  resolvedHooks: Map<string, ResolvedSymbol | null>;
  resolvedModules: Map<string, string | null>;
  root: string;
  sourceFiles: ReadonlyMap<string, ts.SourceFile>;
  stableObservableContainers: Map<string, boolean>;
}

export interface SymbolTrace {
  depth: number;
  visited: ReadonlySet<string>;
}

export interface SymbolTarget {
  exportName: string;
  file: string;
  kind: SourceSymbolKind;
}

export interface LocalSymbolLookup {
  localName: string;
  trace: SymbolTrace;
}

export interface CompilerContext {
  cache: ts.ModuleResolutionCache;
  options: ts.CompilerOptions;
}

export interface StyledComponentCandidate {
  exported: boolean;
  factory: string;
  name: string;
  targetRoot: string;
}

export interface ModuleRecordDraft {
  componentDeclarations: Map<string, ComponentFunction>;
  contextReaderHooks: Map<string, string>;
  deferredCallbackHooks: Map<string, ReadonlySet<number>>;
  deferredCallbackOwners: Map<string, ReadonlyMap<string, ReadonlySet<number>>>;
  frameworkEventComponents: Set<string>;
  hookDeclarations: Map<string, ComponentFunction>;
  imports: Map<string, ImportBinding>;
  legendValueHooks: Map<string, string>;
  legendValueWriters: Map<string, string>;
  localExports: Map<string, string>;
  observableArrayPaths: Map<string, ReadonlySet<string>>;
  observableDeclarations: Set<string>;
  observableFactoryCalls: Map<string, string>;
  observableFactoryDeclarations: Set<string>;
  observableKeys: Map<string, ReadonlySet<string>>;
  observableMemberDeclarations: Map<string, ReadonlySet<string>>;
  pureProjectionDeclarations: Set<string>;
  reactContexts: Set<string>;
  reexports: Map<string, ReexportBinding>;
  shadowedImports: Set<string>;
  starExports: string[];
  styledComponentCandidates: StyledComponentCandidate[];
}

export interface ModuleImportSignals {
  legendNamespaces: Set<string>;
  legendSyncNamespaces: Set<string>;
  nativeComponentFactories: Set<string>;
  observableFactories: Set<string>;
  observableTypes: Set<string>;
  reactContextFactories: Set<string>;
  reactContextReaders: Set<string>;
  reactEffectHooks: Set<string>;
  reactNamespaces: Set<string>;
  styledFactories: Set<string>;
  synced: Set<string>;
  useValueHooks: Set<string>;
}

export interface ModuleSignals extends ModuleImportSignals {
  componentWrappers: ReactComponentWrappers;
  deferredMethodsByClass: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  observableMemberFactories: ReadonlyMap<string, ReadonlySet<string>>;
  sourceFile: ts.SourceFile;
}

export interface DeclarationContext {
  declaration: ts.VariableDeclaration;
  exported: boolean;
  initializer: ts.Expression | null;
  isConst: boolean;
  name: string | null;
}

export interface FunctionTraits {
  deferredParameters: ReadonlySet<number>;
  hookObservable: string | null;
  name: string;
  pureProjection: boolean;
  readContext: string | null;
  writerObservable: string | null;
}
