import type { ObservableWrite, TransactionScan } from "./model.js";
import {
  directGetReceiver,
  provenObservablePath,
} from "../rules/observable-reads/observable-paths.js";
import { visit, visitSkippingNestedRuntimeFunctions } from "../core/ast.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../core/analysis-ast.js";

/** Per non-React tracker in a file, the observable paths it reads. */
export type TrackerReads = readonly (readonly string[])[];

const TRACKING_REACTIONS = new Set(["observe", "useObserve", "useObserveEffect"]);
const MINIMUM_SPANNED_WRITES = 2;

/**
 * Each tracker reads the synchronous `get()` calls in a reaction's tracked first argument or a
 * `useComputed` body, or, for an `onChange` listener, its receiver and every child path.
 */
export function fileTrackerReads(scan: TransactionScan): TrackerReads {
  const trackers: string[][] = [];
  visit(scan.sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const callee = unwrapTransparentExpression(node.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "onChange") {
      const path = provenObservablePath(callee.expression, scan.observableBindings);
      if (path) {
        trackers.push([pathKey(path.getText(scan.sourceFile))]);
      }
    } else if (ts.isIdentifier(callee) && isTrackerCallee(callee.text, scan) && node.arguments[0]) {
      trackers.push(trackedReads(node.arguments[0], scan));
    }
  });
  return trackers.filter((reads) => reads.length > 0);
}

function isTrackerCallee(name: string, scan: TransactionScan): boolean {
  return (
    TRACKING_REACTIONS.has(scan.imports.legendReactions.get(name) ?? "") ||
    scan.imports.useComputed.has(name)
  );
}

function trackedReads(tracked: ts.Expression, scan: TransactionScan): string[] {
  const tracker = unwrapTransparentExpression(tracked);
  if (!ts.isArrowFunction(tracker) && !ts.isFunctionExpression(tracker)) {
    return [];
  }
  const reads: string[] = [];
  visitSkippingNestedRuntimeFunctions(tracker.body, (node) => {
    const receiver = ts.isExpression(node) ? directGetReceiver(node) : null;
    const path = receiver && provenObservablePath(receiver, scan.observableBindings);
    if (path) {
      reads.push(pathKey(path.getText(scan.sourceFile)));
    }
  });
  return reads;
}

/** Whether one tracker reads two or more of the written paths, directly or through a parent `get()`. */
export function trackerSpansWrites(
  trackers: TrackerReads,
  writes: readonly ObservableWrite[],
): boolean {
  const written = writes.map((write) => pathKey(write.path));
  return trackers.some(
    (reads) =>
      written.filter((path) => reads.some((read) => path === read || path.startsWith(`${read}.`)))
        .length >= MINIMUM_SPANNED_WRITES,
  );
}

function pathKey(path: string): string {
  return path.replaceAll(/\s/gu, "");
}
