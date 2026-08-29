import ts from "typescript";

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
import { collectHookImports, isImportedHookCall, type HookImports } from "./imports.js";
import type { AnalysisFile } from "./analysis-project.js";
import type { InstalledLegendState } from "./legend-state-package.js";
import type { ChildContractResolver } from "./rules/child-contract.js";
import { findLegacyUseValuePractices } from "./rules/legacy-use-value.js";
import { findObservableCloneWritePractices } from "./rules/observable-clone-writes.js";
import {
  findObservableReadPractices,
  RESERVED_OBSERVABLE_MEMBERS,
} from "./rules/observable-reads.js";
import { findObservableTogglePractices } from "./rules/observable-toggle.js";
import type { LegendPracticeFinding } from "./types.js";

interface ObservableWrite {
  argument: ts.Expression;
  call: ts.CallExpression;
  parentPath: string | null;
  path: string;
  property: string | null;
  root: string;
}

export function analyzeLegendPractices(
  sourceText: string,
  fileName: string,
  importedObservables: ReadonlySet<string> = new Set(),
  importedObservableFactories: ReadonlySet<string> = new Set(),
  installedLegendState: InstalledLegendState | null = null,
  importedObservableKeys: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): LegendPracticeFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
  );
  return analyzeParsedLegendPractices(
    sourceFile,
    fileName,
    importedObservables,
    importedObservableFactories,
    installedLegendState,
    importedObservableKeys,
    null
  );
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
  reactCompilerPackage = false
): LegendPracticeFinding[] {
  const findings = analyzeParsedLegendPractices(
    file.sourceFile,
    reportFileName,
    importedObservables,
    importedObservableFactories,
    installedLegendState,
    importedObservableKeys,
    childContracts,
    reactCompilerPackage
  );
  return includeFindings ? findings : [];
}

function analyzeParsedLegendPractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  importedObservables: ReadonlySet<string>,
  importedObservableFactories: ReadonlySet<string>,
  installedLegendState: InstalledLegendState | null,
  importedObservableKeys: ReadonlyMap<string, ReadonlySet<string>>,
  childContracts: ChildContractResolver | null,
  reactCompilerPackage = false
): LegendPracticeFinding[] {
  if (isNonProductionHarness(fileName)) return [];
  const imports = collectHookImports(sourceFile);
  const lacksObservableSources =
    imports.observable.size === 0 &&
    imports.useObservable.size === 0 &&
    imports.observableTypes.size === 0 &&
    importedObservables.size === 0 &&
    importedObservableFactories.size === 0;
  const observableBindings = lacksObservableSources
    ? new Set<string>()
    : collectObservableBindings(sourceFile, imports, importedObservables, importedObservableFactories);
  const findings = [
    ...findLegacyUseValuePractices(
      sourceFile,
      fileName,
      imports,
      observableBindings,
      installedLegendState
    ),
  ];
  if (lacksObservableSources) return findings;
  if (observableBindings.size === 0) return findings;
  const observableKeys = collectObservableKeys(
    sourceFile,
    imports,
    observableBindings,
    importedObservableFactories,
    importedObservableKeys
  );

  visit(sourceFile, node => {
    if (!ts.isBlock(node) && !ts.isSourceFile(node)) return;
    let run: ObservableWrite[] = [];
    let conditionalWrites: ObservableWrite[] = [];
    let runIsComplete = true;
    const flush = (): void => {
      if (runIsComplete && run.length >= 2) {
        const finding = transactionFinding(run, conditionalWrites, sourceFile, fileName);
        if (finding) findings.push(finding);
      }
      run = [];
      conditionalWrites = [];
      runIsComplete = true;
    };

    for (const statement of node.statements) {
      const write = observableWrite(statement, observableBindings, sourceFile);
      if (write && !isInsideBatch(write.call, imports)) {
        run.push(write);
        continue;
      }
      const branchWrites = conditionalObservableWrites(statement, observableBindings, sourceFile, imports);
      if (
        branchWrites &&
        run.length > 0 &&
        branchWrites.every(branchWrite => run.some(member => member.root === branchWrite.root))
      ) {
        conditionalWrites.push(...branchWrites);
        continue;
      }
      if (isSetStatement(statement)) {
        runIsComplete = false;
      } else {
        flush();
      }
    }
    flush();
  });

  findings.push(...findObservableReadPractices(
    sourceFile,
    fileName,
    imports,
    observableBindings,
    observableKeys,
    childContracts
  ));
  if (!reactCompilerPackage) {
    findings.push(...findObservableCloneWritePractices(sourceFile, fileName, observableBindings));
  }
  findings.push(...findObservableTogglePractices(sourceFile, fileName, observableBindings));

  return findings.sort(
    (left, right) =>
      left.location.line - right.location.line || left.location.column - right.location.column
  );
}

function collectObservableKeys(
  sourceFile: ts.SourceFile,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  importedObservableFactories: ReadonlySet<string>,
  importedObservableKeys: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<string, ReadonlySet<string>> {
  const keys = new Map(importedObservableKeys);
  visit(sourceFile, node => {
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
      !isObservableFactoryCall(initializer, imports, importedObservableFactories) ||
      !initializer.arguments[0]
    ) {
      return;
    }
    const objectKeys = exactObjectLiteralKeys(initializer.arguments[0]);
    if (objectKeys) keys.set(node.name.text, objectKeys);
  });
  return keys;
}

function isSetStatement(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = unwrapTransparentExpression(statement.expression);
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "set"
  );
}

function collectObservableBindings(
  sourceFile: ts.SourceFile,
  imports: HookImports,
  importedObservables: ReadonlySet<string>,
  importedObservableFactories: ReadonlySet<string>
): ReadonlySet<string> {
  const declarations = new Map<string, number>();
  const directCandidates = new Set(importedObservables);
  const factoryBindings = new Set(importedObservableFactories);
  const aliases: Array<{ initializer: ts.Expression; name: string }> = [];
  const factoryCalls: Array<{ initializer: ts.Expression; name: string }> = [];
  const useValueInputs = new Set<string>();
  const typeQueries: Array<{ name: string; type: ts.TypeNode }> = [];

  visit(sourceFile, node => {
    if (
      ts.isCallExpression(node) &&
      isImportedHookCall(
        node,
        imports.useValue,
        imports.legendReactNamespaces,
        "useValue"
      ) &&
      node.arguments.length > 0
    ) {
      const input = unwrapTransparentExpression(node.arguments[0]!);
      if (ts.isIdentifier(input)) useValueInputs.add(input.text);
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.type &&
      typeNamesObservable(node.type, imports.observableTypes)
    ) {
      factoryBindings.add(node.name.text);
    }
    if (ts.isImportClause(node) && node.name) {
      recordDeclaration(declarations, node.name.text);
      return;
    }
    if (ts.isImportSpecifier(node)) {
      recordDeclaration(declarations, node.name.text);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      recordDeclaration(declarations, node.name.text);
      if (node.type && typeNamesObservable(node.type, imports.observableTypes)) {
        directCandidates.add(node.name.text);
      } else if (node.type) {
        typeQueries.push({ name: node.name.text, type: node.type });
      }
      if (node.initializer) {
        factoryCalls.push({ initializer: node.initializer, name: node.name.text });
      }
      if (!node.type && node.initializer && declarationIsConst(node)) {
        aliases.push({ initializer: node.initializer, name: node.name.text });
      }
      return;
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      recordDeclaration(declarations, node.name.text);
      if (node.type && typeNamesObservable(node.type, imports.observableTypes)) {
        directCandidates.add(node.name.text);
      } else if (node.type) {
        typeQueries.push({ name: node.name.text, type: node.type });
      }
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      recordDeclaration(declarations, node.name.text);
    }
  });

  const uniqueFactories = new Set(
    [...factoryBindings].filter(name => declarations.get(name) === 1)
  );
  const candidates = new Set(
    [...directCandidates].filter(name => declarations.get(name.split(".")[0]!) === 1)
  );
  for (const candidate of factoryCalls) {
    if (
      declarations.get(candidate.name) === 1 &&
      isObservableFactoryCall(candidate.initializer, imports, uniqueFactories)
    ) {
      candidates.add(candidate.name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      if (
        useValueInputs.has(alias.name) &&
        declarations.get(alias.name) === 1 &&
        !candidates.has(alias.name) &&
        observablePathWithElementAccess(alias.initializer, candidates)
      ) {
        candidates.add(alias.name);
        changed = true;
        continue;
      }
      if (
        declarations.get(alias.name) === 1 &&
        !candidates.has(alias.name) &&
        expressionIsObservablePath(alias.initializer, candidates)
      ) {
        candidates.add(alias.name);
        changed = true;
      }
    }
    for (const alias of typeQueries) {
      if (
        declarations.get(alias.name) === 1 &&
        !candidates.has(alias.name) &&
        typeQueriesObservable(alias.type, candidates)
      ) {
        candidates.add(alias.name);
        changed = true;
      }
    }
  }
  return candidates;
}

function observablePathWithElementAccess(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>
): boolean {
  let current = unwrapTransparentExpression(expression);
  let hasDynamicKey = false;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (current.questionDotToken) return false;
    if (ts.isPropertyAccessExpression(current)) {
      if (RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) return false;
    } else {
      if (!current.argumentExpression) return false;
      const member = unwrapTransparentExpression(current.argumentExpression);
      if (ts.isStringLiteralLike(member) && RESERVED_OBSERVABLE_MEMBERS.has(member.text)) {
        return false;
      }
      hasDynamicKey = true;
    }
    current = unwrapTransparentExpression(current.expression);
  }
  return hasDynamicKey && ts.isIdentifier(current) && observableBindings.has(current.text);
}

function recordDeclaration(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function isObservableFactoryCall(
  expression: ts.Expression,
  imports: HookImports,
  projectFactories: ReadonlySet<string>
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) return false;
  if (ts.isIdentifier(value.expression)) {
    return imports.observable.has(value.expression.text) ||
      imports.useObservable.has(value.expression.text) ||
      projectFactories.has(value.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    imports.legendNamespaces.has(value.expression.expression.text) &&
    value.expression.name.text === "observable"
  );
}

function declarationIsConst(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function expressionIsObservablePath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) return false;
  for (let current: ts.Expression = value; ts.isPropertyAccessExpression(current); current = current.expression) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) return false;
  }
  return staticPathHasBinding(value, observableBindings);
}

function typeQueriesObservable(
  type: ts.TypeNode,
  observableBindings: ReadonlySet<string>
): boolean {
  if (ts.isParenthesizedTypeNode(type)) return typeQueriesObservable(type.type, observableBindings);
  if (!ts.isTypeQueryNode(type)) return false;
  const path: string[] = [];
  let current: ts.EntityName = type.exprName;
  while (ts.isQualifiedName(current)) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(current.right.text)) return false;
    path.unshift(current.right.text);
    current = current.left;
  }
  path.unshift(current.text);
  return propertyPathHasBinding(path, observableBindings);
}

function typeNamesObservable(type: ts.TypeNode, names: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedTypeNode(type)) return typeNamesObservable(type.type, names);
  if (ts.isUnionTypeNode(type)) {
    return type.types.some(member => typeNamesObservable(member, names));
  }
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    names.has(type.typeName.text)
  );
}

function observableWrite(
  statement: ts.Statement,
  observableBindings: ReadonlySet<string>,
  sourceFile: ts.SourceFile
): ObservableWrite | null {
  if (!ts.isExpressionStatement(statement)) return null;
  const expression = unwrapTransparentExpression(statement.expression);
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "set" ||
    expression.arguments.length !== 1 ||
    containsAwaitOrYield(expression.arguments[0]!)
  ) {
    return null;
  }
  const receiver = expression.expression.expression;
  if (containsElementAccess(receiver)) return null;
  const root = rootIdentifier(receiver);
  if (!root || !expressionIsObservablePath(receiver, observableBindings)) return null;
  const field = ts.isPropertyAccessExpression(receiver) ? receiver : null;
  return {
    argument: expression.arguments[0]!,
    call: expression,
    parentPath: field ? field.expression.getText(sourceFile) : null,
    path: receiver.getText(sourceFile),
    property: field?.name.text ?? null,
    root: root.text,
  };
}

function containsAwaitOrYield(node: ts.Node): boolean {
  let found = false;
  visit(node, current => {
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) found = true;
  });
  return found;
}

function isInsideBatch(call: ts.CallExpression, imports: HookImports): boolean {
  for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    const expression = current.expression;
    if (ts.isIdentifier(expression) && imports.batch.has(expression.text)) return true;
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
  const paths = writes.map(write => write.path);
  if (new Set(paths).size !== paths.length) return false;
  return paths.every((path, index) =>
    paths.every((other, otherIndex) => {
      if (index === otherIndex) return true;
      return !path.startsWith(`${other}.`) && !other.startsWith(`${path}.`);
    })
  );
}

function conditionalObservableWrites(
  statement: ts.Statement,
  observableBindings: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
  imports: HookImports
): ObservableWrite[] | null {
  if (!ts.isIfStatement(statement) || !isEvaluationInert(statement.expression)) return null;
  const branches = [
    statement.thenStatement,
    ...(statement.elseStatement ? [statement.elseStatement] : []),
  ];
  const writes: ObservableWrite[] = [];
  for (const branch of branches) {
    const statements = ts.isBlock(branch) ? branch.statements : [branch];
    for (const branchStatement of statements) {
      const write = observableWrite(branchStatement, observableBindings, sourceFile);
      if (!write || isInsideBatch(write.call, imports)) return null;
      writes.push(write);
    }
  }
  return writes.length > 0 ? writes : null;
}

function transactionFinding(
  writes: readonly ObservableWrite[],
  conditionalWrites: readonly ObservableWrite[],
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding | null {
  if (conditionalWrites.length > 0) {
    return hasDistinctNonOverlappingPaths([...writes, ...conditionalWrites])
      ? conditionalBatchFinding(writes, conditionalWrites, sourceFile, fileName)
      : null;
  }
  if (!hasDistinctNonOverlappingPaths(writes)) return null;
  const first = writes[0]!;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.call.getStart(sourceFile));
  const assignTarget = commonAssignTarget(writes);
  if (assignTarget) {
    const fields = writes.map(write => `\`${write.property}\``).join(", ");
    return {
      action: "assign-observable-fields",
      confidence: "probable",
      disposition: "change",
      evidence: [
        `${writes.length} consecutive writes target direct fields of ${assignTarget}`,
        "each value is independent of the updated observable and no control-flow boundary splits the writes",
      ],
      location: { column: character + 1, file: fileName, line: line + 1 },
      message: `Replace ${writes.length} \`.set()\` calls with one \`${assignTarget}.assign(...)\` for ${fields}; observers publish once.`,
      practice: "assign",
    };
  }
  return {
    action: "batch-observable-writes",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${writes.length} consecutive writes target distinct proven Legend observable paths`,
      "no await, yield, control-flow boundary, or existing batch surrounds the writes",
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Wrap these ${writes.length} consecutive Legend observable writes in \`batch(() => { ... })\` so observers publish the transaction once.`,
    practice: "batch",
  };
}

function conditionalBatchFinding(
  writes: readonly ObservableWrite[],
  conditionalWrites: readonly ObservableWrite[],
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding {
  const first = writes[0]!;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.call.getStart(sourceFile));
  const assignTarget = commonAssignTarget(writes);
  const conditionalPaths = conditionalWrites.map(write => `\`${write.path}\``).join(", ");
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
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Wrap these ${writes.length} \`.set()\` calls and the conditional write to ${conditionalPaths} in one \`batch(() => { ... })\`;${assignHint} observers publish the transaction once.`,
    practice: "batch",
  };
}

function commonAssignTarget(writes: readonly ObservableWrite[]): string | null {
  const target = writes[0]?.parentPath;
  if (
    !target ||
    writes.some(write =>
      write.parentPath !== target ||
      write.property === null ||
      ts.isArrowFunction(write.argument) ||
      ts.isFunctionExpression(write.argument) ||
      !isEvaluationInert(write.argument) ||
      expressionReferencesIdentifier(write.argument, write.root)
    )
  ) {
    return null;
  }
  return target;
}

function expressionReferencesIdentifier(expression: ts.Expression, name: string): boolean {
  let found = false;
  visit(expression, node => {
    if (ts.isIdentifier(node) && node.text === name) found = true;
  });
  return found;
}
