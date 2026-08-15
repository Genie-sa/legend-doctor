import ts from "typescript";

import {
  containsElementAccess,
  isEvaluationInert,
  rootIdentifier,
  unwrapTransparentExpression,
} from "./analysis-ast.js";
import { isNonProductionHarness, visit } from "./ast.js";
import { collectHookImports, type HookImports } from "./imports.js";
import type { AnalysisFile } from "./analysis-project.js";
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
  importedObservableFactories: ReadonlySet<string> = new Set()
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
    importedObservableFactories
  );
}

export function analyzeLegendPracticesFile(
  file: AnalysisFile,
  reportFileName: string,
  importedObservables: ReadonlySet<string> = new Set(),
  importedObservableFactories: ReadonlySet<string> = new Set(),
  includeFindings = true
): LegendPracticeFinding[] {
  const findings = analyzeParsedLegendPractices(
    file.sourceFile,
    reportFileName,
    importedObservables,
    importedObservableFactories
  );
  return includeFindings ? findings : [];
}

function analyzeParsedLegendPractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  importedObservables: ReadonlySet<string>,
  importedObservableFactories: ReadonlySet<string>
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
    ...findLegacyUseValuePractices(sourceFile, fileName, imports, observableBindings),
  ];
  if (lacksObservableSources) return findings;
  if (observableBindings.size === 0) return findings;

  visit(sourceFile, node => {
    if (!ts.isBlock(node) && !ts.isSourceFile(node)) return;
    let run: ObservableWrite[] = [];
    let runIsComplete = true;
    const flush = (): void => {
      if (runIsComplete && run.length >= 2 && hasDistinctNonOverlappingPaths(run)) {
        findings.push(transactionFinding(run, sourceFile, fileName));
      }
      run = [];
      runIsComplete = true;
    };

    for (const statement of node.statements) {
      const write = observableWrite(statement, observableBindings, sourceFile);
      if (write && !isInsideBatch(write.call, imports)) {
        run.push(write);
      } else if (isSetStatement(statement)) {
        runIsComplete = false;
      } else {
        flush();
      }
    }
    flush();
  });

  findings.push(...findObservableReadPractices(sourceFile, fileName, imports, observableBindings));
  findings.push(...findObservableCloneWritePractices(sourceFile, fileName, observableBindings));
  findings.push(...findObservableTogglePractices(sourceFile, fileName, observableBindings));

  return findings.sort(
    (left, right) =>
      left.location.line - right.location.line || left.location.column - right.location.column
  );
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
  const typeQueries: Array<{ name: string; type: ts.TypeNode }> = [];

  visit(sourceFile, node => {
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
    [...directCandidates].filter(name => declarations.get(name) === 1)
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
  const root = rootIdentifier(value);
  return root !== null && observableBindings.has(root.text);
}

function typeQueriesObservable(
  type: ts.TypeNode,
  observableBindings: ReadonlySet<string>
): boolean {
  if (ts.isParenthesizedTypeNode(type)) return typeQueriesObservable(type.type, observableBindings);
  if (!ts.isTypeQueryNode(type)) return false;
  let current: ts.EntityName = type.exprName;
  while (ts.isQualifiedName(current)) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(current.right.text)) return false;
    current = current.left;
  }
  return observableBindings.has(current.text);
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
  if (!root || !observableBindings.has(root.text)) return null;
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

function transactionFinding(
  writes: readonly ObservableWrite[],
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding {
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
