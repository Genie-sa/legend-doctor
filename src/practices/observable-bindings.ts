import {
  bindingDeclarationCount,
  isAssignmentOperator,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import {
  expressionIsObservablePath,
  isObservableFactoryCall,
  observablePathWithElementAccess,
  typeNamesObservable,
  typeQueriesObservable,
} from "./observable-paths.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../core/ast.js";
import type { HookImports } from "../core/imports.js";
import type { LegendPracticesRequest } from "./model.js";
import type { ObservableContextReader } from "../project/source-components/observable-contexts.js";
import { declaresObservableProp } from "./observable-prop-types.js";
import { isConstDeclaration } from "../core/binding-references.js";
import { isUseValueCall } from "../rules/observable-reads/observable-paths.js";
import { staticPropertyName } from "../rules/child-contract/declared-prop-types.js";
import ts from "typescript";

interface BindingAlias {
  declaration: ts.Node;
  initializer: ts.Expression;
  name: string;
}

interface BindingTypeQuery {
  declaration: ts.Node;
  name: string;
  type: ts.TypeNode;
}

interface BindingScan {
  aliases: BindingAlias[];
  contextReaders: ReadonlyMap<string, ObservableContextReader>;
  declarations: Map<string, number>;
  factoryBindings: Set<string>;
  factoryCalls: BindingAlias[];
  importedObservables: ReadonlySet<string>;
  imports: HookImports;
  proofs: Map<string, Set<ts.Node>>;
  typeQueries: BindingTypeQuery[];
  useValueInputs: Set<string>;
}

type NamedVariableDeclaration = ts.VariableDeclaration & { name: ts.Identifier };

type NamedParameter = ts.ParameterDeclaration & { name: ts.Identifier };

type NamedBindingElement = ts.BindingElement & { name: ts.Identifier };

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
    request.importedObservableFactories.size === 0 &&
    request.observableContextReaders.size === 0;
  if (lacksObservableSources) {
    return new Set<string>();
  }
  return collectObservableBindings(request, imports);
}

/**
 * A name is an observable binding when every declaration of it in the file is proven observable,
 * so each reference resolves to an observable whichever scope declares it.
 */
function collectObservableBindings(
  request: LegendPracticesRequest,
  imports: HookImports,
): ReadonlySet<string> {
  const scan: BindingScan = {
    aliases: [],
    contextReaders: request.observableContextReaders,
    declarations: new Map(),
    factoryBindings: new Set(request.importedObservableFactories),
    factoryCalls: [],
    importedObservables: request.importedObservables,
    imports,
    proofs: new Map(),
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
    !isUseValueCall(node, scan.imports) ||
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
  if (declaresImportName(node) && node.name) {
    recordImportBinding(node.name, scan);
  } else if (isNamedVariableDeclaration(node)) {
    recordVariableBinding(node, scan);
  } else if (isNamedParameter(node)) {
    recordParameterBinding(node, scan);
  } else if (isNamedBindingElement(node)) {
    recordBindingElement(node, scan);
  } else if (declaresFunctionOrClassName(node) && node.name) {
    recordDeclaration(scan.declarations, node.name.text);
  }
}

function declaresImportName(
  node: ts.Node,
): node is ts.ImportClause | ts.ImportSpecifier | ts.NamespaceImport {
  return ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node);
}

function recordImportBinding(name: ts.Identifier, scan: BindingScan): void {
  recordDeclaration(scan.declarations, name.text);
  if (scan.importedObservables.has(name.text)) {
    proveDeclaration(scan, name.text, name);
  }
}

function declaresFunctionOrClassName(
  node: ts.Node,
): node is
  | ts.ClassDeclaration
  | ts.ClassExpression
  | ts.FunctionDeclaration
  | ts.FunctionExpression {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

function isNamedVariableDeclaration(node: ts.Node): node is NamedVariableDeclaration {
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name);
}

function isNamedParameter(node: ts.Node): node is NamedParameter {
  return ts.isParameter(node) && ts.isIdentifier(node.name);
}

function isNamedBindingElement(node: ts.Node): node is NamedBindingElement {
  return ts.isBindingElement(node) && ts.isIdentifier(node.name);
}

function recordVariableBinding(declaration: NamedVariableDeclaration, scan: BindingScan): void {
  const name = declaration.name.text;
  recordDeclaration(scan.declarations, name);
  recordAnnotatedBinding(declaration, scan);
  if (
    declaration.initializer &&
    isConstDeclaration(declaration) &&
    readsObservableProp(declaration.initializer, name, scan)
  ) {
    proveDeclaration(scan, name, declaration);
  }
  if (declaration.initializer) {
    const alias = { declaration, initializer: declaration.initializer, name };
    scan.factoryCalls.push(alias);
    if (!declaration.type && isConstDeclaration(declaration)) {
      scan.aliases.push(alias);
    }
  }
}

function recordParameterBinding(parameter: NamedParameter, scan: BindingScan): void {
  recordDeclaration(scan.declarations, parameter.name.text);
  recordAnnotatedBinding(parameter, scan);
}

function recordBindingElement(element: NamedBindingElement, scan: BindingScan): void {
  recordDeclaration(scan.declarations, element.name.text);
  if (
    destructuresObservableProp(element, scan.imports.observableTypes) ||
    destructuresObservableSource(element, scan)
  ) {
    proveDeclaration(scan, element.name.text, element);
  }
}

/**
 * `const { value$ } = props` from a typed props parameter, or `const { value$ } = useStore()` from
 * a hook that returns a context value whose declared type holds `value$` as an observable. Only a
 * `const` pattern keeps the binding from being rebound later.
 */
function destructuresObservableSource(element: NamedBindingElement, scan: BindingScan): boolean {
  const pattern = element.parent;
  const declaration = pattern.parent;
  const propName = element.propertyName
    ? staticPropertyName(element.propertyName)
    : element.name.text;
  if (
    element.dotDotDotToken ||
    element.initializer ||
    propName === null ||
    !ts.isObjectBindingPattern(pattern) ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !isConstDeclaration(declaration)
  ) {
    return false;
  }
  const source = unwrapTransparentExpression(declaration.initializer);
  if (ts.isIdentifier(source)) {
    return typedPropsDeclareObservable(source, propName, scan);
  }
  const reader = ts.isCallExpression(source) ? contextHookReader(source, scan) : null;
  return reader !== null && declaresObservableProp(reader.value, propName, reader.observableTypes);
}

/** `props.value$` read from a typed props parameter that declares `value$` observable. */
function readsObservableProp(initializer: ts.Expression, name: string, scan: BindingScan): boolean {
  const read = unwrapTransparentExpression(initializer);
  return (
    ts.isPropertyAccessExpression(read) &&
    !read.questionDotToken &&
    read.name.text === name &&
    ts.isIdentifier(read.expression) &&
    typedPropsDeclareObservable(read.expression, name, scan)
  );
}

/** The props parameter is the only binding of its name in the owner and its type declares the prop. */
function typedPropsDeclareObservable(
  props: ts.Identifier,
  propName: string,
  scan: BindingScan,
): boolean {
  const owner = findAncestor(props, isRuntimeFunctionLike);
  if (!owner) {
    return false;
  }
  const parameter = owner.parameters.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === props.text,
  );
  return (
    parameter?.type !== undefined &&
    !parameter.dotDotDotToken &&
    !parameter.initializer &&
    bindingDeclarationCount(owner, props.text) === 1 &&
    !isAssigned(owner, props.text) &&
    declaresObservableProp(parameter.type, propName, scan.imports.observableTypes)
  );
}

function contextHookReader(
  call: ts.CallExpression,
  scan: BindingScan,
): ObservableContextReader | null {
  const callee = unwrapTransparentExpression(call.expression);
  const reader = ts.isIdentifier(callee) ? scan.contextReaders.get(callee.text) : undefined;
  return reader?.kind === "hook" &&
    ts.isIdentifier(callee) &&
    scan.declarations.get(callee.text) === 1
    ? reader
    : null;
}

function isAssigned(owner: ts.Node, name: string): boolean {
  let assigned = false;
  visit(owner, (node) => {
    assigned ||=
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      isAssignmentOperator(node.operatorToken.kind);
  });
  return assigned;
}

/** `({ value$ }: Props)`: a required, undefaulted prop that the parameter's type declares observable. */
function destructuresObservableProp(
  element: NamedBindingElement,
  observableTypes: ReadonlySet<string>,
): boolean {
  const pattern = element.parent;
  const parameter = pattern.parent;
  if (
    element.dotDotDotToken ||
    element.initializer ||
    !ts.isObjectBindingPattern(pattern) ||
    !ts.isParameter(parameter) ||
    !parameter.type
  ) {
    return false;
  }
  const propName = element.propertyName
    ? staticPropertyName(element.propertyName)
    : element.name.text;
  return propName !== null && declaresObservableProp(parameter.type, propName, observableTypes);
}

function recordAnnotatedBinding(
  declaration: NamedParameter | NamedVariableDeclaration,
  scan: BindingScan,
): void {
  const { name, type } = declaration;
  if (!type) {
    return;
  }
  if (typeNamesObservable(type, scan.imports.observableTypes)) {
    proveDeclaration(scan, name.text, declaration);
  } else {
    scan.typeQueries.push({ declaration, name: name.text, type });
  }
}

function seedCandidates(scan: BindingScan): Set<string> {
  const uniqueFactories = new Set(
    [...scan.factoryBindings].filter((name) => scan.declarations.get(name) === 1),
  );
  for (const candidate of scan.factoryCalls) {
    if (isObservableFactoryCall(candidate.initializer, scan.imports, uniqueFactories)) {
      proveDeclaration(scan, candidate.name, candidate.declaration);
    }
  }
  const candidates = new Set(
    [...scan.importedObservables].filter(
      (path) => path.includes(".") && scan.declarations.get(path.split(".")[0]!) === 1,
    ),
  );
  for (const name of scan.proofs.keys()) {
    addProvenCandidate(scan, candidates, name);
  }
  return candidates;
}

function proveDeclaration(scan: BindingScan, name: string, declaration: ts.Node): void {
  const proofs = scan.proofs.get(name) ?? new Set<ts.Node>();
  proofs.add(declaration);
  scan.proofs.set(name, proofs);
}

function addProvenCandidate(scan: BindingScan, candidates: Set<string>, name: string): boolean {
  if (candidates.has(name) || scan.proofs.get(name)?.size !== scan.declarations.get(name)) {
    return false;
  }
  candidates.add(name);
  return true;
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
  if (candidates.has(alias.name) || scan.proofs.get(alias.name)?.has(alias.declaration)) {
    return false;
  }
  const readsDynamicKey =
    scan.useValueInputs.has(alias.name) &&
    observablePathWithElementAccess(alias.initializer, candidates);
  if (!readsDynamicKey && !expressionIsObservablePath(alias.initializer, candidates)) {
    return false;
  }
  proveDeclaration(scan, alias.name, alias.declaration);
  addProvenCandidate(scan, candidates, alias.name);
  return true;
}

function resolveTypeQueryCandidate(
  query: BindingTypeQuery,
  scan: BindingScan,
  candidates: Set<string>,
): boolean {
  if (
    candidates.has(query.name) ||
    scan.proofs.get(query.name)?.has(query.declaration) ||
    !typeQueriesObservable(query.type, candidates)
  ) {
    return false;
  }
  proveDeclaration(scan, query.name, query.declaration);
  addProvenCandidate(scan, candidates, query.name);
  return true;
}

function recordDeclaration(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}
