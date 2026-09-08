import type {
  AssumptionGroupMember,
  HookFinding,
  ResearchStep,
  StateAction,
  StateAssumption,
} from "../../core/types.js";
import type { ClassifiedState, StateCandidate } from "../model.js";
import { assumptionStatus, ownerFingerprint } from "./state-assumptions.js";
import { isCustomHookOwner, runtimeFunctionName } from "../ast-helpers.js";
import type { ConfirmationSet } from "./confirmations.js";
import type { FindingsScope } from "../finding-clusters.js";
import type { StateClassificationInputs } from "../verdicts/classification-context.js";
import { cowrittenGroupIntro } from "../clusters/cowritten-clusters.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import type ts from "typescript";

/** Every state reachable from one member through the co-write relation, in source order. */
export function cowrittenGroup(
  state: StateCandidate,
  partners: ReadonlyMap<StateCandidate, ReadonlySet<StateCandidate>>,
): readonly StateCandidate[] {
  const members = new Set<StateCandidate>([state]);
  const queue = [state];
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const partner of partners.get(next) ?? []) {
      if (!members.has(partner)) {
        members.add(partner);
        queue.push(partner);
      }
    }
  }
  return [...members].toSorted((left, right) => left.call.getStart() - right.call.getStart());
}

export interface GroupAssumptionScope {
  readonly confirmations: ConfirmationSet | null;
  readonly inputs: StateClassificationInputs;
  readonly members: readonly StateCandidate[];
  readonly reportFile: string;
  readonly result: FindingsScope;
}

/** What one "yes" does to each member: the standalone verdict, or the blocker that remains. */
interface GroupOutcome {
  readonly alone: ClassifiedState;
  readonly member: StateCandidate;
}

export interface GroupAssumptionResult {
  readonly assumption: StateAssumption;
  /** The verdict this member takes once the group is confirmed, or null while the question is open. */
  readonly confirmed: ClassifiedState | null;
  readonly group: NonNullable<HookFinding["group"]> | null;
}

type GroupConversion = Exclude<
  StateAction,
  "delete-derived-state" | "delete-unused-state" | "keep-state" | "review-state"
>;

const GROUP_REASON = "atomic-transition-unproven";

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length <= 1
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** A group answer can move or rehome a member; it never deletes one or overrides a keep. */
function groupConversion(alone: ClassifiedState): GroupConversion | null {
  const { action } = alone;
  if (
    action === "delete-derived-state" ||
    action === "delete-unused-state" ||
    action === "keep-state" ||
    action === "review-state"
  ) {
    return null;
  }
  return action;
}

function convertingOutcomes(outcomes: readonly GroupOutcome[]): GroupOutcome[] {
  return outcomes.filter((outcome) => groupConversion(outcome.alone) !== null);
}

function remainingLabel(alone: ClassifiedState): string {
  return alone.action === "review-state" ? alone.abstentionReason : alone.action;
}

function outcomeLabel(outcome: GroupOutcome): AssumptionGroupMember {
  const { alone, member } = outcome;
  const conversion = groupConversion(alone);
  if (conversion !== null) {
    return { name: member.valueName, outcome: conversion };
  }
  return alone.action === "review-state"
    ? { name: member.valueName, nextBlocker: alone.abstentionReason, outcome: "review-state" }
    : { name: member.valueName, outcome: "review-state" };
}

export function groupId(
  reportFile: string,
  owner: string,
  members: readonly StateCandidate[],
): string {
  const names = members.map((member) => member.valueName).join(",");
  return `${reportFile}::${owner}::{${names}}::${GROUP_REASON}`;
}

function memberResearch(
  scope: GroupAssumptionScope,
  { alone, member }: GroupOutcome,
): ResearchStep[] {
  const { sourceFile } = scope.inputs;
  const names = quotedList(scope.members.map((candidate) => candidate.valueName));
  const remaining =
    groupConversion(alone) === null
      ? `; on its own it stays under review for ${remainingLabel(alone)}`
      : `; on its own it would become ${alone.action}`;
  const writes = scope.result.analysis.usageByState.get(member)?.setterCallNodes ?? [];
  const lines = [...new Set(writes.map((call) => lineOf(call, sourceFile)))].toSorted(
    (left, right) => left - right,
  );
  return [
    {
      check: `\`${member.valueName}\` is declared here and written together with the group${remaining}`,
      file: scope.reportFile,
      line: lineOf(member.call, sourceFile),
    },
    ...(lines.length === 0
      ? []
      : [
          {
            check: `inspect each write to \`${member.valueName}\` in the connected group ${names}; preserve its branch, await, and exception phase, and verify which same-phase writes must publish together`,
            file: scope.reportFile,
            line: lines[0]!,
            lines,
            total: new Set(writes.map((call) => call.getStart(sourceFile))).size,
          },
        ]),
  ];
}

function groupQuestion(owner: string, outcomes: readonly GroupOutcome[]): string {
  const names = quotedList(outcomes.map(({ member }) => member.valueName));
  const converting = convertingOutcomes(outcomes);
  const blocked = outcomes.filter((outcome) => groupConversion(outcome.alone) === null);
  const converts =
    converting.length > 0
      ? ` A "yes" converts ${quotedList(converting.map(({ member }) => member.valueName))} into one observable object with a separate atomic update for each proven synchronous transition.`
      : "";
  const reasons = [...new Set(blocked.map(({ alone }) => remainingLabel(alone)))].join(", ");
  const remains =
    blocked.length > 0
      ? ` ${quotedList(blocked.map(({ member }) => member.valueName))} ${blocked.length === 1 ? "is" : "are"} not converted by this answer (${reasons}); a remaining blocker gets its own question next.`
      : "";
  return `${names} are written together in ${owner}'s handlers; verify the individual write relations in \`transitions\` and confirm a migration that preserves each branch, await, and catch/finally phase. A connected group is not a single atomic transition; synchronous coexecution alone does not authorize merging expressions into one \`assign\`.${converts}${remains}`;
}

function confirmedVerdict(
  outcome: GroupOutcome,
  converting: readonly StateCandidate[],
  hookOwned: boolean,
): ClassifiedState {
  const { alone } = outcome;
  if (groupConversion(alone) === null) {
    return alone;
  }
  const intro = cowrittenGroupIntro(
    converting.map((member) => member.valueName),
    hookOwned,
  );
  return { ...alone, message: `${intro} For \`${outcome.member.valueName}\`: ${alone.message}` };
}

interface ConfirmedGroup {
  readonly confirmed: ClassifiedState;
  readonly group: NonNullable<HookFinding["group"]> | null;
}

function confirmedGroup(
  scope: GroupAssumptionScope,
  own: GroupOutcome,
  outcomes: readonly GroupOutcome[],
): ConfirmedGroup {
  const converting = convertingOutcomes(outcomes).map(({ member }) => member);
  const [primary] = converting;
  const { owner } = scope.inputs.state;
  const id = groupId(scope.reportFile, runtimeFunctionName(owner) ?? "this owner", scope.members);
  return {
    confirmed: confirmedVerdict(own, converting, isCustomHookOwner(owner)),
    group:
      groupConversion(own.alone) !== null && primary
        ? {
            id,
            kind: "state-cluster",
            members: converting.map((member) => member.valueName),
            primary: primary === own.member,
          }
        : null,
  };
}

interface GroupIdentity {
  readonly fingerprint: string;
  readonly id: string;
  readonly status: StateAssumption["status"];
}

function groupIdentity(scope: GroupAssumptionScope, owner: string): GroupIdentity {
  const { confirmations, inputs, members, reportFile } = scope;
  const id = groupId(reportFile, owner, members);
  const fingerprint = ownerFingerprint(inputs.state.owner, inputs.sourceFile);
  return {
    fingerprint,
    id,
    status: assumptionStatus(confirmations?.confirmationFor(id) ?? null, fingerprint),
  };
}

/**
 * One question for a whole co-written group. Members whose standalone proof already passes convert
 * together with a cluster instruction; the rest drop the co-write blocker and surface their next one.
 */
export function groupAssumption(scope: GroupAssumptionScope): GroupAssumptionResult | null {
  const { inputs, members, result } = scope;
  const outcomes = members.map((member) => ({ alone: result.classifyAlone(member), member }));
  const own = outcomes.find(({ member }) => member === inputs.state);
  const [firstConversion] = convertingOutcomes(outcomes);
  if (!own || !firstConversion) {
    return null;
  }
  const owner = runtimeFunctionName(inputs.state.owner) ?? "this owner";
  const { fingerprint, id, status } = groupIdentity(scope, owner);
  const settled = status === "confirmed" ? confirmedGroup(scope, own, outcomes) : null;
  return {
    assumption: {
      facts: [GROUP_REASON],
      fingerprint,
      id,
      ifConfirmed: groupConversion(firstConversion.alone)!,
      members: outcomes.map((outcome) => outcomeLabel(outcome)),
      question: groupQuestion(owner, outcomes),
      renderCost: jsxElementCount(inputs.state.owner),
      research: outcomes.flatMap((outcome) => memberResearch(scope, outcome)),
      status,
      updateSites: inputs.usage.setterCalls,
    },
    confirmed: settled?.confirmed ?? null,
    group: settled?.group ?? null,
  };
}
