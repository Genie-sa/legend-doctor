import type { StateCandidate, StateUsage } from "../model.js";
import { isRuntimeFunctionLike, nodeWithin, visitSkippingNestedFunctions } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { calleeName } from "../ast-helpers.js";
import ts from "typescript";

export interface ReactiveMutationPathCoverage {
  readonly all: boolean;
  readonly any: boolean;
}

export function setterReactiveMutationPaths(
  state: StateCandidate,
  usage: StateUsage,
  mutationBindings: ReadonlySet<string>,
): ReactiveMutationPathCoverage {
  let any = false;
  let all = mutationBindings.size > 0 && usage.setterCallNodes.length > 0;
  for (const call of usage.setterCallNodes) {
    const pathHasMutation =
      mutationBindings.size > 0 &&
      functionAncestors(call, state.owner).some((ancestor) =>
        functionDirectlyCallsBinding(ancestor, mutationBindings),
      );
    any ||= pathHasMutation;
    all &&= pathHasMutation;
  }
  return { all, any };
}

function functionAncestors(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike[] {
  const ancestors: RuntimeFunctionLike[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) {
      ancestors.push(current);
    }
    if (current === owner) {
      break;
    }
  }
  return ancestors;
}

function functionDirectlyCallsBinding(
  fn: RuntimeFunctionLike,
  bindings: ReadonlySet<string>,
): boolean {
  if (!fn.body) {
    return false;
  }
  let calls = false;
  visitSkippingNestedFunctions(fn.body, fn, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const { expression } = node;
    if (ts.isIdentifier(expression) && bindings.has(expression.text)) {
      calls = true;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      bindings.has(`${expression.expression.text}.${expression.name.text}`)
    ) {
      calls = true;
    }
  });
  return calls;
}

export function setterCallbackEscapesThroughUnknownHook(
  state: StateCandidate,
  usage: StateUsage,
): boolean {
  return usage.setterCallNodes.some((call) => {
    for (
      let current: ts.Node | undefined = call.parent;
      current && current !== state.owner;
      current = current.parent
    ) {
      const hookName = ts.isCallExpression(current) ? calleeName(current.expression) : null;
      if (
        hookName &&
        /^use[A-Z0-9]/u.test(hookName) &&
        !["useCallback", "useEffect"].includes(hookName) &&
        ts.isCallExpression(current) &&
        current.arguments.some((argument) => nodeWithin(call, argument))
      ) {
        return true;
      }
    }
    return false;
  });
}
