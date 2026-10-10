import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import { renderIterationCall, renderOwnerOf } from "../observable-tracking/render-owners.js";
import { replaceNode, withEdits } from "../../core/text-edits.js";
import { rootIdentifier, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { LegendReactComponent } from "../../core/imports.js";
import type { ObservableListScan } from "./observable-lists.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { legendReactComponentOf } from "../observable-tracking/reactive-inputs.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { provenObservablePath } from "../observable-reads/observable-paths.js";
import ts from "typescript";

const TRACKING_CHILD_COMPONENTS: ReadonlySet<LegendReactComponent> = new Set([
  "Computed",
  "For",
  "Memo",
  "Show",
]);

/**
 * A row key read with `get()` inside an `observer` render or a Legend child function subscribes
 * that context to every row's key field. `For` derives keys without tracking them, and Legend's
 * performance guide reads keys with `peek()`. The two differ only when a key field is rewritten in
 * place: the tracked read re-renders the parent and remounts the row, while `peek()` keeps it.
 * That write cannot be ruled out from the render, so the finding asks for it.
 */
export function findTrackedRowKeyPractices(scan: ObservableListScan): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    const method = ts.isJsxAttribute(node) ? trackedKeyMethod(node, scan) : null;
    if (method && ts.isJsxAttribute(node)) {
      findings.push(trackedKeyFinding(node, method, scan));
    }
  });
  return findings;
}

/** The `get` of `key={path.get()}`, where `path` is an observable row path in a tracking render. */
function trackedKeyMethod(
  attribute: ts.JsxAttribute,
  scan: ObservableListScan,
): ts.PropertyAccessExpression | null {
  const value =
    attribute.name.getText() === "key" &&
    attribute.initializer &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression
      ? unwrapTransparentExpression(attribute.initializer.expression)
      : null;
  const callee =
    value && ts.isCallExpression(value) && value.arguments.length === 0 ? value.expression : null;
  return callee &&
    ts.isPropertyAccessExpression(callee) &&
    !callee.questionDotToken &&
    callee.name.text === "get" &&
    isObservableRowPath(callee.expression, scan) &&
    runsInTrackingContext(attribute, scan)
    ? callee
    : null;
}

/** A proven observable path, or a path under the item of a map over one or of a `For` child. */
function isObservableRowPath(receiver: ts.Expression, scan: ObservableListScan): boolean {
  if (provenObservablePath(receiver, scan.observableBindings)) {
    return true;
  }
  const fn = itemCallback(receiver);
  const iteration = fn && renderIterationCall(fn);
  const list =
    iteration && ts.isPropertyAccessExpression(iteration.expression)
      ? iteration.expression.expression
      : null;
  return (
    (list !== null && provenObservablePath(list, scan.observableBindings) !== null) ||
    (fn !== null && childFunctionComponent(fn, scan) === "For")
  );
}

/** The callback whose first parameter is the root of `receiver`. */
function itemCallback(receiver: ts.Expression): RuntimeFunctionLike | null {
  const root = rootIdentifier(receiver);
  const binding = root ? lexicalBinding(root) : null;
  const item = binding?.kind === "value" ? binding.declaration : null;
  const fn = item && ts.isParameter(item) ? item.parent : null;
  return fn && isRuntimeFunctionLike(fn) && fn.parameters[0] === item ? fn : null;
}

/** An `observer` render, or the child function of `Computed`, `Memo`, `Show`, or `For`. */
function runsInTrackingContext(attribute: ts.JsxAttribute, scan: ObservableListScan): boolean {
  if (renderOwnerOf(attribute, scan.imports)?.tracked) {
    return true;
  }
  let fn = findAncestor(attribute, isRuntimeFunctionLike);
  for (
    let iteration = fn && renderIterationCall(fn);
    iteration;
    iteration = fn && renderIterationCall(fn)
  ) {
    fn = findAncestor(iteration, isRuntimeFunctionLike);
  }
  const component = fn ? childFunctionComponent(fn, scan) : null;
  return component !== null && TRACKING_CHILD_COMPONENTS.has(component);
}

/** The Legend component whose child expression is `fn`, as in `<For each={list$}>{(item$) => ...}</For>`. */
function childFunctionComponent(
  fn: RuntimeFunctionLike,
  scan: ObservableListScan,
): LegendReactComponent | null {
  const element = ts.isJsxExpression(fn.parent) ? fn.parent.parent : null;
  return (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    element &&
    ts.isJsxElement(element)
    ? legendReactComponentOf(element.openingElement, scan.imports)
    : null;
}

function trackedKeyFinding(
  attribute: ts.JsxAttribute,
  method: ts.PropertyAccessExpression,
  scan: ObservableListScan,
): LegendPracticeFinding {
  const path = method.expression.getText(scan.sourceFile);
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    attribute.getStart(scan.sourceFile),
  );
  return withEdits(
    {
      action: "use-peek-for-snapshot",
      confidence: "probable",
      disposition: "candidate",
      evidence: [
        `\`${path}.get()\` runs in a tracking render, so it subscribes that render to this row's key field`,
        "`For` derives row keys without tracking them, and React needs the key only to match rows",
      ],
      location: { column: character + 1, file: scan.fileName, line: line + 1 },
      message: `Read the row key with \`${path}.peek()\` if no code rewrites \`${path}\` in place. A tracked key re-renders the parent and remounts the row when it changes; \`peek()\` keeps one subscription per row out of the parent.`,
      practice: "reactivity",
    },
    [replaceNode(scan, method.name, "peek")],
  );
}
