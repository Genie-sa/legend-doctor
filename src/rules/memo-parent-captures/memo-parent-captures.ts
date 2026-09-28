import type { CapturedRead, MemoCaptureScan, MemoElement, StaleMemo } from "./model.js";
import { captureClassifier, lineOf, visitValueReferences } from "./captured-values.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import { renderIterationCall, renderOwnerOf } from "../observable-tracking/render-owners.js";
import type { CaptureClassifier } from "./captured-values.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { staleMemoFinding } from "./finding.js";
import ts from "typescript";

export type { MemoCaptureScan } from "./model.js";

const MEMO = "Memo";
const SCOPED_ATTRIBUTE = "scoped";

/**
 * `<Memo>` is `React.memo(Computed)` with an equality check that ignores new children unless
 * `scoped` is set, so a render of its owner never reaches the child. Every value the child reads
 * from the owner's render is frozen at the Memo's first render.
 */
export function findMemoParentCapturePractices(scan: MemoCaptureScan): LegendPracticeFinding[] {
  if (
    ![...scan.imports.legendReactComponents.values()].includes(MEMO) &&
    scan.imports.legendReactNamespaces.size === 0
  ) {
    return [];
  }
  const classify = captureClassifier(scan);
  const stale: StaleMemo[] = [];
  visit(scan.sourceFile, (node) => {
    const memo = ts.isJsxElement(node) ? memoElement(node, scan.imports) : null;
    const reads = memo ? capturedReads(memo, classify, scan) : [];
    if (memo && reads.length > 0) {
      stale.push({ memo, ownerName: ownerName(node, scan.imports), reads });
    }
  });
  return stale.map((entry) => staleMemoFinding(entry, stale, scan));
}

function memoElement(element: ts.JsxElement, imports: HookImports): MemoElement | null {
  const { openingElement, closingElement } = element;
  const hasScopedOrSpread = openingElement.attributes.properties.some(
    (attribute) =>
      ts.isJsxSpreadAttribute(attribute) || attribute.name.getText() === SCOPED_ATTRIBUTE,
  );
  return isMemoTag(openingElement.tagName, imports) && !hasScopedOrSpread
    ? { closingTag: closingElement.tagName, element, openingTag: openingElement.tagName }
    : null;
}

function isMemoTag(tag: ts.JsxTagNameExpression, imports: HookImports): boolean {
  if (ts.isIdentifier(tag)) {
    const binding = lexicalBinding(tag);
    return (
      imports.legendReactComponents.get(tag.text) === MEMO &&
      binding?.kind === "import" &&
      binding.importedName === MEMO
    );
  }
  return (
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    imports.legendReactNamespaces.has(tag.expression.text) &&
    tag.name.text === MEMO
  );
}

/** Reads of owner-render values that run whenever the Memo child renders, one per name. */
function capturedReads(
  memo: MemoElement,
  classify: CaptureClassifier,
  scan: MemoCaptureScan,
): CapturedRead[] {
  const reads = new Map<string, CapturedRead>();
  const record = (identifier: ts.Identifier): void => {
    const binding = lexicalBinding(identifier);
    const declaredInside =
      binding !== null &&
      (binding.kind === "function" || binding.kind === "value") &&
      nodeWithin(binding.declaration, memo.element);
    const change = declaredInside || reads.has(identifier.text) ? null : classify(identifier);
    if (change) {
      reads.set(identifier.text, {
        change,
        line: lineOf(identifier, scan.sourceFile),
        name: identifier.text,
      });
    }
  };
  const walk = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node !== memo.element && memoElement(node, scan.imports)) {
      return;
    }
    if (isRuntimeFunctionLike(node) && !runsWithChildRender(node, memo, scan.imports)) {
      return;
    }
    if (ts.isIdentifier(node) || ts.isTypeNode(node)) {
      visitValueReferences(node, record);
      return;
    }
    node.forEachChild(walk);
  };
  for (const child of memo.element.children) {
    walk(child);
  }
  return [...reads.values()];
}

/**
 * The Memo's own child function, a synchronous iteration callback, and the child function of
 * another Legend reactive component all run while the Memo child renders; handlers and effects do not.
 */
function runsWithChildRender(
  fn: RuntimeFunctionLike,
  memo: MemoElement,
  imports: HookImports,
): boolean {
  if (renderIterationCall(fn)) {
    return true;
  }
  const element = childFunctionElement(fn);
  if (!element) {
    return false;
  }
  const tag = element.openingElement.tagName;
  return (
    element === memo.element ||
    (ts.isIdentifier(tag) && imports.legendReactComponents.has(tag.text))
  );
}

/** The element whose child expression is `fn`, as in `<Memo>{() => ...}</Memo>`. */
function childFunctionElement(fn: RuntimeFunctionLike): ts.JsxElement | null {
  let current: ts.Node = fn;
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const container = current.parent;
  const element = ts.isJsxExpression(container) ? container.parent : null;
  return element && ts.isJsxElement(element) ? element : null;
}

function ownerName(node: ts.Node, imports: HookImports): string | null {
  for (
    let current: ts.Node | null = node;
    current;
    current = findAncestor(current, isRuntimeFunctionLike)
  ) {
    const owner = renderOwnerOf(current, imports);
    if (owner) {
      return owner.name;
    }
  }
  return null;
}
