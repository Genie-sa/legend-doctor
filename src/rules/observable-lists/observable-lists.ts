import {
  bindingDeclarationCount,
  isIdentifierNamed,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  captureClassifier,
  visitValueReferences,
} from "../memo-parent-captures/captured-values.js";
import { identifiersNamed, lineOf, nodeWithin, visit } from "../../core/ast.js";
import { isUseValueCall, provenObservablePath } from "../observable-reads/observable-paths.js";
import {
  readsTrackedOrHookState,
  wholeHostChildSlot,
} from "../control-flow-components/control-flow-slots.js";
import type { CaptureClassifier } from "../memo-parent-captures/captured-values.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { findTrackedRowKeyPractices } from "./tracked-row-keys.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { renderOwnerOf } from "../observable-tracking/render-owners.js";
import { soleReturnedExpression } from "../../analysis/ast-helpers.js";
import ts from "typescript";

export interface ObservableListScan {
  readonly fileName: string;
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

type RowCallback = ts.ArrowFunction | ts.FunctionExpression;
type RowElement = ts.JsxElement | ts.JsxSelfClosingElement;

/** `const items = useValue(list$)` read once, as `{items.map((item) => <Row key={item.id} />)}`. */
interface MappedList {
  readonly callback: RowCallback;
  readonly declaration: ts.VariableDeclaration;
  readonly list: ts.Expression;
  readonly row: RowElement;
  readonly slot: ts.JsxExpression;
}

const ID_FIELD = "id";

export function findObservableListPractices(scan: ObservableListScan): LegendPracticeFinding[] {
  return [...findForListPractices(scan), ...findTrackedRowKeyPractices(scan)];
}

/**
 * A component that subscribes to a whole observable array only to map it into keyed rows renders
 * for every change to any item. `For` subscribes to the array shallowly and renders each row in
 * its own observer, so the owner stops rendering and a field change renders one row. `For` keys a
 * row by the item's `id`, skips falsy items, and does not re-render rows with their parent, so the
 * row must be keyed by `item.id`, read the item, and capture no owner value that can change.
 */
function findForListPractices(scan: ObservableListScan): LegendPracticeFinding[] {
  const classify = captureClassifier(scan);
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    const mapped = ts.isVariableDeclaration(node) ? mappedList(node, scan) : null;
    if (mapped && !capturesChangingOwnerValue(mapped.callback, classify)) {
      findings.push(forListFinding(mapped, scan));
    }
  });
  return findings;
}

interface SubscribedList {
  readonly list: ts.Expression;
  readonly name: ts.Identifier;
  readonly owner: ts.Node;
}

/** A component's top-level `const items = useValue(list$)` on a proven observable path. */
function subscribedList(
  declaration: ts.VariableDeclaration,
  scan: ObservableListScan,
): SubscribedList | null {
  const call = declaration.initializer && unwrapTransparentExpression(declaration.initializer);
  const owner = renderOwnerOf(declaration, scan.imports);
  const { name } = declaration;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(name) ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, scan.imports) ||
    owner?.kind !== "component" ||
    owner.hops !== 0 ||
    bindingDeclarationCount(owner.owner, name.text) !== 1
  ) {
    return null;
  }
  const list = provenObservablePath(call.arguments[0]!, scan.observableBindings);
  return list ? { list, name, owner: owner.owner } : null;
}

function mappedList(
  declaration: ts.VariableDeclaration,
  scan: ObservableListScan,
): MappedList | null {
  const subscribed = subscribedList(declaration, scan);
  const mapCall = subscribed ? soleMapCall(subscribed.name, subscribed.owner) : null;
  const slot = mapCall ? wholeHostChildSlot(mapCall, scan.imports) : null;
  const callback = mapCall?.arguments[0];
  const row = callback ? keyedRow(callback) : null;
  return subscribed && slot && callback && row && isRowCallback(callback)
    ? { callback, declaration, list: subscribed.list, row, slot }
    : null;
}

function soleMapCall(name: ts.Identifier, owner: ts.Node): ts.CallExpression | null {
  const references = identifiersNamed(owner, name.text).filter(
    (identifier) => identifier !== name && !isNonValueIdentifier(identifier),
  );
  const access = references.length === 1 ? references[0]!.parent : null;
  const call = access?.parent;
  return access &&
    ts.isPropertyAccessExpression(access) &&
    access.expression === references[0] &&
    !access.questionDotToken &&
    access.name.text === "map" &&
    call &&
    ts.isCallExpression(call) &&
    call.expression === access &&
    call.arguments.length === 1
    ? call
    : null;
}

function isRowCallback(callback: ts.Expression): callback is RowCallback {
  const [item, ...rest] =
    ts.isArrowFunction(callback) || ts.isFunctionExpression(callback) ? callback.parameters : [];
  return (
    item !== undefined && rest.length === 0 && ts.isIdentifier(item.name) && !item.dotDotDotToken
  );
}

/** The row a callback returns as its only statement, keyed by `item.id`, with no tracked read. */
function keyedRow(callback: ts.Expression): RowElement | null {
  const returned = isRowCallback(callback) ? soleReturnedExpression(callback.body) : null;
  const row = returned ? unwrapTransparentExpression(returned) : null;
  if (
    !row ||
    !isRowCallback(callback) ||
    !(ts.isJsxElement(row) || ts.isJsxSelfClosingElement(row))
  ) {
    return null;
  }
  const key = (ts.isJsxElement(row) ? row.openingElement : row).attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
  );
  const value =
    key && ts.isJsxAttribute(key) && key.initializer && ts.isJsxExpression(key.initializer)
      ? key.initializer.expression
      : undefined;
  const access = value ? unwrapTransparentExpression(value) : null;
  return access &&
    ts.isPropertyAccessExpression(access) &&
    !access.questionDotToken &&
    access.name.text === ID_FIELD &&
    isIdentifierNamed(access.expression, callback.parameters[0]!.name.getText()) &&
    !readsTrackedOrHookState(callback.body)
    ? row
    : null;
}

function capturesChangingOwnerValue(callback: RowCallback, classify: CaptureClassifier): boolean {
  let captures = false;
  visitValueReferences(callback.body, (identifier) => {
    const binding = lexicalBinding(identifier);
    const declaredInside =
      (binding?.kind === "function" || binding?.kind === "value") &&
      nodeWithin(binding.declaration, callback);
    captures ||= !declaredInside && classify(identifier) !== null;
  });
  return captures;
}

function forListFinding(mapped: MappedList, scan: ObservableListScan): LegendPracticeFinding {
  const { callback, declaration, list, row, slot } = mapped;
  const item = callback.parameters[0]!.name.getText(scan.sourceFile);
  const listText = list.getText(scan.sourceFile);
  const rowTag = (ts.isJsxElement(row) ? row.openingElement.tagName : row.tagName).getText(
    scan.sourceFile,
  );
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(scan.sourceFile),
  );
  return {
    action: "render-list-with-for",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `\`${declaration.getText(scan.sourceFile)}\` is read only by the keyed map at line ${lineOf(slot, scan.sourceFile)}, so every change to any item renders this component`,
      `each row is keyed by \`${item}.${ID_FIELD}\`, the key \`For\` derives, and captures no owner value that can change, so rows that \`For\` does not re-render with their parent stay current`,
      "the map is the complete child of a host element or fragment, so the rows keep their keys and positions under `For`",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Replace the keyed map at line ${lineOf(slot, scan.sourceFile)} with \`<For each={${listText}}>{(${item}$) => { const ${item} = ${item}$.get(); return <${rowTag} … />; }}</For>\`, drop the row's \`key\`, and remove \`${declaration.getText(scan.sourceFile)}\`. \`For\` keys each row by \`${item}.${ID_FIELD}\` and renders it in its own observer, so this component stops rendering for list changes and a change to one item renders only its row.`,
    practice: "reactivity",
  };
}
