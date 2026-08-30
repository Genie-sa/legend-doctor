import {
  RESERVED_OBSERVABLE_MEMBERS,
  findObservableReadPractices,
} from "./rules/observable-reads.js";
import { collectHookImports, isImportedHookCall } from "./imports.js";
import {
  containsElementAccess,
  exactObjectLiteralKeys,
  isEvaluationInert,
  propertyPathHasBinding,
  rootIdentifier,
  staticPathHasBinding,
  unwrapTransparentExpression,
} from "./analysis-ast.js";
import { isNonProductionHarness, visit } from "./ast.js";
import type { AnalysisFile } from "./analysis-project.js";
import type { ChildContractResolver } from "./rules/child-contract.js";
import type { HookImports } from "./imports.js";
import type { InstalledLegendState } from "./legend-state-package.js";
import type { LegendPracticeFinding } from "./types.js";
import { findLegacyUseValuePractices } from "./rules/legacy-use-value.js";
import { findObservableCloneWritePractices } from "./rules/observable-clone-writes.js";
import { findObservableTogglePractices } from "./rules/observable-toggle.js";
import ts from "typescript";

const MINIMUM_BATCH_WRITES = 2;

interface ObservableWrite {
  argument: ts.Expression;
  call: ts.CallExpression;
  parentPath: string | null;
  path: string;
  property: string | null;
  root: string;
}

interface LegendPracticesRequest {
  childContracts: ChildContractResolver | null;
  fileName: string;
  importedObservableFactories: ReadonlySet<string>;
  importedObservableKeys: ReadonlyMap<string, ReadonlySet<string>>;
  importedObservables: ReadonlySet<string>;
  installedLegendState: InstalledLegendState | null;
  reactCompilerPackage: boolean;
  sourceFile: ts.SourceFile;
}

interface TransactionScan {
  fileName: string;
  imports: HookImports;
  observableBindings: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
}

interface TransactionRun {
  conditionalWrites: ObservableWrite[];
  writes: ObservableWrite[];
}

interface RunAccumulator extends TransactionRun {
  findings: LegendPracticeFinding[];
  isComplete: boolean;
}

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

interface SetCall {
  argument: ts.Expression;
  call: ts.CallExpression;
  receiver: ts.Expression;
}

type NamedVariableDeclaration = ts.VariableDeclaration & { name: ts.Identifier };
type NamedParameter = ts.ParameterDeclaration & { name: ts.Identifier };

export function analyzeLegendPractices(
  sourceText: string,
  fileName: string,
  importedObservables: ReadonlySet<string> = new Set(),
  importedObservableFactories: ReadonlySet<string> = new Set(),
  installedLegendState: InstalledLegendState | null = null,
  importedObservableKeys: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): LegendPracticeFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return analyzeParsedLegendPractices({
    childContracts: null,
    fileName,
    importedObservableFactories,
    importedObservableKeys,
    importedObservables,
    installedLegendState,
    reactCompilerPackage: false,
    sourceFile,
  });
}

export function analyzeLegendPracticesFile(
  file: AnalysisFile,
  reportFileName: string,
  importedObservables: ReadonlySet<string> = new Set(),
  importedObservableFactories: ReadonlySet<string> = new Set(),
  includeFindings = true,
  installedLegendState: InstalledLegendState | null = null,
  importedObservableKeys: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  childContracts: ChildContractResolver | null = null,
  reactCompilerPackage = false,
): LegendPracticeFinding[] {
  const findings = analyzeParsedLegendPractices({
    childContracts,
    fileName: reportFileName,
    importedObservableFactories,
    importedObservableKeys,
    importedObservables,
    installedLegendState,
    reactCompilerPackage,
    sourceFile: file.sourceFile,
  });
  return includeFindings ? findings : [];
}

function analyzeParsedLegendPractices(request: LegendPracticesRequest): LegendPracticeFinding[] {
  const { fileName, sourceFile } = request;
  if (isNonProductionHarness(fileName)) {
    return [];
  }
  const imports = collectHookImports(sourceFile);
  const observableBindings = resolveObservableBindings(request, imports);
  const legacyFindings = findLegacyUseValuePractices(
    sourceFile,
    fileName,
    imports,
    observableBindings,
    request.installedLegendState,
  );
  if (observableBindings.size === 0) {
    return [...legacyFindings];
  }
  return [
    ...legacyFindings,
    ...collectTransactionFindings({ fileName, imports, observableBindings, sourceFile }),
    ...collectMemberFindings(request, imports, observableBindings),
  ].toSorted(compareFindingLocation);
}

function compareFindingLocation(left: LegendPracticeFinding, right: LegendPracticeFinding): number {
  return left.location.line - right.location.line || left.location.column - right.location.column;
}

function collectMemberFindings(
  request: LegendPracticesRequest,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): LegendPracticeFinding[] {
  const { childContracts, fileName, sourceFile } = request;
  const observableKeys = collectObservableKeys(request, imports, observableBindings);
  const findings = [
    ...findObservableReadPractices(
      sourceFile,
      fileName,
      imports,
      observableBindings,
      observableKeys,
      childContracts,
    ),
  ];
  if (!request.reactCompilerPackage) {
    findings.push(...findObservableCloneWritePractices(sourceFile, fileName, observableBindings));
  }
  findings.push(...findObservableTogglePractices(sourceFile, fileName, observableBindings));
  return findings;
}

function collectObservableKeys(
  request: LegendPracticesRequest,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const keys = new Map(request.importedObservableKeys);
  visit(request.sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !observableBindings.has(node.name.text)
    ) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    if (
      !ts.isCallExpression(initializer) ||
      !isObservableFactoryCall(initializer, imports, request.importedObservableFactories) ||
      !initializer.arguments[0]
    ) {
      return;
    }
    const objectKeys = exactObjectLiteralKeys(initializer.arguments[0]);
    if (objectKeys) {
      keys.set(node.name.text, objectKeys);
    }
  });
  return keys;
}

function collectTransactionFindings(scan: TransactionScan): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      findings.push(...blockTransactionFindings(node, scan));
    }
  });
  return findings;
}

function blockTransactionFindings(
  block: ts.Block | ts.SourceFile,
  scan: TransactionScan,
): LegendPracticeFinding[] {
  const accumulator: RunAccumulator = {
    conditionalWrites: [],
    findings: [],
    isComplete: true,
    writes: [],
  };
  for (const statement of block.statements) {
    applyStatementToRun(accumulator, statement, scan);
  }
  flushRun(accumulator, scan);
  return accumulator.findings;
}

function applyStatementToRun(
  accumulator: RunAccumulator,
  statement: ts.Statement,
  scan: TransactionScan,
): void {
  const write = unbatchedWrite(statement, scan);
  const branchWrites = conditionalObservableWrites(statement, scan);
  if (write) {
    accumulator.writes.push(write);
  } else if (branchWrites && continuesRun(accumulator.writes, branchWrites)) {
    accumulator.conditionalWrites.push(...branchWrites);
  } else if (isSetStatement(statement)) {
    accumulator.isComplete = false;
  } else {
    flushRun(accumulator, scan);
  }
}

function unbatchedWrite(statement: ts.Statement, scan: TransactionScan): ObservableWrite | null {
  const write = observableWrite(statement, scan.observableBindings, scan.sourceFile);
  return write && !isInsideBatch(write.call, scan.imports) ? write : null;
}

function continuesRun(
  writes: readonly ObservableWrite[],
  branchWrites: readonly ObservableWrite[],
): boolean {
  return (
    writes.length > 0 &&
    branchWrites.every((branchWrite) => writes.some((member) => member.root === branchWrite.root))
  );
}

function flushRun(accumulator: RunAccumulator, scan: TransactionScan): void {
  if (accumulator.isComplete && accumulator.writes.length >= MINIMUM_BATCH_WRITES) {
    const finding = transactionFinding(accumulator, scan);
    if (finding) {
      accumulator.findings.push(finding);
    }
  }
  accumulator.writes = [];
  accumulator.conditionalWrites = [];
  accumulator.isComplete = true;
}

function isSetStatement(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement)) {
    return false;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "set"
  );
}

function resolveObservableBindings(
  request: LegendPracticesRequest,
  imports: HookImports,
): ReadonlySet<string> {
  const lacksObservableSources =
    imports.observable.size === 0 &&
    imports.useObservable.size === 0 &&
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
    !isImportedHookCall(
      node,
      scan.imports.useValue,
      scan.imports.legendReactNamespaces,
      "useValue",
    ) ||
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

function observablePathWithElementAccess(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): boolean {
  let current = unwrapTransparentExpression(expression);
  let hasDynamicKey = false;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (current.questionDotToken || accessesReservedMember(current)) {
      return false;
    }
    hasDynamicKey ||= ts.isElementAccessExpression(current);
    current = unwrapTransparentExpression(current.expression);
  }
  return hasDynamicKey && ts.isIdentifier(current) && observableBindings.has(current.text);
}

function accessesReservedMember(
  access: ts.ElementAccessExpression | ts.PropertyAccessExpression,
): boolean {
  if (ts.isPropertyAccessExpression(access)) {
    return RESERVED_OBSERVABLE_MEMBERS.has(access.name.text);
  }
  if (!access.argumentExpression) {
    return true;
  }
  const member = unwrapTransparentExpression(access.argumentExpression);
  return ts.isStringLiteralLike(member) && RESERVED_OBSERVABLE_MEMBERS.has(member.text);
}

function recordDeclaration(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function isObservableFactoryCall(
  expression: ts.Expression,
  imports: HookImports,
  projectFactories: ReadonlySet<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  if (ts.isIdentifier(value.expression)) {
    return (
      imports.observable.has(value.expression.text) ||
      imports.useObservable.has(value.expression.text) ||
      projectFactories.has(value.expression.text)
    );
  }
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    imports.legendNamespaces.has(value.expression.expression.text) &&
    value.expression.name.text === "observable"
  );
}

function declarationIsConst(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function expressionIsObservablePath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) {
    return false;
  }
  for (
    let current: ts.Expression = value;
    ts.isPropertyAccessExpression(current);
    current = current.expression
  ) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) {
      return false;
    }
  }
  return staticPathHasBinding(value, observableBindings);
}

function typeQueriesObservable(
  type: ts.TypeNode,
  observableBindings: ReadonlySet<string>,
): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return typeQueriesObservable(type.type, observableBindings);
  }
  if (!ts.isTypeQueryNode(type)) {
    return false;
  }
  const path = unreservedEntityNamePath(type.exprName);
  return path !== null && propertyPathHasBinding(path, observableBindings);
}

function unreservedEntityNamePath(exprName: ts.EntityName): string[] | null {
  const path: string[] = [];
  let current: ts.EntityName = exprName;
  while (ts.isQualifiedName(current)) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(current.right.text)) {
      return null;
    }
    path.unshift(current.right.text);
    current = current.left;
  }
  path.unshift(current.text);
  return path;
}

function typeNamesObservable(type: ts.TypeNode, names: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return typeNamesObservable(type.type, names);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.some((member) => typeNamesObservable(member, names));
  }
  return (
    ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && names.has(type.typeName.text)
  );
}

function setCallStatement(statement: ts.Statement): SetCall | null {
  if (!ts.isExpressionStatement(statement)) {
    return null;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return null;
  }
  const [argument] = expression.arguments;
  if (
    expression.expression.name.text !== "set" ||
    expression.arguments.length !== 1 ||
    !argument ||
    containsAwaitOrYield(argument)
  ) {
    return null;
  }
  return { argument, call: expression, receiver: expression.expression.expression };
}

function observableWrite(
  statement: ts.Statement,
  observableBindings: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
): ObservableWrite | null {
  const setCall = setCallStatement(statement);
  if (!setCall || containsElementAccess(setCall.receiver)) {
    return null;
  }
  const { receiver } = setCall;
  const root = rootIdentifier(receiver);
  if (!root || !expressionIsObservablePath(receiver, observableBindings)) {
    return null;
  }
  const field = ts.isPropertyAccessExpression(receiver) ? receiver : null;
  return {
    argument: setCall.argument,
    call: setCall.call,
    parentPath: field ? field.expression.getText(sourceFile) : null,
    path: receiver.getText(sourceFile),
    property: field?.name.text ?? null,
    root: root.text,
  };
}

function containsAwaitOrYield(node: ts.Node): boolean {
  let found = false;
  visit(node, (current) => {
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) {
      found = true;
    }
  });
  return found;
}

function isInsideBatch(call: ts.CallExpression, imports: HookImports): boolean {
  for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) {
      continue;
    }
    const { expression } = current;
    if (ts.isIdentifier(expression) && imports.batch.has(expression.text)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      imports.legendNamespaces.has(expression.expression.text) &&
      expression.name.text === "batch"
    ) {
      return true;
    }
  }
  return false;
}

function hasDistinctNonOverlappingPaths(writes: readonly ObservableWrite[]): boolean {
  const paths = writes.map((write) => write.path);
  if (new Set(paths).size !== paths.length) {
    return false;
  }
  return paths.every((path, index) =>
    paths.every((other, otherIndex) => {
      if (index === otherIndex) {
        return true;
      }
      return !path.startsWith(`${other}.`) && !other.startsWith(`${path}.`);
    }),
  );
}

function conditionalObservableWrites(
  statement: ts.Statement,
  scan: TransactionScan,
): ObservableWrite[] | null {
  if (!ts.isIfStatement(statement) || !isEvaluationInert(statement.expression)) {
    return null;
  }
  const branches = [
    statement.thenStatement,
    ...(statement.elseStatement ? [statement.elseStatement] : []),
  ];
  const writes: ObservableWrite[] = [];
  for (const branch of branches) {
    const branchWrites = branchObservableWrites(branch, scan);
    if (!branchWrites) {
      return null;
    }
    writes.push(...branchWrites);
  }
  return writes.length > 0 ? writes : null;
}

function branchObservableWrites(
  branch: ts.Statement,
  scan: TransactionScan,
): ObservableWrite[] | null {
  const statements = ts.isBlock(branch) ? branch.statements : [branch];
  const writes: ObservableWrite[] = [];
  for (const statement of statements) {
    const write = unbatchedWrite(statement, scan);
    if (!write) {
      return null;
    }
    writes.push(write);
  }
  return writes;
}

function writeLocation(
  write: ObservableWrite,
  scan: TransactionScan,
): LegendPracticeFinding["location"] {
  const { character, line } = scan.sourceFile.getLineAndCharacterOfPosition(
    write.call.getStart(scan.sourceFile),
  );
  return { column: character + 1, file: scan.fileName, line: line + 1 };
}

function transactionFinding(
  run: TransactionRun,
  scan: TransactionScan,
): LegendPracticeFinding | null {
  const { conditionalWrites, writes } = run;
  if (conditionalWrites.length > 0) {
    return hasDistinctNonOverlappingPaths([...writes, ...conditionalWrites])
      ? conditionalBatchFinding(run, scan)
      : null;
  }
  if (!hasDistinctNonOverlappingPaths(writes)) {
    return null;
  }
  const location = writeLocation(writes[0]!, scan);
  const assignTarget = commonAssignTarget(writes);
  if (assignTarget) {
    return assignFieldsFinding(writes, assignTarget, location);
  }
  return batchWritesFinding(writes, location);
}

function assignFieldsFinding(
  writes: readonly ObservableWrite[],
  assignTarget: string,
  location: LegendPracticeFinding["location"],
): LegendPracticeFinding {
  const fields = writes.map((write) => `\`${write.property}\``).join(", ");
  return {
    action: "assign-observable-fields",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${writes.length} consecutive writes target direct fields of ${assignTarget}`,
      "each value is independent of the updated observable and no control-flow boundary splits the writes",
    ],
    location,
    message: `Replace ${writes.length} \`.set()\` calls with one \`${assignTarget}.assign(...)\` for ${fields}; observers publish once.`,
    practice: "assign",
  };
}

function batchWritesFinding(
  writes: readonly ObservableWrite[],
  location: LegendPracticeFinding["location"],
): LegendPracticeFinding {
  return {
    action: "batch-observable-writes",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${writes.length} consecutive writes target distinct proven Legend observable paths`,
      "no await, yield, control-flow boundary, or existing batch surrounds the writes",
    ],
    location,
    message: `Wrap these ${writes.length} consecutive Legend observable writes in \`batch(() => { ... })\` so observers publish the transaction once.`,
    practice: "batch",
  };
}

function conditionalBatchFinding(
  run: TransactionRun,
  scan: TransactionScan,
): LegendPracticeFinding {
  const { conditionalWrites, writes } = run;
  const assignTarget = commonAssignTarget(writes);
  const conditionalPaths = conditionalWrites.map((write) => `\`${write.path}\``).join(", ");
  const assignHint = assignTarget
    ? ` inside the batch, one \`${assignTarget}.assign(...)\` can replace the unconditional field writes;`
    : "";
  return {
    action: "batch-observable-writes",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${writes.length} consecutive writes and a conditional write to ${conditionalPaths} target the same proven Legend observable`,
      "replacing only the unconditional writes would still let the conditional write publish a separate, torn transaction",
    ],
    location: writeLocation(writes[0]!, scan),
    message: `Wrap these ${writes.length} \`.set()\` calls and the conditional write to ${conditionalPaths} in one \`batch(() => { ... })\`;${assignHint} observers publish the transaction once.`,
    practice: "batch",
  };
}

function commonAssignTarget(writes: readonly ObservableWrite[]): string | null {
  const target = writes[0]?.parentPath;
  if (
    !target ||
    writes.some(
      (write) =>
        write.parentPath !== target ||
        write.property === null ||
        ts.isArrowFunction(write.argument) ||
        ts.isFunctionExpression(write.argument) ||
        !isEvaluationInert(write.argument) ||
        expressionReferencesIdentifier(write.argument, write.root),
    )
  ) {
    return null;
  }
  return target;
}

function expressionReferencesIdentifier(expression: ts.Expression, name: string): boolean {
  let found = false;
  visit(expression, (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
    }
  });
  return found;
}
