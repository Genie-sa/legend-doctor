import type { InPlaceMemoKeyScan, RawValueBinding, StaleMemo, WrittenBinding } from "./model.js";
import { visit, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import { writeChangesRead, writesBelow } from "./write-conflicts.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { inPlaceMemoKeyFinding } from "./finding.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isStableDependency } from "./memo-dependencies.js";
import { memoReads } from "./memo-reads.js";
import { rawValueBinding } from "./raw-value-bindings.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

const MEMO_ARGUMENT_COUNT = 2;

export function findInPlaceMemoKeyPractices(scan: InPlaceMemoKeyScan): LegendPracticeFinding[] {
  if (scan.inPlaceWrites.size === 0) {
    return [];
  }
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    const binding = ts.isVariableDeclaration(node) ? rawValueBinding(node, scan) : null;
    const memos = binding ? staleMemos(binding, scan) : [];
    if (binding && memos.length > 0) {
      findings.push(inPlaceMemoKeyFinding(binding, memos, scan));
    }
  });
  return findings;
}

function staleMemos(binding: RawValueBinding, scan: InPlaceMemoKeyScan): StaleMemo[] {
  const [root, ...members] = binding.sourcePath;
  const writes = root ? writesBelow(members, scan.inPlaceWrites.get(root) ?? []) : [];
  const { body } = binding.owner;
  if (writes.length === 0 || !body) {
    return [];
  }
  const memos: StaleMemo[] = [];
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    const memo = ts.isCallExpression(node) ? staleMemo(node, { binding, writes }, scan) : null;
    if (memo) {
      memos.push(memo);
    }
  });
  return memos;
}

function staleMemo(
  call: ts.CallExpression,
  { binding, writes }: WrittenBinding,
  scan: InPlaceMemoKeyScan,
): StaleMemo | null {
  const dependencies = memoDependencies(call, binding.name, scan);
  const callback = call.arguments[0] ? unwrapTransparentExpression(call.arguments[0]) : null;
  if (!dependencies || !callback || !isInlineFunction(callback)) {
    return null;
  }
  const reads = memoReads(callback, binding.name) ?? [];
  const changing = writes.filter((write) => reads.some((read) => writeChangesRead(write, read)));
  if (changing.length === 0) {
    return null;
  }
  const otherDependencies = dependencies
    .filter((dependency) => !isStableDependency(dependency, binding.owner, scan.imports))
    .map((dependency) => dependency.getText(scan.sourceFile));
  return { call, otherDependencies, reads, writes: changing };
}

/** The dependency list of a `useMemo` keyed on the bare binding, without that key. */
function memoDependencies(
  call: ts.CallExpression,
  name: string,
  scan: InPlaceMemoKeyScan,
): ts.Expression[] | null {
  const list = call.arguments[1] ? unwrapTransparentExpression(call.arguments[1]) : null;
  if (
    call.arguments.length !== MEMO_ARGUMENT_COUNT ||
    !list ||
    !ts.isArrayLiteralExpression(list) ||
    !isImportedHookCall({
      call,
      canonicalName: "useMemo",
      localNames: scan.imports.useMemo,
      namespaceNames: scan.imports.reactNamespaces,
    })
  ) {
    return null;
  }
  const keyed = list.elements.some((element) => isBindingReference(element, name));
  return keyed ? list.elements.filter((element) => !isBindingReference(element, name)) : null;
}

function isBindingReference(expression: ts.Expression, name: string): boolean {
  const value = unwrapTransparentExpression(expression);
  return ts.isIdentifier(value) && value.text === name;
}

function isInlineFunction(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}
