import type { ObservableWrite, TransactionRun, TransactionScan } from "./model.js";
import { isEvaluationInert, unwrapTransparentExpression } from "../core/analysis-ast.js";
import { isInsideBatch, observableWrite } from "./observable-writes.js";
import type { LegendPracticeFinding } from "../core/types.js";
import { transactionFinding } from "./transaction-findings.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

const MINIMUM_BATCH_WRITES = 2;

interface RunAccumulator extends TransactionRun {
  findings: LegendPracticeFinding[];
  isComplete: boolean;
}

export function collectTransactionFindings(scan: TransactionScan): LegendPracticeFinding[] {
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
