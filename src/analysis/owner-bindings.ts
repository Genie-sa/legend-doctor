import type { EffectStateScope, StateCandidate, StateUsage } from "./model.js";
import { bindingDeclarationCount, collectBindingNames } from "../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../core/ast.js";
import type { HookImports } from "../core/imports.js";
import { MUTATION_PROPERTY_NAMES } from "./constants.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { isLocalHookCall } from "../core/imports.js";
import ts from "typescript";

export function collectEffectStateScopes(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
): ReadonlyMap<RuntimeFunctionLike, EffectStateScope> {
  const scopes = new Map<RuntimeFunctionLike, EffectStateScope>();
  for (const state of states) {
    let scope = scopes.get(state.owner);
    if (!scope) {
      scope = { bySetter: new Map(), byValue: new Map(), usageBySetter: new Map() };
      scopes.set(state.owner, scope);
    }
    registerStateInScope(scope, state, usageByState.get(state));
  }
  return scopes;
}

function registerStateInScope(
  scope: EffectStateScope,
  state: StateCandidate,
  usage: StateUsage | undefined,
): void {
  scope.byValue.set(state.valueName, state);
  if (!state.setterName) {
    return;
  }
  scope.bySetter.set(state.setterName, state);
  if (usage) {
    scope.usageBySetter.set(state.setterName, usage);
  }
}

export function collectUseValueBindings(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const bindings = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }
    if (
      !ts.isCallExpression(node.initializer) ||
      !isLocalHookCall(node.initializer, imports.useValue)
    ) {
      return;
    }
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner || bindingDeclarationCount(owner, node.name.text) !== 1) {
      return;
    }
    const ownerBindings = bindings.get(owner) ?? new Set<string>();
    ownerBindings.add(node.name.text);
    bindings.set(owner, ownerBindings);
  });
  return bindings;
}

const OBSERVABLE_SUBSCRIPTION_HOOKS = new Set(["useValue", "useSelector", "use$"]);

export function collectObservableSubscriptionCounts(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReadonlyMap<RuntimeFunctionLike, number> {
  const counts = new Map<RuntimeFunctionLike, number>();
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isObservableSubscriptionHookCall(node, imports)) {
      return;
    }
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner) {
      return;
    }
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  });
  return counts;
}

function isObservableSubscriptionHookCall(call: ts.CallExpression, imports: HookImports): boolean {
  const { expression } = call;
  if (ts.isIdentifier(expression)) {
    return imports.useValue.has(expression.text) || imports.legacyUseValue.has(expression.text);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.legendReactNamespaces.has(expression.expression.text) &&
    OBSERVABLE_SUBSCRIPTION_HOOKS.has(expression.name.text)
  );
}

export function collectStableUseObservableBindings(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const bindings = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, (node) => {
    const owner = stableObservableBindingOwner(node, imports);
    if (!owner || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
      return;
    }
    const ownerBindings = bindings.get(owner) ?? new Set<string>();
    ownerBindings.add(node.name.text);
    bindings.set(owner, ownerBindings);
  });
  return bindings;
}

function stableObservableBindingOwner(
  node: ts.Node,
  imports: HookImports,
): RuntimeFunctionLike | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
    return null;
  }
  if (
    !ts.isCallExpression(node.initializer) ||
    !isLocalHookCall(node.initializer, imports.useObservable) ||
    !ts.isVariableDeclarationList(node.parent) ||
    (node.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const owner = findAncestor(node, isRuntimeFunctionLike);
  return owner && bindingDeclarationCount(owner, node.name.text) === 1 ? owner : null;
}

export function collectModuleScopeBindings(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    addModuleScopeStatementBindings(statement, bindings);
  }
  return bindings;
}

function addModuleScopeStatementBindings(statement: ts.Statement, bindings: Set<string>): void {
  if (ts.isImportDeclaration(statement)) {
    addImportClauseBindings(statement.importClause, bindings);
    return;
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
    bindings.add(statement.name.text);
    return;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, bindings);
    }
  }
}

function addImportClauseBindings(clause: ts.ImportClause | undefined, bindings: Set<string>): void {
  if (clause?.name) {
    bindings.add(clause.name.text);
  }
  const named = clause?.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    bindings.add(named.name.text);
  }
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      bindings.add(element.name.text);
    }
  }
}

export function collectReactiveMutationBindings(
  sourceFile: ts.SourceFile,
): ReadonlyMap<RuntimeFunctionLike, ReadonlySet<string>> {
  const result = new Map<RuntimeFunctionLike, Set<string>>();
  visit(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !ts.isIdentifier(node.initializer.expression) ||
      !/^use[A-Z0-9]/u.test(node.initializer.expression.text)
    ) {
      return;
    }
    const owner = findAncestor(node, isRuntimeFunctionLike);
    if (!owner) {
      return;
    }
    const bindings = result.get(owner) ?? new Set<string>();
    if (addMutationBindingNames(node.name, bindings)) {
      result.set(owner, bindings);
    }
  });
  return result;
}

function addMutationBindingNames(name: ts.BindingName, bindings: Set<string>): boolean {
  if (ts.isIdentifier(name)) {
    bindings.add(`${name.text}.mutate`);
    bindings.add(`${name.text}.mutateAsync`);
    return true;
  }
  const destructured = ts.isObjectBindingPattern(name)
    ? name.elements.filter(
        (element) =>
          ts.isIdentifier(element.name) &&
          MUTATION_PROPERTY_NAMES.has(element.propertyName?.getText() ?? element.name.text),
      )
    : [];
  for (const element of destructured) {
    bindings.add(element.name.getText());
  }
  return destructured.length > 0;
}
