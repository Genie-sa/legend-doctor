import type { ChildComponentSource, ComponentSourceResolver } from "./model.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { HostTagImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isHostTag } from "../../core/imports.js";
import ts from "typescript";

/** The React APIs and element field through which a component can observe its children's types. */
const CHILD_INSPECTION = /\b(?:Children|cloneElement|isValidElement)\b|\.type\b/u;

/** Adds the props and element fields through which a component slots a child or reads its props. */
const CHILD_OBSERVATION = new RegExp(
  `${CHILD_INSPECTION.source}|\\b(?:asChild|Slot)\\b|[\\w)\\]]\\.props\\b`,
  "u",
);

/** How many forwarding components a wrapped element may pass through before reaching a host. */
const MAX_FORWARDING_DEPTH = 3;

/** Beyond the owner's file only intrinsic tags count as hosts, since host imports are per file. */
const INTRINSIC_HOST_TAGS: HostTagImports = {
  hostComponents: new Set(),
  hostNamespaces: new Set(),
};

/** React Native's Android `ScrollView` clones this element to inject `style` and its `children`. */
const CLONED_ELEMENT_PROP = "refreshControl";

export interface ElementIdentityScope {
  readonly hostTags: HostTagImports;
  readonly owner: RuntimeFunctionLike;
  readonly resolveComponent: ComponentSourceResolver;
}

/**
 * Proves that replacing the element at `node` with one of another type (a `Computed` block, a
 * reactive host wrapper, or a leaf subscriber) is invisible to the parent element that receives it.
 * A parent observes its children's types through `Children`, `cloneElement`, `isValidElement`, or
 * `child.type`, as `Stack.Toolbar` does when it keeps only its own button children. The receiving
 * parent must be a host element, or a component resolved from source that uses none of them.
 * Third-party and unresolved parents abstain, and so does any path to the parent other than
 * conditional branches, logical operands, and fragments.
 */
export function replacedElementTypeIsUnobserved(
  node: ts.Node,
  scope: ElementIdentityScope,
): boolean {
  const parent = receivingElement(replacedElement(node), scope.owner);
  if (parent === undefined) {
    return false;
  }
  if (parent === null) {
    return true;
  }
  const tag = parent.openingElement.tagName.getText();
  if (isHostTag(tag, scope.hostTags)) {
    return true;
  }
  const body = scope.resolveComponent(tag)?.owner.body;
  return body !== undefined && !CHILD_INSPECTION.test(body.getText());
}

export interface PassThroughScope {
  readonly hostTags: HostTagImports;
  readonly owner: RuntimeFunctionLike;
  /** Resolves a tag against the imports of `file`, or of the owner's file when `file` is `null`. */
  readonly resolveComponent: (file: string | null, name: string) => ChildComponentSource | null;
}

/**
 * Proves that wrapping the element at `node` in a leaf subscriber is invisible to every element that
 * receives it: the owner's output, a host element, or a source component that only renders its
 * `children` or spreads its props onto elements meeting the same contract, down to a host. No
 * component on that chain may take `asChild`, render a `Slot`, inspect or clone its children, or
 * read another element's `.props`.
 */
export function wrappedElementIsPassedThrough(node: ts.Node, scope: PassThroughScope): boolean {
  const parent = receivingElement(replacedElement(node), scope.owner);
  return (
    parent === null ||
    (parent !== undefined &&
      forwardsChildren(parent.openingElement, scope, { depth: MAX_FORWARDING_DEPTH, file: null }))
  );
}

function forwardsChildren(
  element: ts.JsxOpeningLikeElement,
  scope: PassThroughScope,
  { depth, file }: { readonly depth: number; readonly file: string | null },
): boolean {
  const tag = element.tagName.getText();
  if (isHostTag(tag, file === null ? scope.hostTags : INTRINSIC_HOST_TAGS)) {
    return true;
  }
  const slotted = element.attributes.properties.some(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "asChild",
  );
  const source = depth > 0 && !slotted ? scope.resolveComponent(file, tag) : null;
  const receivers =
    source && !CHILD_OBSERVATION.test(source.body.getText()) ? childrenReceivers(source) : null;
  return (
    receivers?.every((receiver) =>
      forwardsChildren(receiver, scope, { depth: depth - 1, file: source?.file ?? null }),
    ) ?? false
  );
}

/**
 * The elements a component hands its `children` to, directly or through a props spread. Its own
 * output and reads of other props need no proof; any other use of `children` or the props abstains.
 */
function childrenReceivers(source: ChildComponentSource): ts.JsxOpeningLikeElement[] | null {
  const carriers = childrenCarriers(source.owner.parameters[0]?.name);
  const receivers: ts.JsxOpeningLikeElement[] = [];
  let forwardsOnly = carriers !== null;
  visit(source.body, (node) => {
    if (forwardsOnly && ts.isIdentifier(node) && carriers?.has(node.text)) {
      const receiver = childrenReceiver(node, source.owner);
      forwardsOnly = receiver !== undefined;
      if (receiver) {
        receivers.push(receiver);
      }
    }
  });
  return forwardsOnly ? receivers : null;
}

/** The parameter bindings that hold `children`: the props object, a rest element, or `children`. */
function childrenCarriers(binding: ts.BindingName | undefined): ReadonlySet<string> | null {
  if (binding === undefined || ts.isIdentifier(binding)) {
    return new Set(binding ? [binding.text] : []);
  }
  const carriers = ts.isObjectBindingPattern(binding)
    ? binding.elements.filter(
        (element) =>
          element.dotDotDotToken || (element.propertyName ?? element.name).getText() === "children",
      )
    : [];
  return ts.isObjectBindingPattern(binding) &&
    carriers.every((element) => ts.isIdentifier(element.name))
    ? new Set(carriers.map((element) => element.name.getText()))
    : null;
}

function childrenReceiver(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.JsxOpeningLikeElement | null | undefined {
  const { parent } = reference;
  if (ts.isJsxSpreadAttribute(parent)) {
    return parent.parent.parent;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name.text !== "children") {
    return null;
  }
  const element = receivingElement(
    ts.isPropertyAccessExpression(parent) ? parent : reference,
    owner,
  );
  return element ? element.openingElement : element;
}

/**
 * Whether the element that renders `node` is passed as a scroll view's `refreshControl`. A leaf
 * that replaces it must forward the props the scroll view injects, or the list disappears.
 */
export function renderedByClonedPropElement(node: ts.Node): boolean {
  let current: ts.Node | null = findAncestor(node, isJsxElementLike);
  while (current && passesElementThrough(current.parent, current)) {
    current = current.parent;
  }
  return (
    current !== null &&
    ts.isJsxAttribute(current.parent) &&
    current.parent.name.getText() === CLONED_ELEMENT_PROP
  );
}

function isJsxElementLike(node: ts.Node): node is ts.JsxElement | ts.JsxSelfClosingElement {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function replacedElement(node: ts.Node): ts.Node {
  if (ts.isJsxAttribute(node)) {
    return replacedElement(node.parent.parent);
  }
  return ts.isJsxOpeningElement(node) ? node.parent : node;
}

/** The element whose children include `node`, `null` for the owner's output, or `undefined`. */
function receivingElement(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): ts.JsxElement | null | undefined {
  let current = node;
  for (;;) {
    const { parent } = current;
    if (ts.isJsxElement(parent)) {
      return parent;
    }
    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === current)) {
      return findAncestor(current, isRuntimeFunctionLike) === owner ? null : undefined;
    }
    if (!passesElementThrough(parent, current)) {
      return undefined;
    }
    current = parent;
  }
}

function passesElementThrough(parent: ts.Node, child: ts.Node): boolean {
  if (ts.isConditionalExpression(parent)) {
    return parent.condition !== child;
  }
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      (operator === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child)
    );
  }
  return (
    ts.isParenthesizedExpression(parent) || ts.isJsxExpression(parent) || ts.isJsxFragment(parent)
  );
}
