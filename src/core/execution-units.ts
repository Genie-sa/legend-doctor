import { isRuntimeFunctionLike, visitSkippingNestedRuntimeFunctions } from "./ast.js";
import ts from "typescript";

/** Callbacks these calls run before returning, so they share the caller's synchronous run. */
const SYNCHRONOUS_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "batch",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
  "toSorted",
]);

const LOOP_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.WhileStatement,
]);

/**
 * The synchronous stretch a node runs in: the enclosing function (or module) body between two
 * suspension points. Callbacks of `batch` and array iteration run inside their caller's stretch. A
 * suspension inside a loop that also contains the node never splits it, because a later iteration
 * resumes into the same stretch as earlier writes.
 */
export interface ExecutionUnit {
  /** Shared by every node of the same file that runs in this stretch. */
  readonly key: string;
  /** The module body runs once while the module evaluates, before any importer renders. */
  readonly atModuleLoad: boolean;
}

export function executionUnit(node: ts.Node): ExecutionUnit {
  const owner = executionOwner(node);
  const start = node.getStart();
  let suspensions = 0;
  visitSkippingNestedRuntimeFunctions(owner, (current) => {
    if (
      current !== owner &&
      isSuspension(current) &&
      current.getEnd() <= start &&
      !sharesLoop(current, node, owner)
    ) {
      suspensions += 1;
    }
  });
  return { atModuleLoad: ts.isSourceFile(owner), key: `${owner.getStart()}:${suspensions}` };
}

function executionOwner(node: ts.Node): ts.Node {
  for (let current = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current) && !runsSynchronouslyInCaller(current)) {
      return current;
    }
    if (ts.isSourceFile(current)) {
      return current;
    }
  }
  return node.getSourceFile();
}

function runsSynchronouslyInCaller(callback: ts.Node): boolean {
  const call = callback.parent;
  if (!ts.isCallExpression(call) || !call.arguments.some((argument) => argument === callback)) {
    return false;
  }
  const name = calleeName(call.expression);
  return name !== null && SYNCHRONOUS_CALLBACK_METHODS.has(name);
}

function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

function isSuspension(node: ts.Node): boolean {
  return (
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
  );
}

function sharesLoop(suspension: ts.Node, node: ts.Node, owner: ts.Node): boolean {
  for (let current = suspension.parent; current && current !== owner; current = current.parent) {
    if (LOOP_KINDS.has(current.kind) && current.pos <= node.pos && node.end <= current.end) {
      return true;
    }
  }
  return false;
}
