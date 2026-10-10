import { hookCallName, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import type { HostTagImports } from "../../core/imports.js";
import type { JsxSubtreeNode } from "../deferred-reveal/jsx-subtrees.js";
import { isBooleanExpression } from "../literal-boolean-leaf/boolean-setters.js";
import { isHostTag } from "../../core/imports.js";
import ts from "typescript";

/** The values a slot's state can hold, proven from its declaration and every write. */
export interface StateValues {
  readonly boolean: boolean;
  /** Every string the value can hold, or null when a write is not a string literal. */
  readonly literals: ReadonlySet<string> | null;
}

/** The observable that replaces the slot's value, and every render read it replaces. */
export interface SlotRead {
  readonly observable: string;
  readonly references: readonly ts.Node[];
  readonly values: StateValues;
}

export type ControlFlowSlot =
  | {
      readonly kind: "show";
      readonly alternate: JsxSubtreeNode | null;
      readonly condition: ts.Expression;
      readonly content: JsxSubtreeNode;
    }
  | {
      readonly kind: "switch";
      readonly arms: readonly SwitchArm[];
      readonly fallback: JsxSubtreeNode | null;
    };

interface SwitchArm {
  readonly content: JsxSubtreeNode;
  readonly label: string;
  /** The compared read of the value. */
  readonly reference: ts.Node;
}

export const UNPROVEN_VALUES: StateValues = { boolean: false, literals: null };

const MIN_SWITCH_ARMS = 2;
const MAX_INLINE_BRANCH_LENGTH = 80;
const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/u;
const HOOK_NAME = /^use[A-Z0-9]/u;
const DEFAULT_ARM = "default";
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

/**
 * The child slot of a host element or fragment that holds `node` with no function in between. A
 * host element or fragment never inspects its children, so a `Show`, `Switch`, or `For` element in
 * the slot renders the same tree; a component such as `AnimatePresence` reads its direct children.
 */
export function hostChildSlot(node: ts.Node, hostTags: HostTagImports): ts.JsxExpression | null {
  const boundary = ts.findAncestor(
    node.parent,
    (current) => ts.isJsxExpression(current) || isRuntimeFunctionLike(current),
  );
  const slot = boundary && ts.isJsxExpression(boundary) ? boundary : null;
  const parent = slot?.parent;
  return parent &&
    (ts.isJsxFragment(parent) ||
      (ts.isJsxElement(parent) && isHostTag(parent.openingElement.tagName.getText(), hostTags)))
    ? slot
    : null;
}

/** The host child slot whose whole expression is `expression`. */
export function wholeHostChildSlot(
  expression: ts.Expression,
  hostTags: HostTagImports,
): ts.JsxExpression | null {
  const slot = hostChildSlot(expression, hostTags);
  return slot?.expression &&
    unwrapTransparentExpression(slot.expression) === unwrapTransparentExpression(expression)
    ? slot
    : null;
}

/**
 * The Legend control-flow component that renders `slot` exactly as written. `Show` evaluates its
 * condition with the slot's truthiness and calls only the selected branch; `Switch` looks the value
 * up among its arms. Both re-render with their parent, so captured owner values stay current, and
 * both return the selected element from one position, so branch mount identity is unchanged. A
 * slot that would track another observable, call a hook, or render a falsy non-boolean has no
 * equivalent form.
 */
export function controlFlowSlot(slot: ts.JsxExpression, read: SlotRead): ControlFlowSlot | null {
  const expression = slot.expression ? unwrapTransparentExpression(slot.expression) : null;
  if (
    !expression ||
    read.references.length === 0 ||
    !read.references.every((reference) => nodeWithin(reference, expression)) ||
    readsTrackedOrHookState(expression)
  ) {
    return null;
  }
  return (
    (ts.isConditionalExpression(expression) && switchSlot(expression, read)) ||
    showSlot(expression, read)
  );
}

/** The `Show` or `Switch` element that replaces the slot, with long branches elided. */
export function controlFlowElement(control: ControlFlowSlot, read: SlotRead): string {
  if (control.kind === "show") {
    const condition = read.references.includes(unwrapTransparentExpression(control.condition))
      ? read.observable
      : `() => ${substituted(control.condition, read)}`;
    const alternate = control.alternate
      ? ` else={() => ${branchText(control.alternate, read)}}`
      : "";
    return `<Show if={${condition}}${alternate}>{() => ${branchText(control.content, read)}}</Show>`;
  }
  const arms = [
    ...control.arms.map(
      ({ content, label }) =>
        [IDENTIFIER_NAME.test(label) ? label : JSON.stringify(label), content] as const,
    ),
    ...(control.fallback ? [["default", control.fallback] as const] : []),
  ].map(([key, content]) => `${key}: () => ${branchText(content, read)}`);
  return `<Switch value={${read.observable}}>{{ ${arms.join(", ")} }}</Switch>`;
}

/** Names the reads an elided branch must still rewrite, or an empty string when none are hidden. */
export function elidedReadNote(control: ControlFlowSlot, read: SlotRead): string {
  const branches = control.kind === "show" ? [control.content, control.alternate] : [];
  const hidesRead = branches.some(
    (branch) =>
      branch !== null &&
      !isInlined(branch, read) &&
      read.references.some((reference) => nodeWithin(reference, branch)),
  );
  return hidesRead
    ? ` Inside the child function, read \`${read.observable}.get()\` in place of the subscribed value.`
    : "";
}

/**
 * A `get()` would start tracking inside a Legend selector or row observer, and a hook call cannot
 * move into a conditionally called child function.
 */
export function readsTrackedOrHookState(node: ts.Node): boolean {
  let found = false;
  visit(node, (child) => {
    const name = !found && ts.isCallExpression(child) ? hookCallName(child) : null;
    found ||= name !== null && (name === "get" || HOOK_NAME.test(name));
  });
  return found;
}

/**
 * Narrowing a reference in the condition would not narrow the `get()` that replaces it in a branch,
 * so the value is read on one side only, and never inside a nested callback that runs outside
 * `Show`'s tracking. `&&` renders its falsy left operand, so it must be boolean.
 */
function showSlot(expression: ts.Expression, read: SlotRead): ControlFlowSlot | null {
  const parts = showParts(expression);
  if (!parts) {
    return null;
  }
  const { condition, whenFalse } = parts;
  const content = literalJsx(parts.whenTrue);
  const alternate = whenFalse ? literalJsx(whenFalse) : null;
  const inCondition = read.references.filter((reference) => nodeWithin(reference, condition));
  const valid =
    content !== null &&
    (whenFalse
      ? alternate !== null || rendersNothing(whenFalse)
      : isBooleanCondition(condition, read)) &&
    (inCondition.length === 0 || inCondition.length === read.references.length) &&
    read.references.every(
      (reference) =>
        nodeWithin(reference, condition) || !readsInsideCallback(reference, expression),
    );
  return valid ? { alternate, condition, content, kind: "show" } : null;
}

function showParts(expression: ts.Expression): {
  readonly condition: ts.Expression;
  readonly whenFalse: ts.Expression | null;
  readonly whenTrue: ts.Expression;
} | null {
  if (ts.isConditionalExpression(expression)) {
    return expression;
  }
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ? { condition: expression.left, whenFalse: null, whenTrue: expression.right }
    : null;
}

/**
 * `Switch` indexes its arms object with the value, so every value the state can hold must miss
 * `Object.prototype`, and each compared value must name exactly one arm other than `default`.
 */
function switchSlot(expression: ts.ConditionalExpression, read: SlotRead): ControlFlowSlot | null {
  const { literals } = read.values;
  const chain = literals ? switchChain(expression, read.references) : null;
  if (!literals || !chain) {
    return null;
  }
  const { arms, rest } = chain;
  const fallback = literalJsx(rest);
  const labels = new Set(arms.map((arm) => arm.label));
  return arms.length >= MIN_SWITCH_ARMS &&
    labels.size === arms.length &&
    !labels.has(DEFAULT_ARM) &&
    (fallback !== null || rendersNothing(rest)) &&
    new Set(arms.map((arm) => arm.reference)).size === read.references.length &&
    ![...literals, ...labels].some((value) => PROTOTYPE_KEYS.has(value))
    ? { arms, fallback, kind: "switch" }
    : null;
}

function switchChain(
  expression: ts.ConditionalExpression,
  references: readonly ts.Node[],
): { readonly arms: readonly SwitchArm[]; readonly rest: ts.Expression } | null {
  const arms: SwitchArm[] = [];
  let current: ts.Expression = expression;
  while (ts.isConditionalExpression(current)) {
    const comparison = literalComparison(current.condition, references);
    const content = literalJsx(current.whenTrue);
    if (!comparison || !content) {
      return null;
    }
    arms.push({ content, ...comparison });
    current = unwrapTransparentExpression(current.whenFalse);
  }
  return { arms, rest: current };
}

function literalComparison(
  condition: ts.Expression,
  references: readonly ts.Node[],
): Omit<SwitchArm, "content"> | null {
  const comparison = unwrapTransparentExpression(condition);
  if (
    !ts.isBinaryExpression(comparison) ||
    comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return null;
  }
  const left = unwrapTransparentExpression(comparison.left);
  const right = unwrapTransparentExpression(comparison.right);
  const [reference, literal] = references.includes(left) ? [left, right] : [right, left];
  return references.includes(reference) && ts.isStringLiteralLike(literal)
    ? { label: literal.text, reference }
    : null;
}

function readsInsideCallback(reference: ts.Node, slot: ts.Expression): boolean {
  const boundary = ts.findAncestor(
    reference.parent,
    (current) => current === slot || isRuntimeFunctionLike(current),
  );
  return boundary !== slot;
}

/** `false`, `null`, and `undefined` are the falsy values React renders as nothing. */
function isBooleanCondition(expression: ts.Expression, read: SlotRead): boolean {
  const value = unwrapTransparentExpression(expression);
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isBooleanCondition(value.left, read) && isBooleanCondition(value.right, read);
  }
  return (
    isBooleanExpression(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (read.values.boolean && read.references.includes(value))
  );
}

function rendersNothing(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(value) && value.text === "undefined")
  );
}

function literalJsx(expression: ts.Expression): JsxSubtreeNode | null {
  const value = unwrapTransparentExpression(expression);
  return ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value)
    ? value
    : null;
}

function branchText(branch: JsxSubtreeNode, read: SlotRead): string {
  if (isInlined(branch, read)) {
    return substituted(branch, read);
  }
  if (ts.isJsxFragment(branch)) {
    return "<>…</>";
  }
  if (ts.isJsxSelfClosingElement(branch)) {
    return `<${branch.tagName.getText()} … />`;
  }
  const tag = branch.openingElement.tagName.getText();
  return `<${tag} …>…</${tag}>`;
}

function isInlined(branch: JsxSubtreeNode, read: SlotRead): boolean {
  const text = substituted(branch, read);
  return text.length <= MAX_INLINE_BRANCH_LENGTH && !text.includes("\n");
}

/** The node's source text with every replaced read spelled as a `get()` of the observable. */
function substituted(node: ts.Node, read: SlotRead): string {
  const start = node.getStart();
  const replaced = read.references
    .filter((reference) => nodeWithin(reference, node))
    .toSorted((left, right) => right.getStart() - left.getStart());
  let text = node.getText();
  for (const reference of replaced) {
    const offset = reference.getStart() - start;
    text = `${text.slice(0, offset)}${read.observable}.get()${text.slice(offset + reference.getWidth())}`;
  }
  return text;
}
