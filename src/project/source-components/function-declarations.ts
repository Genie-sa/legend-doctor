import type { FunctionTraits, ModuleRecordDraft, ModuleSignals } from "./model.js";
import { deferredCallbackParameterIndices, directReactContextReader } from "./react-traits.js";
import {
  directLegendValueHookObservable,
  directLegendValueWriterObservable,
} from "./legend-value-bridges.js";
import { hasDefault, hasExport, isSemanticComponentName } from "./declaration-shapes.js";
import { isObservableTypeReference } from "./observable-declarations.js";
import { isPureProjectionDeclaration } from "./pure-projections.js";
import type ts from "typescript";

export function collectFunctionDeclaration(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const name = statement.name?.text;
  if (name === undefined) {
    collectAnonymousDefaultFunction(statement, draft);
    return;
  }
  collectHookFunctionDeclaration(statement, draft, name);
  const traits = functionDeclarationTraits(statement, draft, signals);
  recordFunctionTraitDeclarations(draft, traits);
  applyFunctionTraitExports(statement, draft, traits);
  collectObservableFactoryFunction(statement, draft, signals);
  collectComponentFunctionDeclaration(statement, draft);
}

function collectAnonymousDefaultFunction(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
): void {
  if (hasExport(statement) && hasDefault(statement)) {
    draft.componentDeclarations.set("default", statement);
    draft.localExports.set("default", "default");
  }
}

function collectHookFunctionDeclaration(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  name: string,
): void {
  if (!/^use[A-Z0-9]/u.test(name)) {
    return;
  }
  draft.hookDeclarations.set(name, statement);
  if (hasExport(statement)) {
    draft.localExports.set(name, name);
  }
  if (hasDefault(statement)) {
    draft.localExports.set("default", name);
  }
}

function functionDeclarationTraits(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): FunctionTraits {
  return {
    deferredParameters: deferredCallbackParameterIndices(statement, {
      effectHooks: signals.reactEffectHooks,
      reactNamespaces: signals.reactNamespaces,
    }),
    hookObservable: directLegendValueHookObservable(statement, signals.useValueHooks),
    name: statement.name?.text ?? "",
    pureProjection: isPureProjectionDeclaration(statement, draft.imports),
    readContext: directReactContextReader(
      statement,
      signals.reactContextReaders,
      signals.reactNamespaces,
    ),
    writerObservable: directLegendValueWriterObservable(statement),
  };
}

function recordFunctionTraitDeclarations(draft: ModuleRecordDraft, traits: FunctionTraits): void {
  if (traits.readContext) {
    draft.contextReaderHooks.set(traits.name, traits.readContext);
  }
  if (traits.deferredParameters.size > 0) {
    draft.deferredCallbackHooks.set(traits.name, traits.deferredParameters);
  }
  if (traits.hookObservable) {
    draft.legendValueHooks.set(traits.name, traits.hookObservable);
  }
  if (traits.writerObservable) {
    draft.legendValueWriters.set(traits.name, traits.writerObservable);
  }
  if (traits.pureProjection) {
    draft.pureProjectionDeclarations.add(traits.name);
  }
}

function applyFunctionTraitExports(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  traits: FunctionTraits,
): void {
  const { deferredParameters, name } = traits;
  const signalled =
    deferredParameters.size > 0 ||
    Boolean(traits.hookObservable) ||
    Boolean(traits.writerObservable) ||
    draft.pureProjectionDeclarations.has(name) ||
    Boolean(traits.readContext);
  if (signalled && hasExport(statement)) {
    draft.localExports.set(name, name);
  }
  if (deferredParameters.size > 0 && hasDefault(statement)) {
    draft.localExports.set("default", name);
  }
}

function collectObservableFactoryFunction(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const name = statement.name?.text;
  if (
    name === undefined ||
    !statement.type ||
    !isObservableTypeReference(statement.type, signals.observableTypes)
  ) {
    return;
  }
  draft.observableFactoryDeclarations.add(name);
  if (hasExport(statement)) {
    draft.localExports.set(name, name);
  }
}

function collectComponentFunctionDeclaration(
  statement: ts.FunctionDeclaration,
  draft: ModuleRecordDraft,
): void {
  const name = statement.name?.text;
  if (name === undefined || !isSemanticComponentName(name)) {
    return;
  }
  draft.componentDeclarations.set(name, statement);
  if (hasExport(statement)) {
    draft.localExports.set(name, name);
  }
  if (hasDefault(statement)) {
    draft.localExports.set("default", name);
  }
}

export function collectClassDeclaration(
  statement: ts.ClassDeclaration,
  draft: ModuleRecordDraft,
): void {
  const name = statement.name?.text;
  if (name === undefined) {
    collectAnonymousDefaultClass(statement, draft);
    return;
  }
  if (!isSemanticComponentName(name)) {
    return;
  }
  if (hasExport(statement)) {
    draft.localExports.set(name, name);
  }
  if (hasDefault(statement)) {
    draft.localExports.set("default", name);
  }
}

function collectAnonymousDefaultClass(
  statement: ts.ClassDeclaration,
  draft: ModuleRecordDraft,
): void {
  if (hasExport(statement) && hasDefault(statement)) {
    draft.localExports.set("default", "default");
  }
}
