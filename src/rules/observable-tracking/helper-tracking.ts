import type { HelperSummary } from "./helper-summary.js";
import { HelperTrackingContext } from "./helper-summary.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { TrackingScan } from "./model.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

interface ReviewedHelper {
  readonly call: ts.CallExpression;
  readonly summary: HelperSummary;
}

function selectorNames(scan: TrackingScan): ReadonlySet<string> {
  return new Set([
    ...scan.imports.useValue,
    ...[...scan.imports.legendReactions]
      .filter(
        ([, name]) => name === "useObserve" || name === "useObserveEffect" || name === "observe",
      )
      .map(([name]) => name),
  ]);
}

function resolvedHelpers(
  caller: HelperSummary,
  context: HelperTrackingContext,
): ReviewedHelper[] | null {
  const helpers: ReviewedHelper[] = [];
  for (const call of caller.calls) {
    const helper = context.helper(call);
    const summary = helper && context.summary(helper);
    // Unknown calls can change tracking; recursive and deeper call chains are not proven here.
    if (!summary?.complete || summary.calls.length > 0) {
      return null;
    }
    helpers.push({ call, summary });
  }
  return helpers;
}

function reviewFinding(
  helper: ReviewedHelper,
  caller: HelperSummary,
  scan: TrackingScan,
): LegendPracticeFinding | null {
  const hidden = [...helper.summary.reads].filter(
    (read) =>
      ![...caller.reads].some((trigger) => read === trigger || read.startsWith(`${trigger}.`)),
  );
  if (hidden.length === 0) {
    return null;
  }
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    helper.call.getStart(scan.sourceFile),
  );
  const name = helper.call.expression.getText(scan.sourceFile);
  return {
    action: "review-helper-tracking",
    confidence: "probable",
    disposition: "candidate",
    evidence: [
      `direct selector reads: ${[...caller.reads].join(", ")}`,
      `resolved local helper ${name} synchronously reads additional paths: ${hidden.join(", ")}`,
      `helper writes: ${[...helper.summary.writes].join(", ") || "none"}`,
      ...helper.summary.boundaries,
      "additional dependencies can rerun this selector when their values change; no React render reduction or observed execution count is proven",
      "snapshot intent and the complete intended trigger set are unresolved; retain shared helper behavior",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Review ${name} at this selector call: ${hidden.join(", ")} become dependencies through its synchronous reads. Changes to those paths can repeat the selector and its helper work while direct inputs remain unchanged. Establish which triggers are intended and measure selector executions before considering a call-site snapshot boundary; do not rewrite the shared helper without auditing its other callers.`,
    practice: "reactivity",
  };
}

function selectorReviews(
  call: ts.CallExpression,
  context: HelperTrackingContext,
): LegendPracticeFinding[] {
  const [selector] = call.arguments;
  if (
    !selector ||
    (!ts.isArrowFunction(selector) && !ts.isFunctionExpression(selector)) ||
    selector.parameters.length > 0
  ) {
    return [];
  }
  const caller = context.summary(selector);
  if (!caller.complete || caller.reads.size === 0) {
    return [];
  }
  return (resolvedHelpers(caller, context) ?? []).flatMap((helper) => {
    const finding = reviewFinding(helper, caller, context.scan);
    return finding ? [finding] : [];
  });
}

/** One direct local helper edge; unresolved chains and business intent never authorize an edit. */
export function findHelperTrackingReviews(scan: TrackingScan): LegendPracticeFinding[] {
  const context = new HelperTrackingContext(scan);
  const selectors = selectorNames(scan);
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    if (ts.isCallExpression(node) && context.importedName(node, selectors)) {
      findings.push(...selectorReviews(node, context));
    }
  });
  return findings;
}
