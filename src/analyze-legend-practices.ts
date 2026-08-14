import ts from "typescript";

import { collectHookImports, type HookImports } from "./imports.js";
import type { LegendPracticeFinding } from "./types.js";

interface ObservableWrite {
  call: ts.CallExpression;
  path: string;
}

export function analyzeLegendPractices(
  sourceText: string,
  fileName: string
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
  const imports = collectHookImports(sourceFile);
  if (
    imports.observable.size === 0 &&
    imports.useObservable.size === 0 &&
    imports.observableTypes.size === 0
  ) {
    return [];
  }

  const observableBindings = collectObservableBindings(sourceFile, imports);
  if (observableBindings.size === 0) return [];

  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, node => {
    if (!ts.isBlock(node) && !ts.isSourceFile(node)) return;
    let run: ObservableWrite[] = [];
    const flush = (): void => {
      if (run.length >= 2 && hasDistinctNonOverlappingPaths(run)) {
        findings.push(batchFinding(run, sourceFile, fileName));
      }
      run = [];
    };

    for (const statement of node.statements) {
      const write = observableWrite(statement, observableBindings, sourceFile);
      if (write && !isInsideBatch(write.call, imports)) {
        run.push(write);
      } else {
        flush();
      }
    }
    flush();
  });

  return findings.sort(
    (left, right) =>
      left.location.line - right.location.line || left.location.column - right.location.column
  );
}

function collectObservableBindings(
  sourceFile: ts.SourceFile,
  imports: HookImports
): ReadonlySet<string> {
  const declarations = new Map<string, number>();
  const candidates = new Set<string>();
  visit(sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      recordDeclaration(declarations, node.name.text);
      if (
        (node.initializer && isObservableFactoryCall(node.initializer, imports)) ||
        (node.type && typeNamesObservable(node.type, imports.observableTypes))
      ) {
        candidates.add(node.name.text);
      }
      return;
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      recordDeclaration(declarations, node.name.text);
      if (node.type && typeNamesObservable(node.type, imports.observableTypes)) {
        candidates.add(node.name.text);
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
  return new Set([...candidates].filter(name => declarations.get(name) === 1));
}

function recordDeclaration(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function isObservableFactoryCall(expression: ts.Expression, imports: HookImports): boolean {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value)) return false;
  if (ts.isIdentifier(value.expression)) {
    return imports.observable.has(value.expression.text) || imports.useObservable.has(value.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    imports.legendNamespaces.has(value.expression.expression.text) &&
    value.expression.name.text === "observable"
  );
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
  const expression = unwrapExpression(statement.expression);
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
  return { call: expression, path: receiver.getText(sourceFile) };
}

function containsElementAccess(node: ts.Node): boolean {
  let found = false;
  visit(node, current => {
    if (ts.isElementAccessExpression(current)) found = true;
  });
  return found;
}

function containsAwaitOrYield(node: ts.Node): boolean {
  let found = false;
  visit(node, current => {
    if (ts.isAwaitExpression(current) || ts.isYieldExpression(current)) found = true;
  });
  return found;
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | null {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : null;
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

function batchFinding(
  writes: readonly ObservableWrite[],
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding {
  const first = writes[0]!;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.call.getStart(sourceFile));
  return {
    action: "batch-observable-writes",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${writes.length} consecutive writes target distinct proven Legend observable paths`,
      "no await, yield, control-flow boundary, or existing batch surrounds the writes",
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Batch these ${writes.length} consecutive Legend observable writes so observers publish once; use \`batch(() => { ... })\`, or one parent \`.assign(...)\` when the fields share an object root.`,
    practice: "batch",
  };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, child => visit(child, visitor));
}
