import {
  identifiersNamed,
  nearestNestedFunction,
  nodeWithin,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { callbackBindingName } from "./site-write-roots.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

type RenderedElement = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

/**
 * The chain of child slots from a branch root down to a position: the elements on the way, and the
 * position itself when it is a child expression or call rather than an element.
 */
interface SlotChain {
  readonly elements: readonly RenderedElement[];
  readonly tail: ts.Node | null;
}

const FRAGMENT_TAG = "<>";
const FRAGMENT_TAG_NAMES: ReadonlySet<string> = new Set(["Fragment", "React.Fragment"]);

/**
 * Whether the element type rendered at `position` can change, by wrapping it or moving it into
 * another component, without remounting anything at runtime. React reuses a fiber only for an
 * element of the same type in the same child slot, so the position is safe unless another arm of an
 * enclosing conditional, or another return of a function that renders it, can place a same-typed
 * element along the same chain of child slots. An alternate whose chain diverges in type, or runs
 * out of children, remounts the position whenever the branch switches anyway.
 *
 * `position` is a JSX element, fragment, child expression, or call inside `owner`'s render. Inside a
 * render callback the walk continues from the call or element that places the callback's output,
 * and inside a local render helper from every call site. Any other route to the output, such as a
 * `const`, an attribute value, or a `||` or `??` operand, is not proven and returns `false`.
 */
export function typeChangeKeepsMountIdentity(
  position: ts.Node,
  owner: RuntimeFunctionLike,
): boolean {
  return positionKeepsMountIdentity(position, owner, new Set());
}

function positionKeepsMountIdentity(
  position: ts.Node,
  owner: RuntimeFunctionLike,
  seen: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  const renderer = nearestNestedFunction(position, owner) ?? owner;
  const output = outputChain(position, renderer);
  return (
    output !== null &&
    rendererReturns(renderer).every(
      (other) => other === output.returned || alternateDiverges(other.expression, output.chain),
    ) &&
    placementKeepsMountIdentity(renderer, owner, seen)
  );
}

interface OutputChain {
  readonly chain: SlotChain;
  /** The return statement that renders the position, `null` for an arrow's expression body. */
  readonly returned: ts.ReturnStatement | null;
}

function outputChain(position: ts.Node, renderer: RuntimeFunctionLike): OutputChain | null {
  const elements: RenderedElement[] = [];
  const tail = isRenderedElement(position) ? null : position;
  for (let current: ts.Node = position; ; current = current.parent) {
    if (isRenderedElement(current)) {
      elements.unshift(current);
    }
    const { parent } = current;
    if (parent === renderer || ts.isReturnStatement(parent)) {
      return { chain: { elements, tail }, returned: ts.isReturnStatement(parent) ? parent : null };
    }
    if (!slotPassesThrough(parent, current, { elements, tail })) {
      return null;
    }
  }
}

function slotPassesThrough(parent: ts.Node, child: ts.Node, chain: SlotChain): boolean {
  if (ts.isConditionalExpression(parent)) {
    const other = parent.whenTrue === child ? parent.whenFalse : parent.whenTrue;
    return parent.condition !== child && alternateDiverges(other, chain);
  }
  if (ts.isBinaryExpression(parent)) {
    return (
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child
    );
  }
  return (
    ts.isParenthesizedExpression(parent) ||
    ts.isJsxExpression(parent) ||
    ts.isJsxElement(parent) ||
    ts.isJsxFragment(parent)
  );
}

/**
 * Whether every element the alternate can render in the slot differs in type from the chain at some
 * depth, or lacks the child slot the chain continues into. A chain matched down to the position
 * means React would reuse its fiber.
 */
function alternateDiverges(alternate: ts.Node | undefined, chain: SlotChain, depth = 0): boolean {
  const expected = chain.elements[depth];
  if (!expected) {
    return alternate === undefined || slotIsEmpty(alternate);
  }
  const candidates = alternate ? slotCandidates(alternate) : [];
  return (
    candidates !== null &&
    candidates.every(
      (candidate) =>
        elementTag(candidate) !== elementTag(expected) ||
        childSlotDiverges(candidate, chain, depth),
    )
  );
}

function childSlotDiverges(candidate: RenderedElement, chain: SlotChain, depth: number): boolean {
  const parent = chain.elements[depth];
  const next = chain.elements[depth + 1] ?? chain.tail;
  if (!parent || !next) {
    return false;
  }
  const index = renderedChildren(parent).findIndex(
    (child) => child === next || nodeWithin(next, child),
  );
  return index !== -1 && alternateDiverges(renderedChildren(candidate)[index], chain, depth + 1);
}

/** The elements an expression can render in one slot, or `null` when that is unknown. */
function slotCandidates(node: ts.Node): readonly RenderedElement[] | null {
  if (isRenderedElement(node)) {
    return [node];
  }
  if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) {
    return node.expression ? slotCandidates(node.expression) : [];
  }
  return (
    operatorCandidates(node) ?? constElementCandidates(node) ?? (rendersNoElement(node) ? [] : null)
  );
}

/** A `const` holds the elements its initializer renders, so a slot that reads it places those. */
function constElementCandidates(node: ts.Node): readonly RenderedElement[] | null {
  const binding = ts.isIdentifier(node) ? lexicalBinding(node) : null;
  const declaration = binding?.kind === "value" ? binding.declaration : null;
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer &&
    !nodeWithin(node, declaration)
    ? slotCandidates(declaration.initializer)
    : null;
}

function operatorCandidates(node: ts.Node): readonly RenderedElement[] | null {
  if (ts.isConditionalExpression(node)) {
    const whenTrue = slotCandidates(node.whenTrue);
    const whenFalse = slotCandidates(node.whenFalse);
    return whenTrue && whenFalse && [...whenTrue, ...whenFalse];
  }
  return ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ? slotCandidates(node.right)
    : null;
}

function rendersNoElement(node: ts.Node): boolean {
  return (
    slotIsEmpty(node) ||
    ts.isJsxText(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isTemplateExpression(node) ||
    ts.isNumericLiteral(node)
  );
}

/** A slot value React renders as no fiber at all. */
function slotIsEmpty(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) {
    return node.expression === undefined || slotIsEmpty(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return slotIsEmpty(node.whenTrue) && slotIsEmpty(node.whenFalse);
  }
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  );
}

/** The children React reconciles by index: whitespace-only lines and empty expressions drop out. */
function renderedChildren(element: RenderedElement): readonly ts.JsxChild[] {
  if (ts.isJsxSelfClosingElement(element)) {
    return [];
  }
  return element.children.filter(
    (child) =>
      !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) &&
      !(ts.isJsxExpression(child) && child.expression === undefined),
  );
}

function elementTag(element: RenderedElement): string {
  if (ts.isJsxFragment(element)) {
    return FRAGMENT_TAG;
  }
  const tag = (ts.isJsxElement(element) ? element.openingElement : element).tagName.getText();
  return FRAGMENT_TAG_NAMES.has(tag) ? FRAGMENT_TAG : tag;
}

function isRenderedElement(node: ts.Node): node is RenderedElement {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

function rendererReturns(renderer: RuntimeFunctionLike): readonly ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  if (renderer.body) {
    visitSkippingNestedRuntimeFunctions(renderer.body, (node) => {
      if (ts.isReturnStatement(node)) {
        returns.push(node);
      }
    });
  }
  return returns;
}

function placementKeepsMountIdentity(
  renderer: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
  seen: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  if (renderer === owner) {
    return true;
  }
  if (seen.has(renderer)) {
    return false;
  }
  const nextSeen = new Set([...seen, renderer]);
  const placements = outputPlacements(renderer, owner);
  return (
    placements !== null &&
    placements.every((site) => positionKeepsMountIdentity(site, owner, nextSeen))
  );
}

/** Where a nested renderer's output lands in the owner's tree, or `null` when that is unknown. */
function outputPlacements(
  renderer: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
): readonly ts.Node[] | null {
  const name = callbackBindingName(renderer);
  if (name !== null) {
    return helperCallSites(name, owner);
  }
  const { parent } = renderer;
  if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === renderer)) {
    return [parent];
  }
  const element = ts.isJsxExpression(parent) ? renderPropElement(parent) : null;
  return element && [element];
}

/** The element whose children or attribute receives a render function. */
function renderPropElement(expression: ts.JsxExpression): ts.Node | null {
  const { parent } = expression;
  if (ts.isJsxElement(parent)) {
    return parent;
  }
  if (!ts.isJsxAttribute(parent)) {
    return null;
  }
  const opening = parent.parent.parent;
  return ts.isJsxOpeningElement(opening) ? opening.parent : opening;
}

function helperCallSites(
  name: string,
  owner: RuntimeFunctionLike,
): readonly ts.CallExpression[] | null {
  const references = identifiersNamed(owner.body ?? owner, name).filter(
    (reference) => !isDeclarationName(reference) && !isNonValueIdentifier(reference),
  );
  const calls = references.flatMap((reference) =>
    ts.isCallExpression(reference.parent) && reference.parent.expression === reference
      ? [reference.parent]
      : [],
  );
  return calls.length > 0 && calls.length === references.length ? calls : null;
}
