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
 * or feeds a hook whose result the owner renders, so every update re-renders the owner.
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
    const gate = earlyReturnGate(read, owner);
    const declaration = gate ? null : ownerDeclaration(read, owner, true);
    const pin =
      gate ?? (declaration && rendersDeclaration(declaration, owner) ? declaration : null);
    if (pin) {
      const role = gate
        ? "selects the owner's early return"
        : "feeds an owner-level hook whose result the owner renders";
      return {
        action: "keep-state",
        confidence: "probable",
        message: `Keep \`${valueName}\` as React state; its read at line ${lineOf(pin)} ${role}, so every update re-renders the owner and no smaller subscriber removes a render.`,
      };
    }
  }
  return null;
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

function rendersDeclaration(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
): boolean {
  return boundIdentifiers(declaration.name).some((name) =>
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
          rendersDeclaration(next, owner))
      );
    }),
  );
}

function boundIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? boundIdentifiers(element.name) : [],
  );
}
