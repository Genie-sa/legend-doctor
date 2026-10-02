import {
  calleeName,
  findAncestorUntil,
  lineOf,
  nearestNestedFunction,
  nodeWithin,
} from "../../core/ast.js";
import { isJsxNode, isSynchronousRenderCallback } from "../../rules/state-proofs/callback-sites.js";
import type { ClassifiedState } from "../model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateClassificationInputs } from "./classification-context.js";
import { isCustomHookOwner } from "../ast-helpers.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

/** Hooks whose arguments only seed mount-time state or build a callback, never rendered output. */
const UNRENDERED_ARGUMENT_HOOKS: ReadonlySet<string> = new Set([
  "useCallback",
  "useReducer",
  "useRef",
  "useState",
]);

/**
 * A review no subscriber smaller than the owner can settle: a read selects the owner's early return
 * or the tree it returns, or feeds a hook whose result the owner renders, so every update
 * re-renders the owner.
 */
export function noSmallerBoundaryVerdict({
  state,
  usage,
}: StateClassificationInputs): ClassifiedState | null {
  const { owner, valueName } = state;
  const valueEscapes = usage.escapeNodes.filter(
    (node) => ts.isIdentifier(node) && node.text === valueName,
  );
  for (const read of [...usage.directRenderNodes, ...valueEscapes]) {
    const pin = boundaryPin(read, owner);
    if (pin) {
      return {
        action: "keep-state",
        confidence: "probable",
        message: `Keep \`${valueName}\` as React state; its read at line ${lineOf(pin.node)} ${pin.role}, so every update re-renders the owner and no smaller subscriber removes a render.`,
      };
    }
  }
  return null;
}

interface BoundaryPin {
  readonly node: ts.Node;
  readonly role: string;
}

function boundaryPin(read: ts.Node, owner: RuntimeFunctionLike): BoundaryPin | null {
  const gate = earlyReturnGate(read, owner);
  if (gate) {
    return { node: gate, role: "selects the owner's early return" };
  }
  const selector = returnedBranchSelector(read, owner);
  if (selector) {
    return { node: selector, role: "selects which tree the owner returns" };
  }
  const declaration = ownerDeclaration(read, owner, true);
  return declaration && rendersDeclaration(declaration, owner)
    ? { node: declaration, role: "feeds an owner-level hook whose result the owner renders" }
    : null;
}

function earlyReturnGate(node: ts.Node, owner: RuntimeFunctionLike): ts.IfStatement | null {
  const gate = findAncestorUntil(node, ts.isIfStatement, owner);
  if (!gate || gate.parent !== owner.body || !nodeWithin(node, gate.expression)) {
    return null;
  }
  const branch = gate.thenStatement;
  return ts.isReturnStatement(branch) ||
    (ts.isBlock(branch) && branch.statements.some(ts.isReturnStatement))
    ? gate
    : null;
}

const SELECTING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/**
 * The conditional a component returns at its top level, when `node` sits in its condition. A custom
 * hook returns a value its host may read from a smaller subscriber instead.
 */
function returnedBranchSelector(node: ts.Node, owner: RuntimeFunctionLike): ts.Expression | null {
  if (isCustomHookOwner(owner)) {
    return null;
  }
  for (let current = node.parent; current !== owner; current = current.parent) {
    if (
      (ts.isConditionalExpression(current) && nodeWithin(node, current.condition)) ||
      (ts.isBinaryExpression(current) &&
        SELECTING_OPERATORS.has(current.operatorToken.kind) &&
        nodeWithin(node, current.left))
    ) {
      return isReturnedRoot(current, owner) ? current : null;
    }
  }
  return null;
}

function isReturnedRoot(expression: ts.Expression, owner: RuntimeFunctionLike): boolean {
  let root: ts.Node = expression;
  while (ts.isParenthesizedExpression(root.parent)) {
    root = root.parent;
  }
  return (
    root === owner.body || (ts.isReturnStatement(root.parent) && root.parent.parent === owner.body)
  );
}

/** The owner-level declaration initialized from `node`, optionally only through a rendered hook. */
function ownerDeclaration(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  throughHook: boolean,
): ts.VariableDeclaration | null {
  let crossedHook = false;
  for (let current = node.parent; current !== owner; current = current.parent) {
    const hook = ts.isCallExpression(current) ? (calleeName(current.expression) ?? "") : "";
    crossedHook ||= /^use[A-Z0-9]/u.test(hook) && !UNRENDERED_ARGUMENT_HOOKS.has(hook);
    if (ts.isVariableDeclaration(current) && current.parent.parent.parent === owner.body) {
      return crossedHook || !throughHook ? current : null;
    }
  }
  return null;
}

/**
 * Whether the owner renders `declaration` directly or through later owner-level declarations. Each
 * declaration is settled once: a chain of declarations that each read the previous one several
 * times would otherwise revisit every path through it.
 */
function rendersDeclaration(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
  settled = new Map<ts.VariableDeclaration, boolean>(),
): boolean {
  const known = settled.get(declaration);
  if (known !== undefined) {
    return known;
  }
  const renders = boundIdentifiers(declaration.name).some((name) =>
    ownerLevelReferences(owner, name).some((reference) => {
      const callback = nearestNestedFunction(reference, owner);
      if (callback && !isSynchronousRenderCallback(callback)) {
        return false;
      }
      const next = ownerDeclaration(reference, owner, false);
      return (
        findAncestorUntil(reference, isJsxNode, owner) !== null ||
        findAncestorUntil(reference, ts.isReturnStatement, owner) !== null ||
        earlyReturnGate(reference, owner) !== null ||
        (next !== null &&
          next.getStart() > declaration.getStart() &&
          rendersDeclaration(next, owner, settled))
      );
    }),
  );
  settled.set(declaration, renders);
  return renders;
}

function boundIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? boundIdentifiers(element.name) : [],
  );
}
