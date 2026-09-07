import type { EffectCandidate, StateCandidate } from "../../analysis/model.js";
import {
  bindingDeclarationCount,
  collectBindingNames,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { identifiersNamed, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import type { EffectClassificationContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

export type EffectStateDependency =
  | { readonly kind: "legend" | "unresolved"; readonly name: string }
  | { readonly kind: "setter" | "value"; readonly name: string; readonly state: StateCandidate };

const LEGEND_STATE_HOOKS = new Set([
  "use$",
  "useComputed",
  "useObservable",
  "useObservableReducer",
  "useObservableState",
  "useSelector",
  "useValue",
]);

const REACT_STATE_HOOKS = new Set(["useReducer", "useState", "useSyncExternalStore"]);

const DEPENDENCY_SEVERITY = {
  legend: 1,
  setter: 3,
  unresolved: 0,
  value: 2,
} as const satisfies Record<EffectStateDependency["kind"], number>;

export interface EffectStateDependencies {
  readonly body: EffectStateDependency | null;
  /** Whether a Legend binding or an unresolvable owner binding is reached anywhere. */
  readonly opaque: boolean;
  readonly schedule: EffectStateDependency | null;
  /** Every local React state the callback or its dependency array reaches. */
  readonly states: readonly StateCandidate[];
}

interface IndependenceScope {
  readonly callback: ts.ArrowFunction | ts.FunctionExpression;
  readonly context: EffectClassificationContext;
  readonly owner: RuntimeFunctionLike;
  readonly resolved: Map<string, readonly EffectStateDependency[]>;
  readonly resolving: Set<string>;
}

/**
 * Resolves the local React state, Legend binding, or unresolvable owner binding that a dependency
 * effect's schedule (its dependency array) and body reach, following owner `const` initializers and
 * local functions transitively. A state with no setter binding can never be written, so it counts as a
 * component-lifetime constant rather than a dependency. A `null` schedule proves React props, external
 * values, and those constants alone decide when the effect runs; a `null` body proves no state
 * migration inside the owner changes its inputs.
 */
export function analyzeEffectStateDependencies(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: EffectClassificationContext,
): EffectStateDependencies {
  if (!effect.owner || !effect.dependencies) {
    const unresolved: EffectStateDependency = { kind: "unresolved", name: "owner" };
    return { body: unresolved, opaque: true, schedule: unresolved, states: [] };
  }
  const scope: IndependenceScope = {
    callback,
    context,
    owner: effect.owner,
    resolved: new Map(),
    resolving: new Set(),
  };
  const body = dependenciesOfNode(callback, scope);
  const schedule = dependenciesOfNode(effect.dependencies, scope);
  const reached = [...body, ...schedule];
  return {
    body: strongestDependency(body),
    opaque: reached.some((dependency) => !isStateDependency(dependency)),
    schedule: strongestDependency(schedule),
    states: [
      ...new Set(
        reached.flatMap((dependency) => (isStateDependency(dependency) ? [dependency.state] : [])),
      ),
    ],
  };
}

function isStateDependency(
  dependency: EffectStateDependency,
): dependency is Extract<EffectStateDependency, { kind: "setter" | "value" }> {
  return dependency.kind === "setter" || dependency.kind === "value";
}

function strongestDependency(
  dependencies: readonly EffectStateDependency[],
): EffectStateDependency | null {
  let strongest: EffectStateDependency | null = null;
  for (const dependency of dependencies) {
    if (!strongest || DEPENDENCY_SEVERITY[dependency.kind] > DEPENDENCY_SEVERITY[strongest.kind]) {
      strongest = dependency;
    }
  }
  return strongest;
}

function dependenciesOfNode(node: ts.Node, scope: IndependenceScope): EffectStateDependency[] {
  const declaredWithin = declaredNamesWithin(node);
  const dependencies: EffectStateDependency[] = [];
  for (const name of referencedValueNames(node)) {
    dependencies.push(...dependenciesOfReference(name, declaredWithin, scope));
  }
  return dependencies;
}

function dependenciesOfReference(
  name: string,
  declaredWithin: ReadonlySet<string>,
  scope: IndependenceScope,
): readonly EffectStateDependency[] {
  const local = localStateDependency(name, scope.context);
  if (local) {
    if (declaredWithin.has(name)) {
      return [{ kind: "unresolved", name }];
    }
    return isConstantState(local) ? [] : [local];
  }
  return declaredWithin.has(name) ? [] : resolveOwnerBinding(name, scope);
}

function isConstantState(dependency: EffectStateDependency): boolean {
  return dependency.kind === "value" && dependency.state.setterName === null;
}

function localStateDependency(
  name: string,
  context: EffectClassificationContext,
): EffectStateDependency | null {
  const setterState = context.stateBySetter.get(name);
  if (setterState) {
    return { kind: "setter", name, state: setterState };
  }
  const valueState = context.stateByValue.get(name);
  if (valueState) {
    return { kind: "value", name, state: valueState };
  }
  return context.useValueBindings.has(name) || context.useObservableBindings.has(name)
    ? { kind: "legend", name }
    : null;
}

function resolveOwnerBinding(
  name: string,
  scope: IndependenceScope,
): readonly EffectStateDependency[] {
  const known = scope.resolved.get(name);
  if (known !== undefined || scope.resolving.has(name)) {
    return known ?? [];
  }
  scope.resolving.add(name);
  const dependencies = resolveUncachedOwnerBinding(name, scope);
  scope.resolving.delete(name);
  scope.resolved.set(name, dependencies);
  return dependencies;
}

function resolveUncachedOwnerBinding(
  name: string,
  scope: IndependenceScope,
): readonly EffectStateDependency[] {
  const { owner } = scope;
  const declarations = bindingDeclarationCount(owner, name);
  if (declarations === 0) {
    return declaredByEnclosingFunction(name, owner) ? [{ kind: "unresolved", name }] : [];
  }
  const declaration = declarations === 1 ? soleDeclarationIdentifier(owner, name) : null;
  return declaration
    ? dependenciesOfDeclaration(declaration, scope)
    : [{ kind: "unresolved", name }];
}

function declaredByEnclosingFunction(name: string, owner: RuntimeFunctionLike): boolean {
  for (let current = owner.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current) && bindingDeclarationCount(current, name) > 0) {
      return true;
    }
  }
  return false;
}

function soleDeclarationIdentifier(owner: RuntimeFunctionLike, name: string): ts.Identifier | null {
  const declarations = identifiersNamed(owner, name).filter(
    (identifier) => isDeclarationName(identifier) && !withinTypeNode(identifier, owner),
  );
  const [declaration] = declarations;
  return declarations.length === 1 && declaration ? declaration : null;
}

function dependenciesOfDeclaration(
  identifier: ts.Identifier,
  scope: IndependenceScope,
): readonly EffectStateDependency[] {
  const name = identifier.text;
  const declaration = bindingRoot(identifier);
  if (ts.isParameter(declaration)) {
    return dependenciesOfParameter(declaration, name, scope);
  }
  if (ts.isVariableDeclaration(declaration)) {
    return dependenciesOfVariable(declaration, name, scope);
  }
  if (ts.isFunctionDeclaration(declaration) && declaration.body) {
    return declaredDirectlyInOwner(declaration, scope)
      ? dependenciesOfNode(declaration, scope)
      : [{ kind: "unresolved", name }];
  }
  return [{ kind: "unresolved", name }];
}

function bindingRoot(identifier: ts.Identifier): ts.Node {
  let current: ts.Node = identifier.parent;
  while (
    ts.isBindingElement(current) ||
    ts.isArrayBindingPattern(current) ||
    ts.isObjectBindingPattern(current)
  ) {
    current = current.parent;
  }
  return current;
}

function dependenciesOfParameter(
  parameter: ts.ParameterDeclaration,
  name: string,
  scope: IndependenceScope,
): readonly EffectStateDependency[] {
  const { parent } = parameter;
  if (parent === scope.owner || nodeWithin(parent, scope.callback)) {
    return [];
  }
  return [{ kind: "unresolved", name }];
}

function dependenciesOfVariable(
  declaration: ts.VariableDeclaration,
  name: string,
  scope: IndependenceScope,
): readonly EffectStateDependency[] {
  if (nodeWithin(declaration, scope.callback)) {
    return [];
  }
  const { initializer, parent } = declaration;
  if (
    !initializer ||
    !ts.isVariableDeclarationList(parent) ||
    (parent.flags & ts.NodeFlags.Const) === 0 ||
    !declaredDirectlyInOwner(declaration, scope)
  ) {
    return [{ kind: "unresolved", name }];
  }
  return dependenciesOfInitializer(initializer, name, scope);
}

function declaredDirectlyInOwner(node: ts.Node, scope: IndependenceScope): boolean {
  for (let current = node.parent; current && current !== scope.owner; current = current.parent) {
    if (isRuntimeFunctionLike(current)) {
      return false;
    }
  }
  return true;
}

function dependenciesOfInitializer(
  initializer: ts.Expression,
  name: string,
  scope: IndependenceScope,
): readonly EffectStateDependency[] {
  const value = unwrapTransparentExpression(initializer);
  const hookName = ts.isCallExpression(value) ? hookCalleeName(value) : null;
  if (hookName === null) {
    return dependenciesOfNode(value, scope);
  }
  if (isStateHook(hookName, scope.context)) {
    return [{ kind: LEGEND_STATE_HOOKS.has(hookName) ? "legend" : "unresolved", name }];
  }
  if (!ts.isCallExpression(value) || !value.arguments.some(containsFunctionLike)) {
    return [];
  }
  return value.arguments.flatMap((argument) => dependenciesOfNode(argument, scope));
}

function hookCalleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  let name: string | null = null;
  if (ts.isIdentifier(callee)) {
    name = callee.text;
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    name = callee.name.text;
  }
  return name !== null && /^use[A-Z0-9_$]/u.test(name) ? name : null;
}

function isStateHook(hookName: string, context: EffectClassificationContext): boolean {
  const { imports } = context;
  return (
    REACT_STATE_HOOKS.has(hookName) ||
    LEGEND_STATE_HOOKS.has(hookName) ||
    imports.useState.has(hookName) ||
    imports.useValue.has(hookName) ||
    imports.legacyUseValue.has(hookName) ||
    imports.useObservable.has(hookName)
  );
}

function containsFunctionLike(node: ts.Node): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isFunctionLike(candidate)) {
      found = true;
    }
  });
  return found;
}

function withinTypeNode(node: ts.Node, boundary: ts.Node): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (ts.isTypeNode(current)) {
      return true;
    }
  }
  return false;
}

function declaredNamesWithin(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  visit(node, (candidate) => {
    if (ts.isTypeNode(candidate)) {
      return;
    }
    if (ts.isVariableDeclaration(candidate) || ts.isParameter(candidate)) {
      collectBindingNames(candidate.name, names);
    }
    if (
      (ts.isFunctionDeclaration(candidate) ||
        ts.isFunctionExpression(candidate) ||
        ts.isClassDeclaration(candidate) ||
        ts.isClassExpression(candidate)) &&
      candidate.name
    ) {
      names.add(candidate.name.text);
    }
  });
  return names;
}

function referencedValueNames(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  const walk = (candidate: ts.Node): void => {
    if (ts.isTypeNode(candidate) || ts.isTypeParameterDeclaration(candidate)) {
      return;
    }
    if (ts.isIdentifier(candidate) && isValueReference(candidate)) {
      names.add(candidate.text);
    }
    candidate.forEachChild(walk);
  };
  walk(node);
  return names;
}

function isValueReference(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return !(
    isDeclarationName(identifier) ||
    isNonValueIdentifier(identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent) ||
    (ts.isJsxAttribute(parent) && parent.name === identifier) ||
    (ts.isEnumMember(parent) && parent.name === identifier) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === identifier) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === identifier)
  );
}
