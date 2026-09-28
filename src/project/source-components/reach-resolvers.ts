import type { ImportedCallee, ReachResolver } from "./synchronous-reach.js";
import type { ResolvedSymbol, SourceIndexState } from "./model.js";
import { normalizeFile, resolveModule } from "./module-resolution.js";
import type { LexicalBinding } from "../../core/lexical-bindings.js";
import { moduleBinding } from "../../core/lexical-bindings.js";
import { moduleRecord } from "./module-record.js";
import { observablePathsFor } from "./observable-containers.js";
import ts from "typescript";

const MAX_EXPORT_DEPTH = 8;
const EXTERNAL: ImportedCallee = { kind: "external" };
const UNKNOWN: ImportedCallee = { kind: "unknown" };

/**
 * One file seen alone: a relative import is project code out of view, and a package import is
 * external code.
 */
export const localReachResolver: ReachResolver = {
  importedCallee: (_sourceFile, binding) => outsideProject(binding.moduleSpecifier),
  isObservablePath: (sourceFile, [root, member]) => {
    const record = moduleRecord(sourceFile);
    return (
      root !== undefined &&
      (record.observableDeclarations.has(root) ||
        (member !== undefined &&
          record.observableMemberDeclarations.get(root)?.has(member) === true))
    );
  },
};

/** The whole project: imports resolve to the exported function bodies they name. */
export function projectReachResolver(
  state: SourceIndexState,
  visibleObservables: (
    state: SourceIndexState,
    file: string,
  ) => ReadonlyMap<string, ResolvedSymbol>,
): ReachResolver {
  const observablePaths = new Map<string, ReadonlySet<string>>();
  const pathsFor = (file: string): ReadonlySet<string> => {
    const cached = observablePaths.get(file);
    if (cached) {
      return cached;
    }
    const paths = new Set([
      ...visibleObservables(state, file).keys(),
      ...observablePathsFor(state, file),
    ]);
    observablePaths.set(file, paths);
    return paths;
  };
  const callees = new Map<string, ImportedCallee>();
  return {
    importedCallee: (sourceFile, binding) => {
      const importer = { depth: 0, file: normalizeFile(sourceFile.fileName) };
      const key = `${importer.file}\0${binding.moduleSpecifier}\0${binding.importedName}`;
      const callee = callees.get(key) ?? importedFunction(state, importer, binding);
      callees.set(key, callee);
      return callee;
    },
    isObservablePath: (sourceFile, [root, member]) => {
      const paths = pathsFor(normalizeFile(sourceFile.fileName));
      return (
        root !== undefined &&
        (paths.has(root) || (member !== undefined && paths.has(`${root}.${member}`)))
      );
    },
  };
}

/** A name exported from a project file, reached through `depth` re-export or import hops. */
interface ExportLookup {
  readonly depth: number;
  readonly exportName: string;
  readonly file: string;
}

interface ImportedName {
  readonly importedName: string;
  readonly moduleSpecifier: string;
}

/** A module that is not a project source file is a package, unless a relative path names it. */
function outsideProject(moduleSpecifier: string): ImportedCallee {
  return moduleSpecifier.startsWith(".") ? UNKNOWN : EXTERNAL;
}

function importedFunction(
  state: SourceIndexState,
  importer: Pick<ExportLookup, "depth" | "file">,
  imported: ImportedName,
): ImportedCallee {
  const file = resolveModule(state, importer.file, imported.moduleSpecifier);
  return file
    ? exportedFunction(state, {
        depth: importer.depth + 1,
        exportName: imported.importedName,
        file,
      })
    : outsideProject(imported.moduleSpecifier);
}

function exportedFunction(state: SourceIndexState, lookup: ExportLookup): ImportedCallee {
  const sourceFile = state.sourceFiles.get(lookup.file);
  if (!sourceFile || lookup.depth > MAX_EXPORT_DEPTH || lookup.exportName === "*") {
    return UNKNOWN;
  }
  const localName =
    state.records.get(lookup.file)?.localExports.get(lookup.exportName) ??
    exportedDeclarationName(sourceFile, lookup.exportName);
  return localName === undefined
    ? reexportedFunction(state, lookup)
    : boundFunction(state, lookup, moduleBinding(sourceFile, localName));
}

function boundFunction(
  state: SourceIndexState,
  lookup: ExportLookup,
  binding: LexicalBinding | null,
): ImportedCallee {
  if (binding?.kind === "import") {
    return importedFunction(state, lookup, binding);
  }
  if (binding?.kind === "function") {
    return binding;
  }
  return binding?.kind === "ambient" ? EXTERNAL : UNKNOWN;
}

function reexportedFunction(state: SourceIndexState, lookup: ExportLookup): ImportedCallee {
  const record = state.records.get(lookup.file);
  const reexport = record?.reexports.get(lookup.exportName);
  if (reexport) {
    return importedFunction(state, lookup, reexport);
  }
  for (const moduleSpecifier of record?.starExports ?? []) {
    const found = importedFunction(state, lookup, {
      importedName: lookup.exportName,
      moduleSpecifier,
    });
    if (found.kind === "function") {
      return found;
    }
  }
  return UNKNOWN;
}

/** Module records keep only the exports other rules consume, so plain functions are read here. */
function exportedDeclarationName(
  sourceFile: ts.SourceFile,
  exportName: string,
): string | undefined {
  for (const statement of sourceFile.statements) {
    const localName = exportedLocalName(statement, exportName);
    if (localName !== undefined) {
      return localName;
    }
  }
  return undefined;
}

function exportedLocalName(statement: ts.Statement, exportName: string): string | undefined {
  if (ts.isExportAssignment(statement)) {
    return exportName === "default" && ts.isIdentifier(statement.expression)
      ? statement.expression.text
      : undefined;
  }
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return undefined;
  }
  if (ts.isFunctionDeclaration(statement)) {
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    const name = statement.name?.text;
    return name !== undefined && (isDefault ? "default" : name) === exportName ? name : undefined;
  }
  return ts.isVariableStatement(statement) && declaresName(statement, exportName)
    ? exportName
    : undefined;
}

function declaresName(statement: ts.VariableStatement, name: string): boolean {
  return statement.declarationList.declarations.some(
    (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
  );
}
