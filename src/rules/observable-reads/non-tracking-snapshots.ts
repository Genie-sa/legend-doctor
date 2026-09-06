import type { HookCallback, ObservableReadScan } from "./model.js";
import { findAncestor, isRuntimeFunctionLike } from "../../core/ast.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { callbackIsEventRooted } from "../state-proofs/event-roots.js";
import { isImportedHookCall } from "../../core/imports.js";
import { provenObservablePath } from "./observable-paths.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

interface NonTrackingSnapshot {
  observable: ts.Expression;
  source: "observable-listener" | "react-or-event" | "source-proven-effect";
}

export function nonTrackingSnapshotObservable(
  call: ts.CallExpression,
  scan: ObservableReadScan,
): NonTrackingSnapshot | null {
  if (
    call.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "get"
  ) {
    return null;
  }
  const observable = provenObservablePath(call.expression.expression, scan.observableBindings);
  if (!observable) {
    return null;
  }
  const callback = findAncestor(call, isRuntimeFunctionLike);
  if (!callback) {
    return null;
  }
  const source = provenNonTrackingCallbackSource(callback, scan);
  return source ? { observable, source } : null;
}

function isReactSnapshotCallback(callback: HookCallback, imports: HookImports): boolean {
  return (
    isDirectHookCallback(callback, imports, "useEffect") ||
    isDirectHookCallback(callback, imports, "useInsertionEffect") ||
    isDirectHookCallback(callback, imports, "useLayoutEffect") ||
    isDirectHookCallback(callback, imports, "useState") ||
    isDirectHookCallback(callback, imports, "useMount") ||
    isDirectHookCallback(callback, imports, "useUnmount")
  );
}

function eventRootedSnapshotSource(
  callback: HookCallback,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): NonTrackingSnapshot["source"] | null {
  if (isDirectJsxEventCallback(callback)) {
    return "react-or-event";
  }
  if (sourceProvenEffectJsxCallback(callback, scan.childContracts)) {
    return "source-proven-effect";
  }
  return callbackIsEventRooted({ callback, owner, dependencyName: "", seen: new Set() })
    ? "react-or-event"
    : null;
}

function provenNonTrackingCallbackSource(
  callback: RuntimeFunctionLike,
  scan: ObservableReadScan,
): NonTrackingSnapshot["source"] | null {
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return null;
  }
  if (isReactSnapshotCallback(callback, scan.imports)) {
    return "react-or-event";
  }
  if (isDirectObservableOnChangeCallback(callback, scan.observableBindings)) {
    return "observable-listener";
  }
  const owner = findAncestor(callback, isRuntimeFunctionLike);
  if (!owner) {
    return null;
  }
  return eventRootedSnapshotSource(callback, owner, scan);
}

function isDirectObservableOnChangeCallback(
  callback: HookCallback,
  observableBindings: ReadonlySet<string>,
): boolean {
  const { parent } = callback;
  if (
    !ts.isCallExpression(parent) ||
    parent.arguments.length !== 1 ||
    parent.arguments[0] !== callback ||
    parent.questionDotToken
  ) {
    return false;
  }
  const method = unwrapTransparentExpression(parent.expression);
  return (
    ts.isPropertyAccessExpression(method) &&
    !method.questionDotToken &&
    method.name.text === "onChange" &&
    provenObservablePath(method.expression, observableBindings) !== null
  );
}

function sourceProvenEffectJsxCallback(
  callback: HookCallback,
  childContracts: ChildContractResolver | null,
): boolean {
  if (!childContracts || ts.isFunctionDeclaration(callback)) {
    return false;
  }
  const expression = callback.parent;
  if (
    !ts.isJsxExpression(expression) ||
    !expression.expression ||
    unwrapTransparentExpression(expression.expression) !== callback ||
    !ts.isJsxAttribute(expression.parent)
  ) {
    return false;
  }
  const attribute = expression.parent;
  const element = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return false;
  }
  return childContracts.componentCallbackPropRunsOnlyInReactEffect(
    element.tagName.getText(),
    attribute.name.getText(),
  );
}

function isDirectHookCallback(
  callback: HookCallback,
  imports: HookImports,
  hook:
    | "useEffect"
    | "useInsertionEffect"
    | "useLayoutEffect"
    | "useMount"
    | "useState"
    | "useUnmount",
): boolean {
  const { parent } = callback;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== callback) {
    return false;
  }
  const namespaces =
    hook === "useMount" || hook === "useUnmount"
      ? imports.legendReactNamespaces
      : imports.reactNamespaces;
  return isImportedHookCall({
    call: parent,
    localNames: imports[hook],
    namespaceNames: namespaces,
    canonicalName: hook,
  });
}

function isDirectJsxEventCallback(callback: HookCallback): boolean {
  const expression = callback.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== callback) {
    return false;
  }
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) && /^on[A-Z]/u.test(attribute.name.getText());
}

function snapshotSourceEvidence(source: NonTrackingSnapshot["source"]): string {
  if (source === "source-proven-effect") {
    return "the source-proven React effect callback runs outside a Legend tracking context";
  }
  if (source === "observable-listener") {
    return "the direct Legend observable onChange listener runs outside an observing context";
  }
  return "the read is owned by a React snapshot or a uniquely event-rooted command, not a Legend tracking context";
}

export function nonTrackingSnapshotFinding(
  call: ts.CallExpression,
  snapshot: NonTrackingSnapshot,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(scan.sourceFile),
  );
  const path = snapshot.observable.getText(scan.sourceFile);
  return {
    action: "use-peek-for-snapshot",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${path}.get() reads a proven Legend observable path`,
      snapshotSourceEvidence(snapshot.source),
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Replace \`${path}.get()\` with \`${path}.peek()\`; this code path needs a snapshot, not a reactive dependency.`,
    practice: "reactivity",
  };
}
