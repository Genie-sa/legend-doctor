import type { ModuleRecord, ModuleRecordDraft, ModuleSignals } from "./model.js";
import { collectClassDeclaration, collectFunctionDeclaration } from "./function-declarations.js";
import {
  collectExportAssignment,
  collectExportDeclaration,
  collectImportBindings,
} from "./module-bindings.js";
import { applyStyledComponentCandidates } from "./framework-event-components.js";
import { collectReactComponentWrappers } from "../../core/react-component-wrappers.js";
import { collectVariableStatement } from "./variable-declarations.js";
import { deferredRegistrationMethodsByClass } from "./deferred-registrations.js";
import { isDeclarationName } from "../../core/analysis-ast.js";
import { localObservableMemberFactories } from "./observable-declarations.js";
import { moduleImportSignals } from "./import-signals.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export function moduleRecord(sourceFile: ts.SourceFile): ModuleRecord {
  const draft = emptyModuleRecordDraft(sourceFile);
  const signals = moduleSignals(sourceFile);
  for (const statement of sourceFile.statements) {
    collectModuleStatement(statement, draft, signals);
  }
  pruneUnboundLegendValueBridges(draft);
  applyStyledComponentCandidates(draft, signals.styledFactories);
  return finalizeModuleRecord(draft);
}

function emptyModuleRecordDraft(sourceFile: ts.SourceFile): ModuleRecordDraft {
  let shadowedImports: Set<string> | null = null;
  const draft: ModuleRecordDraft = {
    componentDeclarations: new Map(),
    contextReaderHooks: new Map(),
    deferredCallbackHooks: new Map(),
    deferredCallbackOwners: new Map(),
    frameworkEventComponents: new Set(),
    hookDeclarations: new Map(),
    imports: new Map(),
    legendValueHooks: new Map(),
    legendValueWriters: new Map(),
    localExports: new Map(),
    observableArrayPaths: new Map(),
    observableDeclarations: new Set(),
    observableFactoryCalls: new Map(),
    observableFactoryDeclarations: new Set(),
    observableKeys: new Map(),
    observableMemberDeclarations: new Map(),
    pureProjectionDeclarations: new Set(),
    reactContexts: new Set(),
    reexports: new Map(),
    get shadowedImports() {
      shadowedImports ??= collectShadowedImports(sourceFile, draft);
      return shadowedImports;
    },
    starExports: [],
    styledComponentCandidates: [],
  };
  return draft;
}

function finalizeModuleRecord(draft: ModuleRecordDraft): ModuleRecord {
  return {
    componentDeclarations: draft.componentDeclarations,
    contextReaderHooks: draft.contextReaderHooks,
    deferredCallbackHooks: draft.deferredCallbackHooks,
    deferredCallbackOwners: draft.deferredCallbackOwners,
    frameworkEventComponents: draft.frameworkEventComponents,
    hookDeclarations: draft.hookDeclarations,
    imports: draft.imports,
    legendValueHooks: draft.legendValueHooks,
    legendValueWriters: draft.legendValueWriters,
    localExports: draft.localExports,
    observableArrayPaths: draft.observableArrayPaths,
    observableDeclarations: draft.observableDeclarations,
    observableFactoryCalls: draft.observableFactoryCalls,
    observableFactoryDeclarations: draft.observableFactoryDeclarations,
    observableKeys: draft.observableKeys,
    observableMemberDeclarations: draft.observableMemberDeclarations,
    pureProjectionDeclarations: draft.pureProjectionDeclarations,
    reactContexts: draft.reactContexts,
    reexports: draft.reexports,
    get shadowedImports() {
      return draft.shadowedImports;
    },
    starExports: draft.starExports,
  };
}

function moduleSignals(sourceFile: ts.SourceFile): ModuleSignals {
  const imports = moduleImportSignals(sourceFile);
  return {
    ...imports,
    componentWrappers: collectReactComponentWrappers(sourceFile),
    deferredMethodsByClass: deferredRegistrationMethodsByClass(sourceFile),
    observableMemberFactories: localObservableMemberFactories(
      sourceFile,
      imports.observableFactories,
      imports.legendNamespaces,
    ),
    sourceFile,
  };
}

function collectModuleStatement(
  statement: ts.Statement,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  if (ts.isFunctionDeclaration(statement)) {
    collectFunctionDeclaration(statement, draft, signals);
  } else if (ts.isClassDeclaration(statement)) {
    collectClassDeclaration(statement, draft);
  } else if (ts.isVariableStatement(statement)) {
    collectVariableStatement(statement, draft, signals);
  } else {
    collectModuleBindingStatement(statement, draft, signals);
  }
}

function collectModuleBindingStatement(
  statement: ts.Statement,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    collectImportBindings(statement.importClause, draft, statement.moduleSpecifier.text);
  } else if (ts.isExportDeclaration(statement)) {
    collectExportDeclaration(statement, draft);
  } else if (ts.isExportAssignment(statement)) {
    collectExportAssignment(statement, draft, signals);
  }
}

function pruneUnboundLegendValueBridges(draft: ModuleRecordDraft): void {
  for (const [name, observable] of draft.legendValueHooks) {
    if (!draft.observableDeclarations.has(observable)) {
      draft.legendValueHooks.delete(name);
    }
  }
  for (const [name, observable] of draft.legendValueWriters) {
    if (!draft.observableDeclarations.has(observable)) {
      draft.legendValueWriters.delete(name);
    }
  }
}

function collectShadowedImports(sourceFile: ts.SourceFile, draft: ModuleRecordDraft): Set<string> {
  const shadowed = new Set<string>();
  visit(sourceFile, (node) => {
    if (ts.isIdentifier(node) && draft.imports.has(node.text) && isDeclarationName(node)) {
      shadowed.add(node.text);
    }
  });
  return shadowed;
}
