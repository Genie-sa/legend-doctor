import type { StateCandidate, StateSubtree, StateUsage } from "../model.js";
import {
  controlFlowElement,
  controlFlowSlot,
  elidedReadNote,
  hostChildSlot,
} from "../../rules/control-flow-components/control-flow-slots.js";
import { isIdentifierNamed, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { StateClassificationContext } from "./classification-context.js";
import type { StateValues } from "../../rules/control-flow-components/control-flow-slots.js";
import { isPureBooleanSetter } from "../../rules/literal-boolean-leaf/boolean-setters.js";
import { lineOf } from "../../core/ast.js";
import ts from "typescript";

/**
 * The gate verdict's always-mounted leaf, written as the Legend component that already is one.
 * A logical gate leaf replaces the slot and a ternary gate leaf wraps the slot's enclosing element;
 * `Show` or `Switch` replaces the slot in either case, so its parent must ignore its children.
 */
export function controlFlowGateMessage(
  { hostTags, state, usage }: StateClassificationContext,
  gate: StateSubtree,
): string | null {
  const references = usage.directRenderNodes;
  const slot = references[0] ? hostChildSlot(references[0], hostTags) : null;
  const read = {
    observable: `${state.valueName}$`,
    references,
    values: stateValues(state, usage),
  };
  const control = slot ? controlFlowSlot(slot, read) : null;
  const replacesGateLeaf =
    slot?.parent === gate.node ||
    (control?.kind === "show" && control.alternate === null && control.content === gate.node);
  if (!slot || !control || !replacesGateLeaf) {
    return null;
  }
  const [component, selection] =
    control.kind === "show"
      ? ["Show", "calls the child function only while the condition holds"]
      : ["Switch", "calls only the selected arm"];
  return `Replace \`${state.valueName}\` with a component-lifetime observable and replace the state-controlled slot at line ${lineOf(slot)} with \`${controlFlowElement(control, read)}\`. \`${component}\` is the only subscriber: it stays mounted, ${selection}, and re-renders with this owner, so each branch keeps its mount behavior and current props.${elidedReadNote(control, read)}`;
}

/**
 * The values React state can hold when its initializer and every setter call are literal or
 * boolean-valued. A setter handed to other code could write anything, so it proves nothing.
 */
function stateValues(state: StateCandidate, usage: StateUsage): StateValues {
  const [initializer] = state.call.arguments;
  const initial =
    initializer && state.call.arguments.length === 1 && usage.setterReferences === usage.setterCalls
      ? unwrapTransparentExpression(initializer)
      : null;
  const writes = usage.setterCallNodes.map(({ arguments: [argument, ...rest] }) =>
    argument && rest.length === 0 ? unwrapTransparentExpression(argument) : null,
  );
  const literalWrites = [initial, ...writes].filter(
    (write): write is ts.StringLiteralLike => write !== null && ts.isStringLiteralLike(write),
  );
  return {
    boolean:
      (initial?.kind === ts.SyntaxKind.TrueKeyword ||
        initial?.kind === ts.SyntaxKind.FalseKeyword) &&
      usage.setterCallNodes.every(
        (call, index) => isPureBooleanSetter(call) || isNegatingUpdater(writes[index] ?? null),
      ),
    literals:
      initial && literalWrites.length === writes.length + 1
        ? new Set(literalWrites.map((write) => write.text))
        : null,
  };
}

/** `(value) => !value`. */
function isNegatingUpdater(updater: ts.Expression | null): boolean {
  if (
    !updater ||
    !ts.isArrowFunction(updater) ||
    updater.parameters.length !== 1 ||
    !ts.isExpression(updater.body)
  ) {
    return false;
  }
  const [parameter] = updater.parameters;
  const body = unwrapTransparentExpression(updater.body);
  return (
    parameter !== undefined &&
    ts.isIdentifier(parameter.name) &&
    ts.isPrefixUnaryExpression(body) &&
    body.operator === ts.SyntaxKind.ExclamationToken &&
    isIdentifierNamed(body.operand, parameter.name.text)
  );
}
