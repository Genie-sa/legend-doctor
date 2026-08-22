import path from "node:path";

import ts from "typescript";

import {
  bindingDeclarationCount,
  exactObjectLiteralKeys,
  isDeclarationName,
  isNonValueIdentifier,
} from "./analysis-ast.js";
import {
  AnalysisProject,
  isSupportedAnalysisFile,
  type AnalysisFile,
} from "./analysis-project.js";
import { nearestNestedFunction, nodeWithin, visit } from "./ast.js";
import { pathIdentityKey } from "./path-identity.js";

interface ImportBinding {
  importedName: string;
  moduleSpecifier: string;
}

interface ReexportBinding {
  importedName: string;
  moduleSpecifier: string;
}

type ComponentFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

const REACT_EFFECT_HOOKS = new Set(["useEffect", "useInsertionEffect", "useLayoutEffect"]);

interface ModuleRecord {
  componentDeclarations: ReadonlyMap<string, ComponentFunction>;
  deferredCallbackOwners: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  hookDeclarations: ReadonlyMap<string, ComponentFunction>;
  imports: ReadonlyMap<string, ImportBinding>;
  legendValueHooks: ReadonlyMap<string, string>;
  legendValueWriters: ReadonlyMap<string, string>;
  localExports: ReadonlyMap<string, string>;
  observableDeclarations: ReadonlySet<string>;
  observableKeys: ReadonlyMap<string, ReadonlySet<string>>;
  observableFactoryCalls: ReadonlyMap<string, string>;
  observableFactoryDeclarations: ReadonlySet<string>;
  reexports: ReadonlyMap<string, ReexportBinding>;
  starExports: readonly string[];
}

export interface SourceIndex {
  componentDeclarationFor(file: string, name: string): ResolvedSymbol | null;
  componentsFor(file: string): ReadonlySet<string>;
  deferredCallbackRegistrationsFor(
    file: string
  ): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>>;
  deferredCallbackHooksFor(file: string): ReadonlyMap<string, ReadonlySet<number>>;
  hookDeclarationFor(file: string, name: string): ResolvedSymbol | null;
  legendValueBridgesFor(file: string): ReadonlyMap<string, ReadonlySet<string>>;
  observableFactoriesFor(file: string): ReadonlySet<string>;
  observableKeysFor(file: string): ReadonlyMap<string, ReadonlySet<string>>;
  observablesFor(file: string): ReadonlySet<string>;
}

export interface ResolvedSymbol {
  file: string;
  localName: string;
}

type SourceSymbolKind =
  | "component"
  | "deferred-callback-owner"
  | "deferred-callback-hook"
  | "hook"
  | "legend-value-hook"
  | "legend-value-writer"
  | "observable"
  | "observable-factory";

export function buildSourceIndex(
  root: string,
  sources: ReadonlyMap<string, string>
): SourceIndex {
  return buildSourceIndexFromFiles(
    root,
    new AnalysisProject(
      new Map([...sources].filter(([fileName]) => isSupportedAnalysisFile(fileName)))
    ).files
  );
}

export function buildSourceIndexFromFiles(
  root: string,
  files: readonly AnalysisFile[]
): SourceIndex {
  const records = new Map<string, ModuleRecord>();
  for (const file of files) {
    records.set(normalizeFile(file.identityPath), moduleRecord(file.sourceFile));
  }

  const compilerContexts = new Map<string, CompilerContext>();
  const componentsByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const deferredCallbackOwnersByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const deferredCallbackHooksByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const hooksByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const legendValueHooksByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const legendValueWritersByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
  const observableFactoriesByImporter = new Map<string, ReadonlyMap<string, ResolvedSymbol>>();
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
        : kind === "deferred-callback-owner"
          ? record.deferredCallbackOwners.has(localName)
          : kind === "deferred-callback-hook"
            ? record.deferredCallbackHooks.has(localName)
            : kind === "hook"
              ? record.hookDeclarations.has(localName)
          : kind === "legend-value-hook"
            ? record.legendValueHooks.has(localName)
            : kind === "legend-value-writer"
              ? record.legendValueWriters.has(localName)
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
    const cache = kind === "component"
      ? componentsByImporter
      : kind === "deferred-callback-owner"
        ? deferredCallbackOwnersByImporter
        : kind === "deferred-callback-hook"
          ? deferredCallbackHooksByImporter
          : kind === "hook"
            ? hooksByImporter
        : kind === "legend-value-hook"
          ? legendValueHooksByImporter
          : kind === "legend-value-writer"
            ? legendValueWritersByImporter
            : kind === "observable-factory"
              ? observableFactoriesByImporter
              : observablesByImporter;
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
    componentDeclarationFor: (file, name) => resolvedFor(file, "component").get(name) ?? null,
    componentsFor: file => new Set(resolvedFor(file, "component").keys()),
    deferredCallbackRegistrationsFor: file => {
      const registrations = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
      for (const [localName, symbol] of resolvedFor(file, "deferred-callback-owner")) {
        const methods = records.get(symbol.file)?.deferredCallbackOwners.get(symbol.localName);
        if (methods) registrations.set(localName, methods);
      }
      return registrations;
    },
    deferredCallbackHooksFor: file => {
      const hooks = new Map<string, ReadonlySet<number>>();
      for (const [localName, symbol] of resolvedFor(file, "deferred-callback-hook")) {
        const parameters = records.get(symbol.file)?.deferredCallbackHooks.get(symbol.localName);
        if (parameters) hooks.set(localName, parameters);
      }
      return hooks;
    },
    hookDeclarationFor: (file, name) => {
      const normalized = normalizeFile(file);
      if (records.get(normalized)?.hookDeclarations.has(name)) {
        return { file: normalized, localName: name };
      }
      return resolvedFor(normalized, "hook").get(name) ?? null;
    },
    legendValueBridgesFor: file => {
      const bridges = new Map<string, ReadonlySet<string>>();
      const writers = resolvedFor(file, "legend-value-writer");
      for (const [hookName, hook] of resolvedFor(file, "legend-value-hook")) {
        const observable = records.get(hook.file)?.legendValueHooks.get(hook.localName);
        if (!observable) continue;
        const matches = new Set<string>();
        for (const [writerName, writer] of writers) {
          if (
            writer.file === hook.file &&
            records.get(writer.file)?.legendValueWriters.get(writer.localName) === observable
          ) {
            matches.add(writerName);
          }
        }
        if (matches.size > 0) bridges.set(hookName, matches);
      }
      return bridges;
    },
    observableFactoriesFor: file => new Set(resolvedFor(file, "observable-factory").keys()),
    observableKeysFor: file => {
      const keys = new Map<string, ReadonlySet<string>>();
      for (const [localName, symbol] of resolvedFor(file, "observable")) {
        const observableKeys = records.get(symbol.file)?.observableKeys.get(symbol.localName);
        if (observableKeys) keys.set(localName, observableKeys);
      }
      return keys;
    },
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

function moduleRecord(sourceFile: ts.SourceFile): ModuleRecord {
  const componentDeclarations = new Map<string, ComponentFunction>();
  const deferredCallbackOwners = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
  const deferredCallbackHooks = new Map<string, ReadonlySet<number>>();
  const hookDeclarations = new Map<string, ComponentFunction>();
  const imports = new Map<string, ImportBinding>();
  const legendValueHooks = new Map<string, string>();
  const legendValueWriters = new Map<string, string>();
  const localExports = new Map<string, string>();
  const observableDeclarations = new Set<string>();
  const observableKeys = new Map<string, ReadonlySet<string>>();
  const observableFactoryCalls = new Map<string, string>();
  const observableFactoryDeclarations = new Set<string>();
  const reexports = new Map<string, ReexportBinding>();
  const starExports: string[] = [];
  const observableFactories = new Set<string>();
  const observableTypes = new Set<string>();
  const legendNamespaces = new Set<string>();
  const reactEffectHooks = new Set<string>();
  const reactNamespaces = new Set<string>();
  const useValueHooks = new Set<string>();
  const deferredMethodsByClass = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const methods = deferredRegistrationMethods(statement);
    if (methods.size > 0) deferredMethodsByClass.set(statement.name.text, methods);
  }

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (statement.moduleSpecifier.text === "react") {
      if (statement.importClause?.name) reactNamespaces.add(statement.importClause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) {
        reactNamespaces.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (REACT_EFFECT_HOOKS.has(importedName)) {
            reactEffectHooks.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (statement.moduleSpecifier.text === "@legendapp/state/react") {
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "useValue") {
            useValueHooks.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (statement.moduleSpecifier.text !== "@legendapp/state") continue;
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
      if (statement.name) {
        if (/^use[A-Z0-9]/.test(statement.name.text)) {
          hookDeclarations.set(statement.name.text, statement);
          if (hasExport(statement)) localExports.set(statement.name.text, statement.name.text);
          if (hasDefault(statement)) localExports.set("default", statement.name.text);
        }
        const deferredParameters = deferredCallbackParameterIndices(
          statement,
          reactEffectHooks,
          reactNamespaces
        );
        const hookObservable = directLegendValueHookObservable(statement, useValueHooks);
        const writerObservable = directLegendValueWriterObservable(statement);
        if (deferredParameters.size > 0) {
          deferredCallbackHooks.set(statement.name.text, deferredParameters);
        }
        if (hookObservable) legendValueHooks.set(statement.name.text, hookObservable);
        if (writerObservable) legendValueWriters.set(statement.name.text, writerObservable);
        if ((deferredParameters.size > 0 || hookObservable || writerObservable) && hasExport(statement)) {
          localExports.set(statement.name.text, statement.name.text);
        }
        if (deferredParameters.size > 0 && hasDefault(statement)) {
          localExports.set("default", statement.name.text);
        }
      }
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
          /^use[A-Z0-9]/.test(declaration.name.text) &&
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          hookDeclarations.set(declaration.name.text, initializer);
          if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
        }
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          ts.isNewExpression(initializer) &&
          ts.isIdentifier(initializer.expression)
        ) {
          const methods = deferredMethodsByClass.get(initializer.expression.text);
          if (methods) {
            deferredCallbackOwners.set(declaration.name.text, methods);
            if (hasExport(statement)) localExports.set(declaration.name.text, declaration.name.text);
          }
        }
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
          const initializer = unwrapTransparentExpression(declaration.initializer);
          const keys = ts.isCallExpression(initializer) && initializer.arguments[0]
            ? exactObjectLiteralKeys(initializer.arguments[0])
            : null;
          if (keys) observableKeys.set(declaration.name.text, keys);
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
    if (ts.isExportAssignment(statement)) {
      const expression = unwrapTransparentExpression(statement.expression);
      if (ts.isIdentifier(expression)) {
        localExports.set("default", expression.text);
      } else if (
        ts.isNewExpression(expression) &&
        ts.isIdentifier(expression.expression)
      ) {
        const methods = deferredMethodsByClass.get(expression.expression.text);
        if (methods) {
          deferredCallbackOwners.set("default", methods);
          localExports.set("default", "default");
        }
      }
    }
  }

  for (const [name, observable] of legendValueHooks) {
    if (!observableDeclarations.has(observable)) legendValueHooks.delete(name);
  }
  for (const [name, observable] of legendValueWriters) {
    if (!observableDeclarations.has(observable)) legendValueWriters.delete(name);
  }

  return {
    componentDeclarations,
    deferredCallbackOwners,
    deferredCallbackHooks,
    hookDeclarations,
    imports,
    legendValueHooks,
    legendValueWriters,
    localExports,
    observableDeclarations,
    observableKeys,
    observableFactoryCalls,
    observableFactoryDeclarations,
    reexports,
    starExports,
  };
}

function deferredCallbackParameterIndices(
  declaration: ts.FunctionDeclaration,
  effectHooks: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>
): ReadonlySet<number> {
  const deferred = new Set<number>();
  if (!declaration.body) return deferred;
  for (const hook of effectHooks) {
    if (bindingDeclarationCount(declaration, hook) > 0) return deferred;
  }
  for (const namespace of reactNamespaces) {
    if (bindingDeclarationCount(declaration, namespace) > 0) return deferred;
  }
  declaration.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) return;
    const parameterName = parameter.name.text;
    let callbackReference = false;
    let references = 0;
    let safe = true;
    visit(declaration.body!, node => {
      if (
        !safe ||
        !ts.isIdentifier(node) ||
        node.text !== parameterName ||
        isDeclarationName(node) ||
        isNonValueIdentifier(node)
      ) {
        return;
      }
      references += 1;
      const effect = enclosingEffectCall(node, declaration, effectHooks, reactNamespaces);
      if (!effect) {
        safe = false;
        return;
      }
      if (effect.arguments[0] && nodeWithin(node, effect.arguments[0])) {
        callbackReference = true;
      }
    });
    if (safe && references > 0 && callbackReference) deferred.add(index);
  });
  return deferred;
}

function enclosingEffectCall(
  node: ts.Node,
  boundary: ts.FunctionDeclaration,
  effectHooks: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>
): ts.CallExpression | null {
  for (let current: ts.Node | undefined = node.parent; current && current !== boundary; current = current.parent) {
    if (!ts.isCallExpression(current) || !current.arguments.some(argument => nodeWithin(node, argument))) {
      continue;
    }
    if (
      (ts.isIdentifier(current.expression) && effectHooks.has(current.expression.text)) ||
      (ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.expression) &&
        reactNamespaces.has(current.expression.expression.text) &&
        REACT_EFFECT_HOOKS.has(current.expression.name.text))
    ) {
      return current;
    }
  }
  return null;
}

function directLegendValueHookObservable(
  declaration: ts.FunctionDeclaration,
  useValueHooks: ReadonlySet<string>
): string | null {
  if (declaration.parameters.length !== 0 || !declaration.body || declaration.body.statements.length !== 1) {
    return null;
  }
  const statement = declaration.body.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return null;
  let expression = unwrapTransparentExpression(statement.expression);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    expression = unwrapTransparentExpression(expression.left);
  }
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !ts.isIdentifier(expression.expression) ||
    !useValueHooks.has(expression.expression.text)
  ) {
    return null;
  }
  const observable = unwrapTransparentExpression(expression.arguments[0]!);
  return ts.isIdentifier(observable) ? observable.text : null;
}

function directLegendValueWriterObservable(
  declaration: ts.FunctionDeclaration
): string | null {
  const parameter = declaration.parameters[0];
  const statement = declaration.body?.statements[0];
  if (
    declaration.parameters.length !== 1 ||
    !parameter ||
    !ts.isIdentifier(parameter.name) ||
    declaration.body?.statements.length !== 1 ||
    !statement ||
    !ts.isExpressionStatement(statement)
  ) {
    return null;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  const argument = ts.isCallExpression(expression) && expression.arguments[0]
    ? unwrapTransparentExpression(expression.arguments[0])
    : null;
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !argument ||
    !ts.isIdentifier(argument) ||
    argument.text !== parameter.name.text ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "set"
  ) {
    return null;
  }
  const observable = unwrapTransparentExpression(expression.expression.expression);
  return ts.isIdentifier(observable) ? observable.text : null;
}

function deferredRegistrationMethods(
  declaration: ts.ClassDeclaration
): ReadonlyMap<string, ReadonlySet<number>> {
  const methods = new Map<string, ReadonlySet<number>>();
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) continue;
    const deferred = new Set<number>();
    member.parameters.forEach((parameter, index) => {
      if (
        ts.isIdentifier(parameter.name) &&
        bindingDeclarationCount(member, parameter.name.text) === 1 &&
        methodStoresCallbackUntilCleanup(declaration, member, parameter.name)
      ) {
        deferred.add(index);
      }
    });
    if (deferred.size > 0) methods.set(member.name.text, deferred);
  }
  return methods;
}

function methodStoresCallbackUntilCleanup(
  declaration: ts.ClassDeclaration,
  method: ts.MethodDeclaration,
  parameter: ts.Identifier
): boolean {
  if (!method.body) return false;
  const returns: ts.ReturnStatement[] = [];
  const references: ts.Identifier[] = [];
  visit(method.body, node => {
    if (ts.isReturnStatement(node) && nearestNestedFunction(node, method) === null) {
      returns.push(node);
    }
    if (
      ts.isIdentifier(node) &&
      node.text === parameter.text &&
      node !== parameter &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  if (returns.length !== 1 || !returns[0]!.expression || references.length < 2) return false;
  const cleanup = unwrapTransparentExpression(returns[0]!.expression!);
  if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) return false;

  const stored = references.flatMap(reference => {
    const property = storedCallbackProperty(reference, declaration);
    return property ? [{ property, reference }] : [];
  });
  if (stored.length !== 1 || stored[0]!.reference.getStart() >= returns[0]!.getStart()) return false;
  const property = stored[0]!.property;
  return references.every(reference => {
    if (reference === stored[0]!.reference) return true;
    return nodeWithin(reference, cleanup) &&
      callbackReferenceIsRemoved(reference, cleanup, property);
  });
}

function callbackReferenceIsRemoved(
  reference: ts.Identifier,
  cleanup: ts.ArrowFunction | ts.FunctionExpression,
  property: string
): boolean {
  const comparison = reference.parent;
  if (
    !ts.isBinaryExpression(comparison) ||
    (comparison.left !== reference && comparison.right !== reference) ||
    ![
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(comparison.operatorToken.kind)
  ) {
    return false;
  }
  let filter: ts.CallExpression | null = null;
  for (let current: ts.Node | undefined = comparison.parent; current && current !== cleanup; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "filter" &&
      isThisProperty(current.expression.expression, property) &&
      current.arguments.some(argument => nodeWithin(reference, argument))
    ) {
      filter = current;
      break;
    }
  }
  if (!filter) return false;
  for (let current: ts.Node | undefined = filter.parent; current && current !== cleanup; current = current.parent) {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isThisProperty(current.left, property) &&
      unwrapTransparentExpression(current.right) === filter
    ) {
      return true;
    }
  }
  return false;
}

function storedCallbackProperty(
  reference: ts.Identifier,
  declaration: ts.ClassDeclaration
): string | null {
  const call = reference.parent;
  if (
    !ts.isCallExpression(call) ||
    !call.arguments.includes(reference) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "push" ||
    !ts.isPropertyAccessExpression(call.expression.expression) ||
    call.expression.expression.expression.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return null;
  }
  const property = call.expression.expression.name.text;
  const field = declaration.members.find(member =>
    ts.isPropertyDeclaration(member) &&
    ts.isIdentifier(member.name) &&
    member.name.text === property
  );
  if (!field || !ts.isPropertyDeclaration(field)) return null;
  const initializer = field.initializer && unwrapTransparentExpression(field.initializer);
  return (
    (initializer && ts.isArrayLiteralExpression(initializer)) ||
    !!field.type &&
      (ts.isArrayTypeNode(field.type) ||
        (ts.isTypeReferenceNode(field.type) &&
          ts.isIdentifier(field.type.typeName) &&
          field.type.typeName.text === "Array"))
  )
    ? property
    : null;
}

function isThisProperty(expression: ts.Expression, property: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isPropertyAccessExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ThisKeyword &&
    value.name.text === property;
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
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configFile));
  const options = parsed.options;
  const missingBaseConfig = parsed.errors.some(diagnostic => diagnostic.code === 6053);
  return options.moduleResolution === undefined && missingBaseConfig
    ? { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler }
    : options;
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
  return pathIdentityKey(file);
}
