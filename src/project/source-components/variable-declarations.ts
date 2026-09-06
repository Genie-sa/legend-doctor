import type { DeclarationContext, ModuleRecordDraft, ModuleSignals } from "./model.js";
import { arrayLiteralPaths, observableInitialValue } from "../../core/observable-initial-value.js";
import {
  componentFunction,
  hasExport,
  isComponentInitializer,
  isSemanticComponentName,
  unwrapTransparentExpression,
} from "./declaration-shapes.js";
import { directObservableMembers, isObservableInitializer } from "./observable-declarations.js";
import { directReactContextReader, isReactContextInitializer } from "./react-traits.js";
import { exactObjectLiteralKeys } from "../../core/analysis-ast.js";
import { styledComponentTarget } from "./framework-event-components.js";
import ts from "typescript";

export function collectVariableStatement(
  statement: ts.VariableStatement,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const exported = hasExport(statement);
  for (const declaration of statement.declarationList.declarations) {
    collectVariableDeclaration(declarationContext(declaration, exported), draft, signals);
  }
}

function declarationContext(
  declaration: ts.VariableDeclaration,
  exported: boolean,
): DeclarationContext {
  return {
    declaration,
    exported,
    initializer: declaration.initializer
      ? unwrapTransparentExpression(declaration.initializer)
      : null,
    isConst:
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
    name: ts.isIdentifier(declaration.name) ? declaration.name.text : null,
  };
}

function collectVariableDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  collectReactContextDeclaration(context, draft, signals);
  collectHookVariableDeclaration(context, draft, signals);
  collectDeferredOwnerDeclaration(context, draft, signals);
  collectStyledCandidate(context, draft);
  collectCallInitializerDeclaration(context, draft, signals);
  collectObjectObservableMembers(context, draft, signals);
  collectObservableDeclaration(context, draft, signals);
  collectComponentVariableDeclaration(context, draft, signals);
}

function collectReactContextDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !initializer ||
    !isReactContextInitializer(initializer, signals.reactContextFactories, signals.reactNamespaces)
  ) {
    return;
  }
  draft.reactContexts.add(name);
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function collectHookVariableDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !/^use[A-Z0-9]/u.test(name) ||
    !initializer ||
    !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  ) {
    return;
  }
  draft.hookDeclarations.set(name, initializer);
  const readContext = directReactContextReader(
    initializer,
    signals.reactContextReaders,
    signals.reactNamespaces,
  );
  if (readContext) {
    draft.contextReaderHooks.set(name, readContext);
  }
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function collectDeferredOwnerDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !initializer ||
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression)
  ) {
    return;
  }
  const methods = signals.deferredMethodsByClass.get(initializer.expression.text);
  if (!methods) {
    return;
  }
  draft.deferredCallbackOwners.set(name, methods);
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function collectStyledCandidate(context: DeclarationContext, draft: ModuleRecordDraft): void {
  const { initializer, name } = context;
  const styledTarget =
    name !== null && initializer && context.isConst ? styledComponentTarget(initializer) : null;
  if (name !== null && styledTarget) {
    draft.styledComponentCandidates.push({ exported: context.exported, name, ...styledTarget });
  }
}

function collectCallInitializerDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !initializer ||
    !ts.isCallExpression(initializer) ||
    !ts.isIdentifier(initializer.expression)
  ) {
    return;
  }
  const callee = initializer.expression.text;
  if (signals.nativeComponentFactories.has(callee) && context.isConst) {
    draft.frameworkEventComponents.add(name);
  }
  draft.observableFactoryCalls.set(name, callee);
  recordObservableMemberFactoryCall(context, draft, signals.observableMemberFactories.get(callee));
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function recordObservableMemberFactoryCall(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  members: ReadonlySet<string> | undefined,
): void {
  if (context.name !== null && members && context.isConst) {
    draft.observableMemberDeclarations.set(context.name, members);
  }
}

function collectObjectObservableMembers(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { initializer, name } = context;
  if (
    name === null ||
    !initializer ||
    !ts.isObjectLiteralExpression(initializer) ||
    !context.isConst
  ) {
    return;
  }
  const members = directObservableMembers(
    initializer,
    signals.observableFactories,
    signals.legendNamespaces,
  );
  if (members.size === 0) {
    return;
  }
  publishObjectObservableMembers({ context, draft, initializer, members, name, signals });
}

interface ObjectObservablePublication {
  readonly context: DeclarationContext;
  readonly draft: ModuleRecordDraft;
  readonly initializer: ts.ObjectLiteralExpression;
  readonly members: ReadonlySet<string>;
  readonly name: string;
  readonly signals: ModuleSignals;
}

function publishObjectObservableMembers({
  context,
  draft,
  initializer,
  members,
  name,
  signals,
}: ObjectObservablePublication): void {
  draft.observableMemberDeclarations.set(name, members);
  for (const property of initializer.properties) {
    recordMemberArrayPaths(property, name, { draft, signals });
  }
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

interface ObservableOrigin {
  factory: ts.CallExpression;
  name: string;
}

function recordMemberArrayPaths(
  property: ts.ObjectLiteralElementLike,
  containerName: string,
  records: { draft: ModuleRecordDraft; signals: ModuleSignals },
): void {
  if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
    return;
  }
  const factory = unwrapTransparentExpression(property.initializer);
  const isObservableMember = records.draft.observableMemberDeclarations
    .get(containerName)
    ?.has(property.name.text);
  if (ts.isCallExpression(factory) && isObservableMember) {
    const name = `${containerName}.${property.name.text}`;
    recordArrayPaths({ factory, name }, records.draft, records.signals);
  }
}

function recordArrayPaths(
  origin: ObservableOrigin,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const initial = observableInitialValue(origin.factory, signals);
  const paths = initial ? arrayLiteralPaths(initial) : null;
  if (paths && paths.size > 0) {
    draft.observableArrayPaths.set(origin.name, paths);
  }
}

function collectObservableDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { declaration, name } = context;
  if (
    name === null ||
    !declaration.initializer ||
    !isObservableInitializer(
      declaration.initializer,
      signals.observableFactories,
      signals.legendNamespaces,
    )
  ) {
    return;
  }
  draft.observableDeclarations.add(name);
  const factory = unwrapTransparentExpression(declaration.initializer);
  if (ts.isCallExpression(factory)) {
    recordObservableInitialValue({ factory, name }, draft, signals);
  }
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}

function recordObservableInitialValue(
  origin: ObservableOrigin,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const initial = observableInitialValue(origin.factory, signals);
  const keys = initial ? exactObjectLiteralKeys(initial) : null;
  if (keys) {
    draft.observableKeys.set(origin.name, keys);
  }
  recordArrayPaths(origin, draft, signals);
}

function collectComponentVariableDeclaration(
  context: DeclarationContext,
  draft: ModuleRecordDraft,
  signals: ModuleSignals,
): void {
  const { declaration, name } = context;
  if (
    name === null ||
    !isSemanticComponentName(name) ||
    !declaration.initializer ||
    !isComponentInitializer(declaration.initializer, signals.componentWrappers)
  ) {
    return;
  }
  const component = componentFunction(declaration.initializer, signals.componentWrappers);
  if (!component) {
    return;
  }
  draft.componentDeclarations.set(name, component);
  if (context.exported) {
    draft.localExports.set(name, name);
  }
}
