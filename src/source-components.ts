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
  observableDeclarations: ReadonlySet<string>;
  observableFactoryCalls: ReadonlyMap<string, string>;
  observableFactoryDeclarations: ReadonlySet<string>;
  reexports: ReadonlyMap<string, ReexportBinding>;
  starExports: readonly string[];
}

export interface SourceIndex {
  componentsFor(file: string): ReadonlySet<string>;
  observablesFor(file: string): ReadonlySet<string>;
}

interface ResolvedSymbol {
  file: string;
  localName: string;
}

type SourceSymbolKind = "component" | "observable" | "observable-factory";

export function buildSourceIndex(
  root: string,
  sources: ReadonlyMap<string, string>
): SourceIndex {
  const records = new Map<string, ModuleRecord>();
  for (const [file, source] of sources) {
    records.set(normalizeFile(file), moduleRecord(source, file));
  }

  const compilerContexts = new Map<string, CompilerContext>();
  const componentsByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const observablesByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();

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

  function exportedSymbol(
    file: string,
    exportName: string,
    kind: SourceSymbolKind,
    visited: ReadonlySet<string>,
    depth: number
  ): ResolvedSymbol | null {
    if (depth > 8) return null;
    const key = `${kind}\0${file}\0${exportName}`;
    if (visited.has(key)) return null;
    const record = records.get(file);
    if (!record) return null;
    const nextVisited = new Set(visited).add(key);

    const localName = record.localExports.get(exportName);
    if (localName) {
      const declared = kind === "component"
        ? record.componentDeclarations.has(localName)
        : kind === "observable"
          ? record.observableDeclarations.has(localName)
          : record.observableFactoryDeclarations.has(localName);
      if (declared) return { file, localName };

      const factoryName = kind === "observable"
        ? record.observableFactoryCalls.get(localName)
        : undefined;
      if (factoryName) {
        if (record.observableFactoryDeclarations.has(factoryName)) return { file, localName };
        const factoryImport = record.imports.get(factoryName);
        const target = factoryImport
          ? resolveModule(file, factoryImport.moduleSpecifier)
          : null;
        if (
          factoryImport &&
          target &&
          exportedSymbol(
            target,
            factoryImport.importedName,
            "observable-factory",
            nextVisited,
            depth + 1
          )
        ) {
          return { file, localName };
        }
      }
    }

    const reexport = record.reexports.get(exportName);
    if (reexport) {
      const target = resolveModule(file, reexport.moduleSpecifier);
      return target
        ? exportedSymbol(target, reexport.importedName, kind, nextVisited, depth + 1)
        : null;
    }

    const matches = record.starExports.flatMap(specifier => {
      const target = resolveModule(file, specifier);
      const component = target
        ? exportedSymbol(target, exportName, kind, nextVisited, depth + 1)
        : null;
      return component ? [component] : [];
    });
    const unique = new Map(matches.map(match => [`${match.file}\0${match.localName}`, match]));
    return unique.size === 1 ? unique.values().next().value ?? null : null;
  }

  function resolvedFor(file: string, kind: SourceSymbolKind): ReadonlyMap<string, ResolvedSymbol> {
    const importer = normalizeFile(file);
    const cache = kind === "component" ? componentsByImporter : observablesByImporter;
    const cached = cache.get(importer);
    if (cached) return cached;
    const symbols = new Map<string, ResolvedSymbol>();
    const record = records.get(importer);
    if (record) {
      for (const [localName, binding] of record.imports) {
        if (kind === "component" && !isSemanticComponentName(localName)) continue;
        const target = resolveModule(importer, binding.moduleSpecifier);
        const symbol = target
          ? exportedSymbol(target, binding.importedName, kind, new Set(), 0)
          : null;
        if (symbol) symbols.set(localName, symbol);
      }
    }
    cache.set(importer, symbols);
    return symbols;
  }

  return {
    componentsFor: file => new Set(resolvedFor(file, "component").keys()),
    observablesFor: file => new Set(resolvedFor(file, "observable").keys()),
  };
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
  const observableDeclarations = new Set<string>();
  const observableFactoryCalls = new Map<string, string>();
  const observableFactoryDeclarations = new Set<string>();
  const reexports = new Map<string, ReexportBinding>();
  const starExports: string[] = [];
  const observableFactories = new Set<string>();
  const observableTypes = new Set<string>();
  const legendNamespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@legendapp/state"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      legendNamespaces.add(bindings.name.text);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "observable") {
          observableFactories.add(element.name.text);
        }
        if (importedName === "Observable") {
          observableTypes.add(element.name.text);
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (
        statement.name &&
        statement.type &&
        isObservableTypeReference(statement.type, observableTypes)
      ) {
        observableFactoryDeclarations.add(statement.name.text);
        if (hasExport(statement)) localExports.set(statement.name.text, statement.name.text);
      }
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
        const initializer = declaration.initializer
          ? unwrapTransparentExpression(declaration.initializer)
          : null;
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression)
        ) {
          observableFactoryCalls.set(declaration.name.text, initializer.expression.text);
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          isObservableInitializer(declaration.initializer, observableFactories, legendNamespaces)
        ) {
          observableDeclarations.add(declaration.name.text);
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
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

  return {
    componentDeclarations,
    imports,
    localExports,
    observableDeclarations,
    observableFactoryCalls,
    observableFactoryDeclarations,
    reexports,
    starExports,
  };
}

function isObservableTypeReference(
  type: ts.TypeNode,
  observableTypes: ReadonlySet<string>
): boolean {
  return ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    observableTypes.has(type.typeName.text);
}

function isObservableInitializer(
  expression: ts.Expression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) return false;
  if (ts.isIdentifier(value.expression)) return factories.has(value.expression.text);
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    namespaces.has(value.expression.expression.text) &&
    value.expression.name.text === "observable"
  );
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
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
