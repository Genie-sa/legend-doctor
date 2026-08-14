import path from "node:path";

import ts from "typescript";

import { scriptKindForFile } from "./ast.js";

interface ImportBinding {
  importedName: string;
  moduleSpecifier: string;
}

interface ReexportBinding {
  importedName: string;
  moduleSpecifier: string;
}

type ComponentFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

interface ModuleRecord {
  componentDeclarations: ReadonlyMap<string, ComponentFunction>;
  imports: ReadonlyMap<string, ImportBinding>;
  localExports: ReadonlyMap<string, string>;
  reexports: ReadonlyMap<string, ReexportBinding>;
  starExports: readonly string[];
}

export interface SourceComponentIndex {
  componentsFor(file: string): ReadonlySet<string>;
}

interface ResolvedComponent {
  file: string;
  localName: string;
}

export function buildSourceComponentIndex(
  root: string,
  sources: ReadonlyMap<string, string>
): SourceComponentIndex {
  const records = new Map<string, ModuleRecord>();
  for (const [file, source] of sources) {
    records.set(normalizeFile(file), moduleRecord(source, file));
  }

  const compilerContexts = new Map<string, CompilerContext>();
  const resolvedByImporter = new Map<string, ReadonlyMap<string, ResolvedComponent>>();

  function resolveModule(importer: string, specifier: string): string | null {
    const { cache, options } = compilerContextFor(importer, root, compilerContexts);
    const resolution = ts.resolveModuleName(
      specifier,
      importer,
      options,
      ts.sys,
      cache
    ).resolvedModule;
    if (!resolution || resolution.isExternalLibraryImport) return null;
    const resolved = normalizeFile(resolution.resolvedFileName.replace(/\.d\.(?:ts|mts|cts)$/, ".ts"));
    return records.has(resolved) ? resolved : null;
  }

  function exportedComponent(
    file: string,
    exportName: string,
    visited: ReadonlySet<string>,
    depth: number
  ): ResolvedComponent | null {
    if (depth > 8) return null;
    const key = `${file}\0${exportName}`;
    if (visited.has(key)) return null;
    const record = records.get(file);
    if (!record) return null;
    const nextVisited = new Set(visited).add(key);

    const localName = record.localExports.get(exportName);
    if (localName && record.componentDeclarations.has(localName)) return { file, localName };

    const reexport = record.reexports.get(exportName);
    if (reexport) {
      const target = resolveModule(file, reexport.moduleSpecifier);
      return target
        ? exportedComponent(target, reexport.importedName, nextVisited, depth + 1)
        : null;
    }

    const matches = record.starExports.flatMap(specifier => {
      const target = resolveModule(file, specifier);
      const component = target
        ? exportedComponent(target, exportName, nextVisited, depth + 1)
        : null;
      return component ? [component] : [];
    });
    const unique = new Map(matches.map(match => [`${match.file}\0${match.localName}`, match]));
    return unique.size === 1 ? unique.values().next().value ?? null : null;
  }

  function resolvedFor(file: string): ReadonlyMap<string, ResolvedComponent> {
    const importer = normalizeFile(file);
    const cached = resolvedByImporter.get(importer);
    if (cached) return cached;
    const components = new Map<string, ResolvedComponent>();
    const record = records.get(importer);
    if (record) {
      for (const [localName, binding] of record.imports) {
        if (!isSemanticComponentName(localName)) continue;
        const target = resolveModule(importer, binding.moduleSpecifier);
        const component = target
          ? exportedComponent(target, binding.importedName, new Set(), 0)
          : null;
        if (component) components.set(localName, component);
      }
    }
    resolvedByImporter.set(importer, components);
    return components;
  }

  return { componentsFor: file => new Set(resolvedFor(file).keys()) };
}

interface CompilerContext {
  cache: ts.ModuleResolutionCache;
  options: ts.CompilerOptions;
}

function compilerContextFor(
  importer: string,
  fallbackRoot: string,
  contexts: Map<string, CompilerContext>
): CompilerContext {
  const configFile = ts.findConfigFile(path.dirname(importer), ts.sys.fileExists);
  const key = configFile ? normalizeFile(configFile) : normalizeFile(fallbackRoot);
  const cached = contexts.get(key);
  if (cached) return cached;
  const base = configFile ? path.dirname(configFile) : fallbackRoot;
  const options = compilerOptionsFor(base);
  const context = {
    cache: ts.createModuleResolutionCache(
      base,
      file => (ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase()),
      options
    ),
    options,
  };
  contexts.set(key, context);
  return context;
}

function moduleRecord(sourceText: string, fileName: string): ModuleRecord {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName)
  );
  const componentDeclarations = new Map<string, ComponentFunction>();
  const imports = new Map<string, ImportBinding>();
  const localExports = new Map<string, string>();
  const reexports = new Map<string, ReexportBinding>();
  const starExports: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name && isSemanticComponentName(statement.name.text)) {
        componentDeclarations.set(statement.name.text, statement);
        if (hasExport(statement)) localExports.set(statement.name.text, statement.name.text);
        if (hasDefault(statement)) localExports.set("default", statement.name.text);
      } else if (!statement.name && hasExport(statement) && hasDefault(statement)) {
        componentDeclarations.set("default", statement);
        localExports.set("default", "default");
      }
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      if (statement.name && isSemanticComponentName(statement.name.text)) {
        if (hasExport(statement)) localExports.set(statement.name.text, statement.name.text);
        if (hasDefault(statement)) localExports.set("default", statement.name.text);
      } else if (!statement.name && hasExport(statement) && hasDefault(statement)) {
        localExports.set("default", "default");
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          isSemanticComponentName(declaration.name.text) &&
          declaration.initializer &&
          isComponentInitializer(declaration.initializer)
        ) {
          const component = componentFunction(declaration.initializer);
          if (!component) continue;
          componentDeclarations.set(declaration.name.text, component);
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
      }
      continue;
    }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) {
        imports.set(clause.name.text, {
          importedName: "default",
          moduleSpecifier: statement.moduleSpecifier.text,
        });
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          imports.set(element.name.text, {
            importedName: element.propertyName?.text ?? element.name.text,
            moduleSpecifier: statement.moduleSpecifier.text,
          });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        if (!statement.exportClause) {
          starExports.push(specifier.text);
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            reexports.set(element.name.text, {
              importedName: element.propertyName?.text ?? element.name.text,
              moduleSpecifier: specifier.text,
            });
          }
        }
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          localExports.set(element.name.text, element.propertyName?.text ?? element.name.text);
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      localExports.set("default", statement.expression.text);
    }
  }

  return { componentDeclarations, imports, localExports, reexports, starExports };
}

function compilerOptionsFor(root: string): ts.CompilerOptions {
  const configFile = ts.findConfigFile(root, ts.sys.fileExists);
  if (!configFile) {
    return { jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler };
  }
  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  if (read.error) return { jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler };
  return ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configFile)).options;
}

function isSemanticComponentName(name: string): boolean {
  const first = name[0];
  return first !== undefined && first === first.toUpperCase();
}

function isComponentInitializer(node: ts.Expression): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) return true;
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "memo" || node.expression.text === "forwardRef") &&
    node.arguments.length === 1 &&
    !!node.arguments[0] &&
    (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
  );
}

function componentFunction(node: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | null {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "memo" || node.expression.text === "forwardRef") &&
    node.arguments.length === 1
  ) {
    const argument = node.arguments[0];
    return argument && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) ? argument : null;
  }
  return null;
}

function hasExport(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefault(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function normalizeFile(file: string): string {
  return path.normalize(path.resolve(file));
}
