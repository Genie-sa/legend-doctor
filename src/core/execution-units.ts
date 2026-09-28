import { calleeName, isRuntimeFunctionLike, visitSkippingNestedRuntimeFunctions } from "./ast.js";
import ts from "typescript";

/** Callbacks these calls run before returning, so they share the caller's synchronous run. */
export const SYNCHRONOUS_CALLBACK_METHODS: ReadonlySet<string> = new Set([
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
  "set",
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

const suspensionsByOwner = new WeakMap<ts.Node, readonly ts.Node[]>();

/**
 * The synchronous stretch a node runs in: the enclosing function (or module) body between two
 * suspension points. Callbacks of `batch`, observable `set` updaters, and array iteration run
 * inside their caller's stretch. A suspension inside a loop that also contains the node never
 * splits it, because a later iteration resumes into the same stretch as earlier writes.
 */
export interface ExecutionUnit {
  /** Shared by every node, in any file, that runs in this stretch. */
  readonly key: string;
  /** The key of the owner's first stretch, which is what a synchronous call of the owner runs. */
  readonly entry: string;
  /** The stretch follows a suspension, so the event loop starts it rather than a caller. */
  readonly resumed: boolean;
  /** The module body runs once while the module evaluates, before any importer renders. */
  readonly atModuleLoad: boolean;
  /** The file whose code starts the stretch. */
  readonly file: string;
}

export function executionUnit(node: ts.Node): ExecutionUnit {
  const owner = executionOwner(node);
  const start = node.getStart();
  const suspensions = ownerSuspensions(owner).filter(
    (suspension) => suspension.getEnd() <= start && !sharesLoop(suspension, node, owner),
  ).length;
  const entry = functionEntryKey(owner);
  return {
    atModuleLoad: ts.isSourceFile(owner),
    entry,
    file: owner.getSourceFile().fileName,
    key: suspensions === 0 ? entry : `${ownerKey(owner)}:${suspensions}`,
    resumed: suspensions > 0,
  };
}

/** The unit key of a function's first stretch, which a synchronous call of it runs. */
export function functionEntryKey(owner: ts.Node): string {
  return `${ownerKey(owner)}:0`;
}

function ownerKey(owner: ts.Node): string {
  return `${owner.getSourceFile().fileName}:${owner.getStart()}`;
}

function ownerSuspensions(owner: ts.Node): readonly ts.Node[] {
  const cached = suspensionsByOwner.get(owner);
  if (cached) {
    return cached;
  }
  const suspensions: ts.Node[] = [];
  visitSkippingNestedRuntimeFunctions(owner, (current) => {
    if (current !== owner && isSuspension(current)) {
      suspensions.push(current);
    }
  });
  suspensionsByOwner.set(owner, suspensions);
  return suspensions;
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
