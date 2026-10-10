import type { InPlaceMemoKeyScan, RawValueBinding, RelativeWrite, StaleMemo } from "./model.js";
import { calleeName, visit, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import { isCompilerHookName, isReactCompilerUnit } from "../../core/react-compiler-units.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  outermostTransparentParent,
} from "../../core/analysis-ast.js";
import { isStableDependency } from "./memo-dependencies.js";
import { reachesRenderOutput } from "../../core/render-output.js";
import { referenceReads } from "./memo-reads.js";
import ts from "typescript";
import { writeChangesRead } from "./write-conflicts.js";

/**
 * Calls the React Compiler memoizes on the raw useValue result: a method call on it, or a call
 * that receives it, whose value reaches the rendered output. The Compiler compares the result by
 * reference, as a useMemo keyed on it would, so an in-place write below the source leaves the
 * cached value in place while the hook rerenders the owner.
 */
export function compilerMemos(
  binding: RawValueBinding,
  writes: readonly RelativeWrite[],
  scan: InPlaceMemoKeyScan,
): StaleMemo[] {
  const { owner } = binding;
  if (!scan.reactCompiler || !owner.body || !isReactCompilerUnit(owner)) {
    return [];
  }
  const memos = new Map<ts.CallExpression, StaleMemo>();
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (!isValueReference(node, binding.name)) {
      return;
    }
    const call = memoizedCall(node);
    if (!call || memos.has(call) || !reachesRenderOutput(call, owner)) {
      return;
    }
    const reads = referenceReads(node);
    const changing = writes.filter((write) => reads.some((read) => writeChangesRead(write, read)));
    if (changing.length > 0) {
      memos.set(call, {
        call,
        kind: "compiler",
        otherDependencies: capturedDependencies(call, binding, scan),
        reads,
        writes: changing,
      });
    }
  });
  return [...memos.values()];
}

function isValueReference(node: ts.Node, name: string): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === name &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node)
  );
}

/**
 * The outermost call of a method chain that starts at the reference, or of a call receiving it.
 * Hooks are never memoized, so a reference handed to one is not a cache key.
 */
function memoizedCall(reference: ts.Identifier): ts.CallExpression | null {
  const outer = outermostTransparentParent(reference);
  const { parent } = outer;
  const receiving = methodCallOn(outer);
  if (receiving) {
    return outermostMethodChain(receiving);
  }
  if (!ts.isCallExpression(parent) || !parent.arguments.includes(outer)) {
    return null;
  }
  const callee = calleeName(parent.expression);
  return callee !== null && isCompilerHookName(callee) ? null : outermostMethodChain(parent);
}

function methodCallOn(receiver: ts.Expression): ts.CallExpression | null {
  const { parent } = receiver;
  return ts.isPropertyAccessExpression(parent) &&
    parent.expression === receiver &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
    ? parent.parent
    : null;
}

function outermostMethodChain(call: ts.CallExpression): ts.CallExpression {
  let current = call;
  for (let next = methodCallOn(current); next; next = methodCallOn(current)) {
    current = next;
  }
  return current;
}

/** Values the call reads from the owner, besides the snapshot, whose identity can change between renders. */
function capturedDependencies(
  call: ts.CallExpression,
  { name, owner }: RawValueBinding,
  scan: InPlaceMemoKeyScan,
): string[] {
  const declaredInside = new Set<string>();
  const references = new Map<string, ts.Identifier>();
  visit(call, (node) => {
    if (!ts.isIdentifier(node) || isNonValueIdentifier(node)) {
      return;
    }
    if (isDeclarationName(node)) {
      declaredInside.add(node.text);
    } else if (node.text !== name && !references.has(node.text)) {
      references.set(node.text, node);
    }
  });
  return [...references.values()]
    .filter(
      (reference) =>
        !declaredInside.has(reference.text) && !isStableDependency(reference, owner, scan.imports),
    )
    .map((reference) => reference.text);
}
