import type { SetterMutation, StateCandidate } from "../model.js";
import { isRuntimeFunctionLike, lineOf } from "../../core/ast.js";
import { DisjointSet } from "./disjoint-set.js";
import type { StateFlowIndex } from "../../project/state-flow/state-flow.js";
import { mutationsFuseAsLiterals } from "../transition-evidence.js";
import { runtimeFunctionName } from "../ast-helpers.js";
import type ts from "typescript";

const MAX_LISTED_ASSIGNS = 3;

export interface CowrittenEditScope {
  readonly members: readonly StateCandidate[];
  readonly mutations: readonly SetterMutation[];
  readonly sourceFile: ts.SourceFile;
  readonly stateFlow: StateFlowIndex;
  readonly subscriptionHook: string;
}

/** The grouped edit spelled out: the observable's shape, its fused writes, and its leaf reads. */
export function cowrittenEdit(scope: CowrittenEditScope): string {
  const [primary] = scope.members;
  if (!primary) {
    return "";
  }
  const observable = `${observableBase(primary.owner)}$`;
  const fields = scope.members.map((member) => `${member.valueName}: ${initialValue(member)}`);
  return `Concretely: \`const ${observable} = useObservable({ ${fields.join(", ")} })\`; ${assignInstruction(observable, scope)}; and read each member only inside its leaf, as \`${scope.subscriptionHook}(${observable}.${primary.valueName})\`.`;
}

function observableBase(owner: StateCandidate["owner"]): string {
  const name = runtimeFunctionName(owner)?.replace(/^use(?=[A-Z0-9])/u, "") || "local";
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}State`;
}

function initialValue({ call }: StateCandidate): string {
  const [initializer] = call.arguments;
  if (!initializer) {
    return "undefined";
  }
  return isRuntimeFunctionLike(initializer)
    ? `(${initializer.getText()})()`
    : initializer.getText();
}

function assignInstruction(observable: string, scope: CowrittenEditScope): string {
  const assigns = fusedRuns(scope).map(
    (run) =>
      `\`${observable}.assign({ ${run.map(({ call, state }) => `${state.valueName}: ${call.arguments[0]!.getText()}`).join(", ")} })\` at line ${lineOf(run[0]!.call, scope.sourceFile)}`,
  );
  const setter = `\`${observable}.<member>.set(...)\` in place`;
  if (assigns.length === 0) {
    return `replace each setter call with ${setter}`;
  }
  const more =
    assigns.length > MAX_LISTED_ASSIGNS
      ? ` and ${assigns.length - MAX_LISTED_ASSIGNS} more adjacent literal runs`
      : "";
  return `write ${assigns.slice(0, MAX_LISTED_ASSIGNS).join(", ")}${more}; replace every other setter call with ${setter}`;
}

/** Adjacent, proven-coexecuting literal writes of distinct members, each run in source order. */
function fusedRuns({ mutations, stateFlow }: CowrittenEditScope): SetterMutation[][] {
  const union = new DisjointSet(mutations.length);
  for (const [leftIndex, left] of mutations.entries()) {
    for (const [rightIndex, right] of mutations.entries()) {
      if (rightIndex > leftIndex && mutationsFuseAsLiterals(left, right, stateFlow)) {
        union.join(leftIndex, rightIndex);
      }
    }
  }
  return union
    .groups(mutations)
    .filter((run) => run.length > 1 && new Set(run.map(({ state }) => state)).size === run.length)
    .map((run) => run.toSorted((left, right) => left.call.getStart() - right.call.getStart()));
}
