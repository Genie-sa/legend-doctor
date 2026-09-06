import type { ClassifiedState, StateCandidate, StateUsage } from "./model.js";
import {
  isEvaluationInert,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import { hasNoEffectReads } from "./state-usage.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../rules/state-proofs/binding-lookup.js";
import { visit } from "../core/ast.js";

export function findLegendValueMirrors(
  states: readonly StateCandidate[],
  usageByState: ReadonlyMap<StateCandidate, StateUsage>,
  bridges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<StateCandidate, ClassifiedState> {
  const mirrors = new Map<StateCandidate, ClassifiedState>();
  if (bridges.size === 0) {
    return mirrors;
  }
  for (const state of states) {
    const usage = usageByState.get(state);
    const mirror = usage ? legendValueMirror(state, usage, bridges) : null;
    if (mirror) {
      mirrors.set(state, mirror);
    }
  }
  return mirrors;
}

function stateOnlyMirrorsSeedBinding(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.setterName !== null &&
    usage.setterCalls > 0 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.setterUsesPreviousValue &&
    hasNoEffectReads(usage) &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.eventReads === 0 &&
    !usage.shadowed &&
    !usage.escaped
  );
}

function nullaryHookCallInitializer(source: ts.VariableDeclaration): ts.CallExpression | null {
  const hookCall = source.initializer ? unwrapTransparentExpression(source.initializer) : null;
  if (
    !hookCall ||
    !ts.isCallExpression(hookCall) ||
    hookCall.arguments.length > 0 ||
    !ts.isIdentifier(hookCall.expression)
  ) {
    return null;
  }
  return hookCall;
}

function legendValueMirror(
  state: StateCandidate,
  usage: StateUsage,
  bridges: ReadonlyMap<string, ReadonlySet<string>>,
): ClassifiedState | null {
  const [initial] = state.call.arguments;
  if (!initial || !ts.isIdentifier(initial) || !stateOnlyMirrorsSeedBinding(state, usage)) {
    return null;
  }
  const source = uniqueVariableDeclaration(state.owner, initial.text);
  const hookCall = source ? nullaryHookCallInitializer(source) : null;
  const writers = hookCall ? bridges.get(hookCall.expression.getText()) : undefined;
  if (
    !source ||
    !hookCall ||
    !writers ||
    !sourceBindingOnlySeedsState(source, state) ||
    !usage.setterCallNodes.every((call) => hasAdjacentBridgeWrite(call, writers))
  ) {
    return null;
  }
  return {
    action: "use-value",
    confidence: "probable",
    message: `Delete the React mirror \`${state.valueName}\` and render from \`${initial.text}\`, the one-hop \`${hookCall.expression.getText()}\` value; every React setter call is paired with the same inert argument to its proven observable writer, which remains the sole update path.`,
  };
}

function sourceBindingOnlySeedsState(
  source: ts.VariableDeclaration,
  state: StateCandidate,
): boolean {
  if (!ts.isIdentifier(source.name) || !state.owner.body) {
    return false;
  }
  const binding = source.name;
  const [initial] = state.call.arguments;
  let references = 0;
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== binding.text ||
      node === binding ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    if (node !== initial) {
      safe = false;
    }
  });
  return safe && references === 1;
}

function hasAdjacentBridgeWrite(
  setterCall: ts.CallExpression,
  writers: ReadonlySet<string>,
): boolean {
  const statement = setterCall.parent;
  if (
    !ts.isExpressionStatement(statement) ||
    statement.expression !== setterCall ||
    !ts.isBlock(statement.parent) ||
    setterCall.arguments.length !== 1 ||
    !setterCall.arguments[0] ||
    !isEvaluationInert(setterCall.arguments[0])
  ) {
    return false;
  }
  const { statements } = statement.parent;
  const index = statements.indexOf(statement);
  return [statements[index - 1], statements[index + 1]].some((candidate) => {
    if (!candidate || !ts.isExpressionStatement(candidate)) {
      return false;
    }
    const expression = unwrapTransparentExpression(candidate.expression);
    if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) {
      return false;
    }
    const [argument] = expression.arguments;
    const [setterArgument] = setterCall.arguments;
    return (
      argument !== undefined &&
      setterArgument !== undefined &&
      ts.isIdentifier(expression.expression) &&
      writers.has(expression.expression.text) &&
      argument.getText() === setterArgument.getText()
    );
  });
}
