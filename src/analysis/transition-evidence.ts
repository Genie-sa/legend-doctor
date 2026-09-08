import type { SetterMutation, StateCandidate } from "./model.js";
import { callsAreAdjacentDraftWrites, nearestMutationFunction } from "./mutations.js";
import type { FindingsScope } from "./finding-clusters.js";
import type { HookFinding } from "../core/types.js";
import type { StateFlowIndex } from "../project/state-flow/state-flow.js";
import type { StateTransitionEvidence } from "../core/state-transitions.js";
import { runtimeFunctionName } from "./ast-helpers.js";
import ts from "typescript";

/** Keep exact writes behind a transitive group without treating the group as one transaction. */
export function withTransitionEvidence(
  finding: HookFinding,
  state: StateCandidate,
  { analysis }: FindingsScope,
): void {
  const names = finding.assumption?.members?.map((member) => member.name) ?? finding.group?.members;
  if (!names) {
    return;
  }
  const mutations = analysis.states
    .filter((member) => member.owner === state.owner && names.includes(member.valueName))
    .flatMap((member) =>
      (analysis.usageByState.get(member)?.setterCallNodes ?? []).map((call) => ({
        call,
        region: nearestMutationFunction(call, member.owner),
        state: member,
      })),
    )
    .toSorted((left, right) => left.call.getStart() - right.call.getStart());
  finding.transitions = {
    relations: mutationRelations(mutations, analysis.stateFlow),
    writes: mutations.map((mutation) => writeSite(mutation, analysis.sourceFile)),
  };
  if (finding.assumption?.members) {
    finding.assumption.question += transitionReview(finding.transitions);
  }
}

const MAX_REVIEW_PAIRS = 3;

function transitionReview(evidence: StateTransitionEvidence): string {
  const unresolved = evidence.relations.filter((relation) => relation.coexecution === "unknown");
  if (unresolved.length === 0) {
    return " No unresolved same-handler write pairs remain in this bounded analysis; member contracts and safe publication still need to satisfy the question above.";
  }
  const sites = unresolved.slice(0, MAX_REVIEW_PAIRS).map(({ from, to }) => {
    const left = evidence.writes[from]!;
    const right = evidence.writes[to]!;
    return `\`${left.state}\` at ${left.line}:${left.column} and \`${right.state}\` at ${right.line}:${right.column}`;
  });
  const more = unresolved.length > MAX_REVIEW_PAIRS ? ` (${unresolved.length} total)` : "";
  return ` Unresolved write pairs${more}: ${sites.join("; ")}. Inspect their recorded control contexts before answering.`;
}

function writeSite(
  mutation: SetterMutation,
  sourceFile: ts.SourceFile,
): StateTransitionEvidence["writes"][number] {
  const position = sourceFile.getLineAndCharacterOfPosition(mutation.call.getStart(sourceFile));
  return {
    column: position.character + 1,
    controls: controlSites(mutation, sourceFile),
    handler: {
      line: lineOf(mutation.region, sourceFile),
      name: runtimeFunctionName(mutation.region),
    },
    line: position.line + 1,
    state: mutation.state.valueName,
  };
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function controlSites(
  { call, region }: SetterMutation,
  sourceFile: ts.SourceFile,
): StateTransitionEvidence["writes"][number]["controls"] {
  const sites: StateTransitionEvidence["writes"][number]["controls"] = [];
  for (let child: ts.Node = call; child.parent && child !== region; child = child.parent) {
    const kind = controlKind(child);
    if (kind) {
      sites.unshift({ kind, line: lineOf(child.parent, sourceFile) });
    }
  }
  return sites;
}

function controlKind(child: ts.Node): string | null {
  const { parent } = child;
  if (ts.isIfStatement(parent)) {
    return branchKind(child, parent.expression, parent.thenStatement);
  }
  if (ts.isConditionalExpression(parent)) {
    return branchKind(child, parent.condition, parent.whenTrue);
  }
  if (ts.isIterationStatement(parent, false)) {
    return "loop";
  }
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
    return "switch-clause";
  }
  return otherControlKind(child);
}

function branchKind(child: ts.Node, condition: ts.Node, positive: ts.Node): string {
  if (child === condition) {
    return "condition";
  }
  return child === positive ? "then" : "else";
}

function otherControlKind(child: ts.Node): string | null {
  const { parent } = child;
  if (ts.isTryStatement(parent)) {
    if (child === parent.finallyBlock) {
      return "finally";
    }
    return child === parent.tryBlock ? "try" : null;
  }
  if (ts.isCatchClause(parent)) {
    return "catch";
  }
  if (ts.isBinaryExpression(parent) && child === parent.right) {
    return parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ? "short-circuit"
      : null;
  }
  return null;
}

function mutationRelations(
  mutations: readonly SetterMutation[],
  stateFlow: StateFlowIndex,
): StateTransitionEvidence["relations"] {
  const relations: StateTransitionEvidence["relations"] = [];
  for (const [from, left] of mutations.entries()) {
    for (const [to, right] of mutations.entries()) {
      if (to <= from || left.region !== right.region) {
        continue;
      }
      const coexecution = stateFlow.proveSynchronousCoexecution(left.region, left.call, right.call);
      relations.push({
        coexecution,
        from,
        fusion:
          coexecution === "proven" && canFuseLiterals(left, right)
            ? "adjacent-literals"
            : "preserve-source",
        to,
      });
    }
  }
  return relations;
}

function canFuseLiterals(left: SetterMutation, right: SetterMutation): boolean {
  return (
    left.state !== right.state &&
    callsAreAdjacentDraftWrites(left.call, right.call) &&
    hasLiteralArgument(left.call) &&
    hasLiteralArgument(right.call)
  );
}

function hasLiteralArgument(call: ts.CallExpression): boolean {
  const [argument] = call.arguments;
  return (
    call.arguments.length === 1 &&
    argument !== undefined &&
    (ts.isStringLiteral(argument) ||
      ts.isNumericLiteral(argument) ||
      argument.kind === ts.SyntaxKind.TrueKeyword ||
      argument.kind === ts.SyntaxKind.FalseKeyword ||
      argument.kind === ts.SyntaxKind.NullKeyword)
  );
}
