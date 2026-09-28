import { identifiersNamed, scriptKindForFile, visit } from "../core/ast.js";
import { collectSourceFiles } from "./analyze-path/analysis-context.js";
import { isDeclarationName } from "../core/analysis-ast.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const CLIENT_MODULE = "react-dom/client";
/** Entry points that export React 18's legacy `render` and `hydrate` beside the client root APIs. */
const LEGACY_CAPABLE_MODULES: ReadonlySet<string> = new Set(["react-dom", "react-dom/profiling"]);
const CLIENT_ROOT_APIS: ReadonlySet<string> = new Set(["createRoot", "hydrateRoot"]);
/** Every React DOM export that creates a root, legacy or concurrent. */
const ROOT_APIS: ReadonlySet<string> = new Set([
  ...CLIENT_ROOT_APIS,
  "hydrate",
  "render",
  "unstable_renderSubtreeIntoContainer",
]);
/** The UMD build's global, which scripts can call without importing anything. */
const UMD_GLOBAL = "ReactDOM";
const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

/** How the source files under one directory create React DOM roots. */
export interface DomRootInventory {
  /** Files that call `createRoot` or `hydrateRoot` imported from `react-dom/client`. */
  readonly clientRootFiles: readonly string[];
  /**
   * A file may create a root another way: a legacy root API, a root API from `react-dom` itself, or a
   * `react-dom` binding used in a way the scan cannot follow.
   */
  readonly otherRootCreation: boolean;
}

interface FileRootCreation {
  readonly clientRoots: boolean;
  readonly otherRootCreation: boolean;
}

interface RootModuleBindings {
  /** Local names of `createRoot` and `hydrateRoot` imported from `react-dom/client` that nothing redeclares. */
  readonly clientFunctions: ReadonlySet<string>;
  /** Default and namespace imports of `react-dom/client` that nothing redeclares. */
  readonly clientNamespaces: ReadonlySet<string>;
  /** Default and namespace imports of an entry point that also exports legacy root APIs. */
  readonly legacyNamespaces: ReadonlySet<string>;
  /** An import or re-export already exposes a root API other than the client ones. */
  readonly exposesOtherRootApi: boolean;
}

interface ValueImport {
  readonly clause: ts.ImportClause;
  readonly module: string;
}

/** Scans every analyzable source file under `directory`, skipping the same build and dependency folders as analysis. */
export async function domRootInventory(directory: string): Promise<DomRootInventory> {
  const files = await collectSourceFiles(directory);
  const creations = await Promise.all(
    files
      .filter((file) => !DECLARATION_FILE.test(file))
      .map(async (file) => ({ creation: await fileRootCreation(file), file })),
  );
  return {
    clientRootFiles: creations
      .filter(({ creation }) => creation.clientRoots)
      .map(({ file }) => file),
    otherRootCreation: creations.some(({ creation }) => creation.otherRootCreation),
  };
}

async function fileRootCreation(file: string): Promise<FileRootCreation> {
  const text = await readFile(file, "utf8");
  if (!text.includes("react-dom") && !text.includes(UMD_GLOBAL)) {
    return { clientRoots: false, otherRootCreation: false };
  }
  const sourceFile = ts.createSourceFile(
    path.basename(file),
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(file),
  );
  return sourceRootCreation(sourceFile);
}

function sourceRootCreation(sourceFile: ts.SourceFile): FileRootCreation {
  const bindings = rootModuleBindings(sourceFile);
  let clientRoots = false;
  let otherRootCreation = bindings.exposesOtherRootApi;
  visit(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      clientRoots ||= isClientRootCall(node, bindings);
      otherRootCreation ||= isDynamicLegacyModuleLoad(node);
    } else if (ts.isIdentifier(node)) {
      otherRootCreation ||= isUnfollowedRootReference(node, bindings);
    }
  });
  return { clientRoots, otherRootCreation };
}

function rootModuleBindings(sourceFile: ts.SourceFile): RootModuleBindings {
  const imports = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .flatMap((declaration) => valueImport(declaration));
  const client = imports.filter(({ module }) => module === CLIENT_MODULE);
  const legacy = imports.filter(({ module }) => LEGACY_CAPABLE_MODULES.has(module));
  return {
    clientFunctions: new Set(
      client
        .flatMap(({ clause }) =>
          valueSpecifiers(clause)
            .filter((specifier) => CLIENT_ROOT_APIS.has(importedName(specifier)))
            .map((specifier) => specifier.name.text),
        )
        .filter((name) => isBoundOnlyByImport(sourceFile, name)),
    ),
    clientNamespaces: new Set(
      client
        .flatMap(({ clause }) => namespaceBindings(clause))
        .filter((name) => isBoundOnlyByImport(sourceFile, name)),
    ),
    exposesOtherRootApi:
      legacy.some(({ clause }) =>
        valueSpecifiers(clause).some((specifier) => ROOT_APIS.has(importedName(specifier))),
      ) || sourceFile.statements.some(exposesLegacyModule),
    legacyNamespaces: new Set(legacy.flatMap(({ clause }) => namespaceBindings(clause))),
  };
}

function isBoundOnlyByImport(sourceFile: ts.SourceFile, name: string): boolean {
  return identifiersNamed(sourceFile, name).every((identifier) => !isDeclarationName(identifier));
}

function valueImport(declaration: ts.ImportDeclaration): ValueImport[] {
  const module = moduleName(declaration.moduleSpecifier);
  const clause = declaration.importClause;
  return clause && !clause.isTypeOnly && module !== null ? [{ clause, module }] : [];
}

function moduleName(specifier: ts.Expression): string | null {
  return ts.isStringLiteral(specifier) ? specifier.text : null;
}

function isLegacyCapableModule(specifier: ts.Expression): boolean {
  const module = moduleName(specifier);
  return module !== null && LEGACY_CAPABLE_MODULES.has(module);
}

function namespaceBindings(clause: ts.ImportClause): string[] {
  const namespace =
    clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)
      ? clause.namedBindings.name
      : undefined;
  return [clause.name, namespace].flatMap((binding) => (binding ? [binding.text] : []));
}

/** `import x = require("react-dom")` and re-exports of its root APIs reach them outside this file's imports. */
function exposesLegacyModule(statement: ts.Statement): boolean {
  if (ts.isExportDeclaration(statement)) {
    return reexportsLegacyRootApi(statement);
  }
  return (
    ts.isImportEqualsDeclaration(statement) &&
    ts.isExternalModuleReference(statement.moduleReference) &&
    isLegacyCapableModule(statement.moduleReference.expression)
  );
}

function valueSpecifiers(clause: ts.ImportClause): readonly ts.ImportSpecifier[] {
  const bindings = clause.namedBindings;
  return bindings && ts.isNamedImports(bindings)
    ? bindings.elements.filter((element) => !element.isTypeOnly)
    : [];
}

function importedName(specifier: ts.ImportSpecifier | ts.ExportSpecifier): string {
  return (specifier.propertyName ?? specifier.name).text;
}

/** `export * from "react-dom"` and namespace re-exports hand every root API to other modules. */
function reexportsLegacyRootApi(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly || !statement.moduleSpecifier) {
    return false;
  }
  if (!isLegacyCapableModule(statement.moduleSpecifier)) {
    return false;
  }
  const clause = statement.exportClause;
  return (
    !clause ||
    ts.isNamespaceExport(clause) ||
    clause.elements.some((element) => !element.isTypeOnly && ROOT_APIS.has(importedName(element)))
  );
}

function isClientRootCall(call: ts.CallExpression, bindings: RootModuleBindings): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return bindings.clientFunctions.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    bindings.clientNamespaces.has(callee.expression.text) &&
    CLIENT_ROOT_APIS.has(callee.name.text)
  );
}

/** `require("react-dom")` and `import("react-dom")` return the whole module, legacy APIs included. */
function isDynamicLegacyModuleLoad(call: ts.CallExpression): boolean {
  const [specifier] = call.arguments;
  const loads =
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(call.expression) && call.expression.text === "require");
  return loads && specifier !== undefined && isLegacyCapableModule(specifier);
}

/**
 * A reference to a legacy-capable namespace is followed only as `ns.member` or the type `ns.Member`
 * naming a non-root export; any other use can reach `render`. A bare `ReactDOM` the file does not
 * import is the UMD global and is followed the same way.
 */
function isUnfollowedRootReference(
  identifier: ts.Identifier,
  bindings: RootModuleBindings,
): boolean {
  const name = identifier.text;
  const legacy = bindings.legacyNamespaces.has(name);
  if (!legacy && (name !== UMD_GLOBAL || bindings.clientNamespaces.has(name))) {
    return false;
  }
  if (isImportBindingName(identifier)) {
    return false;
  }
  const member = namespaceMember(identifier);
  if (member === null) {
    return legacy;
  }
  return ROOT_APIS.has(member);
}

function isImportBindingName(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return (
    (ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportSpecifier(parent)) &&
    parent.name === identifier
  );
}

function namespaceMember(identifier: ts.Identifier): string | null {
  const { parent } = identifier;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier) {
    return parent.name.text;
  }
  return ts.isQualifiedName(parent) && parent.left === identifier ? parent.right.text : null;
}
