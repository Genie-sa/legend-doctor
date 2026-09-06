import {
  expressionIsObservablePath,
  isObservableFactoryCall,
  observablePathWithElementAccess,
  typeNamesObservable,
  typeQueriesObservable,
} from "./observable-paths.js";
import type { HookImports } from "../core/imports.js";
import type { LegendPracticesRequest } from "./model.js";
import { isImportedHookCall } from "../core/imports.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../core/analysis-ast.js";
import { visit } from "../core/ast.js";

interface BindingAlias {
  initializer: ts.Expression;
  name: string;
}

interface BindingTypeQuery {
  name: string;
  type: ts.TypeNode;
}

interface BindingScan {
  aliases: BindingAlias[];
  declarations: Map<string, number>;
  directCandidates: Set<string>;
  factoryBindings: Set<string>;
  factoryCalls: BindingAlias[];
  imports: HookImports;
  typeQueries: BindingTypeQuery[];
  useValueInputs: Set<string>;
}

type NamedVariableDeclaration = ts.VariableDeclaration & { name: ts.Identifier };

type NamedParameter = ts.ParameterDeclaration & { name: ts.Identifier };

export function resolveObservableBindings(
  request: LegendPracticesRequest,
  imports: HookImports,
): ReadonlySet<string> {
  const lacksObservableSources =
    imports.observable.size === 0 &&
    imports.legendNamespaces.size === 0 &&
    imports.useObservable.size === 0 &&
    imports.syncState.size === 0 &&
    imports.useComputed.size === 0 &&
    imports.observableTypes.size === 0 &&
    request.importedObservables.size === 0 &&
    request.importedObservableFactories.size === 0;
  if (lacksObservableSources) {
    return new Set<string>();
  }
  return collectObservableBindings(request, imports);
}

function collectObservableBindings(
  request: LegendPracticesRequest,
  imports: HookImports,
): ReadonlySet<string> {
  const scan: BindingScan = {
    aliases: [],
    declarations: new Map(),
    directCandidates: new Set(request.importedObservables),
    factoryBindings: new Set(request.importedObservableFactories),
    factoryCalls: [],
    imports,
    typeQueries: [],
    useValueInputs: new Set(),
  };
  visit(request.sourceFile, (node) => {
    recordBindingNode(node, scan);
  });
  const candidates = seedCandidates(scan);
  resolveAliasCandidates(scan, candidates);
  return candidates;
}

function recordBindingNode(node: ts.Node, scan: BindingScan): void {
  recordUseValueInput(node, scan);
  recordObservableFactoryDeclaration(node, scan);
  recordDeclaredName(node, scan);
}

function recordUseValueInput(node: ts.Node, scan: BindingScan): void {
  if (
    !ts.isCallExpression(node) ||
    !isImportedHookCall({
      call: node,
      localNames: scan.imports.useValue,
      namespaceNames: scan.imports.legendReactNamespaces,
      canonicalName: "useValue",
    }) ||
    node.arguments.length === 0
  ) {
    return;
  }
  const input = unwrapTransparentExpression(node.arguments[0]!);
  if (ts.isIdentifier(input)) {
    scan.useValueInputs.add(input.text);
  }
}

function recordObservableFactoryDeclaration(node: ts.Node, scan: BindingScan): void {
  if (
    ts.isFunctionDeclaration(node) &&
    node.name &&
    node.type &&
    typeNamesObservable(node.type, scan.imports.observableTypes)
  ) {
    scan.factoryBindings.add(node.name.text);
  }
}

function recordDeclaredName(node: ts.Node, scan: BindingScan): void {
  if (ts.isImportClause(node) && node.name) {
    recordDeclaration(scan.declarations, node.name.text);
  } else if (ts.isImportSpecifier(node)) {
    recordDeclaration(scan.declarations, node.name.text);
  } else if (isNamedVariableDeclaration(node)) {
    recordVariableBinding(node, scan);
  } else if (isNamedParameter(node)) {
    recordParameterBinding(node, scan);
  } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    recordDeclaration(scan.declarations, node.name.text);
  }
}

function isNamedVariableDeclaration(node: ts.Node): node is NamedVariableDeclaration {
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name);
}

function isNamedParameter(node: ts.Node): node is NamedParameter {
  return ts.isParameter(node) && ts.isIdentifier(node.name);
}

function recordVariableBinding(declaration: NamedVariableDeclaration, scan: BindingScan): void {
  const name = declaration.name.text;
  recordDeclaration(scan.declarations, name);
  recordAnnotatedBinding(declaration.type, name, scan);
  if (declaration.initializer) {
    scan.factoryCalls.push({ initializer: declaration.initializer, name });
    if (!declaration.type && declarationIsConst(declaration)) {
      scan.aliases.push({ initializer: declaration.initializer, name });
    }
  }
}

function recordParameterBinding(parameter: NamedParameter, scan: BindingScan): void {
  const name = parameter.name.text;
  recordDeclaration(scan.declarations, name);
  recordAnnotatedBinding(parameter.type, name, scan);
}

function recordAnnotatedBinding(
  type: ts.TypeNode | undefined,
  name: string,
  scan: BindingScan,
): void {
  if (!type) {
    return;
  }
  if (typeNamesObservable(type, scan.imports.observableTypes)) {
    scan.directCandidates.add(name);
  } else {
    scan.typeQueries.push({ name, type });
  }
}

function seedCandidates(scan: BindingScan): Set<string> {
  const uniqueFactories = new Set(
    [...scan.factoryBindings].filter((name) => scan.declarations.get(name) === 1),
  );
  const candidates = new Set(
    [...scan.directCandidates].filter((name) => scan.declarations.get(name.split(".")[0]!) === 1),
  );
  for (const candidate of scan.factoryCalls) {
    if (
      scan.declarations.get(candidate.name) === 1 &&
      isObservableFactoryCall(candidate.initializer, scan.imports, uniqueFactories)
    ) {
      candidates.add(candidate.name);
    }
  }
  return candidates;
}

function resolveAliasCandidates(scan: BindingScan, candidates: Set<string>): void {
  let changed = true;
  while (changed) {
    changed = resolveCandidatePass(scan, candidates);
  }
}

function resolveCandidatePass(scan: BindingScan, candidates: Set<string>): boolean {
  let changed = false;
  for (const alias of scan.aliases) {
    changed = resolveAliasCandidate(alias, scan, candidates) || changed;
  }
  for (const query of scan.typeQueries) {
    changed = resolveTypeQueryCandidate(query, scan, candidates) || changed;
  }
  return changed;
}

function resolveAliasCandidate(
  alias: BindingAlias,
  scan: BindingScan,
  candidates: Set<string>,
): boolean {
  if (scan.declarations.get(alias.name) !== 1 || candidates.has(alias.name)) {
    return false;
  }
  const readsDynamicKey =
    scan.useValueInputs.has(alias.name) &&
    observablePathWithElementAccess(alias.initializer, candidates);
  if (readsDynamicKey || expressionIsObservablePath(alias.initializer, candidates)) {
    candidates.add(alias.name);
    return true;
  }
  return false;
}

function resolveTypeQueryCandidate(
  query: BindingTypeQuery,
  scan: BindingScan,
  candidates: Set<string>,
): boolean {
  if (scan.declarations.get(query.name) !== 1 || candidates.has(query.name)) {
    return false;
  }
  if (!typeQueriesObservable(query.type, candidates)) {
    return false;
  }
  candidates.add(query.name);
  return true;
}

function recordDeclaration(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function declarationIsConst(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}
