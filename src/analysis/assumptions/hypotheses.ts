import type { AbstentionReason, ResearchStep } from "../../core/types.js";
import type { ClassifiedState, StateCandidate } from "../model.js";
import { isCustomHookOwner, runtimeFunctionName } from "../ast-helpers.js";
import { AssumedLeafContracts } from "./assumed-leaf-contracts.js";
import type { StateClassificationInputs } from "../verdicts/classification-context.js";
import { asyncCommandHypothesis } from "./async-command-hypothesis.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";
import type ts from "typescript";

/** The facts a review finding needs before its blocker can be assumed away. */
export interface HypothesisScope {
  /** Directory report file names are relative to; null when only one file was analyzed. */
  readonly analysisRoot: string | null;
  readonly inputs: StateClassificationInputs;
  /** Sibling states written alongside this one, when the blocker is a co-write. */
  readonly partners: readonly StateCandidate[];
  readonly reportFile: string;
}

/** One blocker switched off, the question whose "yes" justifies it, and where to look to answer. */
export interface Hypothesis {
  /** A verdict that needs no re-classification, for blockers the pipeline cannot express as an input. */
  readonly directVerdict?: ClassifiedState;
  readonly inputs: StateClassificationInputs;
  readonly question: string;
  readonly research: readonly ResearchStep[];
}

const RENDER_READ_LINE_PREVIEW = 5;

type HypothesisBuilder = (scope: HypothesisScope) => Hypothesis | null;

function ownerName(inputs: StateClassificationInputs): string {
  return runtimeFunctionName(inputs.state.owner) ?? "this owner";
}

function joinNames(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  if (quoted.length <= 1) {
    return quoted.join("");
  }
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile = node.getSourceFile()): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function sortedLines(nodes: readonly ts.Node[], sourceFile: ts.SourceFile): number[] {
  return [...new Set(nodes.map((node) => lineOf(node, sourceFile)))].toSorted(
    (left, right) => left - right,
  );
}

function stepsAt(scope: HypothesisScope, nodes: readonly ts.Node[], check: string): ResearchStep[] {
  const lines = sortedLines(nodes, scope.inputs.sourceFile);
  const [line] = lines;
  return line === undefined
    ? []
    : [
        {
          check,
          file: scope.reportFile,
          line,
          lines,
          total: new Set(nodes.map((node) => node.getStart(scope.inputs.sourceFile))).size,
        },
      ];
}

function declarationStep(scope: HypothesisScope): ResearchStep {
  const { state } = scope.inputs;
  return {
    check: `\`${state.valueName}\` is declared here; read its initializer and the setter's callers before answering`,
    file: scope.reportFile,
    line: lineOf(state.call, scope.inputs.sourceFile),
  };
}

function atomicTransitionHypothesis(scope: HypothesisScope): Hypothesis {
  const { inputs, partners } = scope;
  const { state, usage } = inputs;
  const partnerNames = partners.map((partner) => partner.valueName);
  const group =
    partnerNames.length > 0
      ? `alongside ${joinNames(partnerNames)}`
      : "alongside other state cells of this owner";
  return {
    inputs: { ...inputs, hasCompanionWrites: false, hasNonClosingCompanionWrites: false },
    question:
      `\`${state.valueName}\` is written ${group} in the same handlers; confirm the group ` +
      "changes as one atomic transition, so every member can move into observables written " +
      "together inside one `batch`.",
    research: [
      declarationStep(scope),
      ...partners.map((partner) => ({
        check: `\`${partner.valueName}\` is declared here and written together with \`${state.valueName}\`; decide whether both belong to one user-visible transition`,
        file: scope.reportFile,
        line: lineOf(partner.call, inputs.sourceFile),
      })),
      ...stepsAt(
        scope,
        usage.setterCallNodes,
        `this write to \`${state.valueName}\` sits next to writes to ${joinNames(partnerNames) || "sibling states"}; confirm a reader could never observe one without the other`,
      ),
    ],
  };
}

function ownershipFlowClauses({
  hasReactiveMutationPath,
  state,
  usage,
}: StateClassificationInputs): string[] {
  const escaped = usage.escaped
    ? [
        `\`${state.valueName}\` or its setter escapes to code this analysis cannot follow (an unknown hook, a stored callback, or a spread); confirm every escaped consumer reads the value only after render and calls the setter only from an event or effect`,
      ]
    : [];
  const reactive = hasReactiveMutationPath
    ? [
        `the setter of \`${state.valueName}\` is reachable from a Legend reaction or mutation path; confirm those writes run outside React render and may write the observable directly`,
      ]
    : [];
  return [...escaped, ...reactive];
}

function ownershipFlowResearch(scope: HypothesisScope): ResearchStep[] {
  const { hasReactiveMutationPath, state, usage } = scope.inputs;
  const escapes = stepsAt(
    scope,
    usage.escapeNodes,
    `\`${state.valueName}\` or its setter is handed to code the analysis cannot follow here; open the callee and confirm it reads the value only after render and writes only from events or effects`,
  );
  const reactive = hasReactiveMutationPath
    ? stepsAt(
        scope,
        usage.setterCallNodes,
        `this write reaches \`${state.valueName}\` through a path that also calls a Legend mutation; confirm it never runs during render`,
      )
    : [];
  return [declarationStep(scope), ...escapes, ...reactive];
}

function ownershipFlowHypothesis(scope: HypothesisScope): Hypothesis | null {
  const { inputs } = scope;
  const clauses = inputs.usage.shadowed ? [] : ownershipFlowClauses(inputs);
  if (clauses.length === 0) {
    return null;
  }
  return {
    inputs: {
      ...inputs,
      hasReactiveMutationPath: false,
      usage: { ...inputs.usage, escaped: false },
    },
    question: `${clauses.join("; ")}.`,
    research: ownershipFlowResearch(scope),
  };
}

function effectWriteHypothesis(scope: HypothesisScope): Hypothesis {
  const { inputs } = scope;
  const { state, usage } = inputs;
  return {
    inputs: { ...inputs, hasDetachedEffectWrites: true },
    question:
      `an effect in ${ownerName(inputs)} both reads and writes \`${state.valueName}\`; confirm ` +
      "the effect can keep its dependencies and timing while writing the observable and reading " +
      "it with `peek()` instead of the React state.",
    research: [
      declarationStep(scope),
      ...stepsAt(
        scope,
        usage.effectWriteNodes,
        `this effect writes \`${state.valueName}\`; confirm it can keep its dependency list and cleanup while writing the observable instead`,
      ),
      ...stepsAt(
        scope,
        usage.effectReadNodes,
        `this effect reads \`${state.valueName}\`; confirm reading the observable with \`peek()\` here does not change when the effect re-runs`,
      ),
    ],
  };
}

function callbackTimingHypothesis(scope: HypothesisScope): Hypothesis {
  const { inputs } = scope;
  const { state, usage } = inputs;
  return {
    inputs: { ...inputs, hasSafeCommands: true },
    question:
      `\`${state.valueName}\` is read ${usage.deferredReads} time(s) inside deferred callbacks ` +
      "(timers, promises, or subscriptions); confirm those reads may take the observable's " +
      "current value with `peek()` at call time instead of the render snapshot they capture today.",
    research: [
      declarationStep(scope),
      ...stepsAt(
        scope,
        usage.deferredReadNodes,
        `this deferred read of \`${state.valueName}\` captures a render snapshot today; confirm the latest value via \`peek()\` at call time is what the code wants`,
      ),
    ],
  };
}

/** Source files are indexed by identity path; compare both sides the same way before relativizing. */
function childFile(file: string, analysisRoot: string | null): string {
  if (analysisRoot === null) {
    return file;
  }
  const relative = path.relative(pathIdentityKey(analysisRoot), pathIdentityKey(file));
  return relative.startsWith("..") ? file : relative || path.basename(file);
}

function childContractResearch(scope: HypothesisScope, targets: readonly string[]): ResearchStep[] {
  const { childContracts, state, usage } = scope.inputs;
  return targets.flatMap((target) => {
    const sites = stepsAt(
      scope,
      usage.transportNodes.get(target) ?? [],
      `\`${state.valueName}\` is passed to \`${target}\` here; note the prop name and whether the call site is conditional or keyed`,
    );
    const source = childContracts?.resolveComponent(target) ?? null;
    const definition: ResearchStep[] = source
      ? [
          {
            check: `open \`${target}\`: confirm it renders the received prop directly and owns none of its lifecycle (no effects, memoization, or callbacks keyed on it)`,
            file: childFile(source.file, scope.analysisRoot),
            line: lineOf(source.owner),
          },
        ]
      : [];
    return [...sites, ...definition];
  });
}

function childContractHypothesis(scope: HypothesisScope): Hypothesis | null {
  const { inputs } = scope;
  const { childContracts, state, usage } = inputs;
  const targets = [...usage.jsxTargets].toSorted();
  if (!childContracts || targets.length === 0) {
    return null;
  }
  return {
    inputs: {
      ...inputs,
      childContracts: new AssumedLeafContracts(childContracts, new Set(targets)),
    },
    question:
      `\`${state.valueName}\` is passed to ${joinNames(targets)} through props this analysis ` +
      "cannot verify; confirm each target renders the value directly and owns none of its " +
      "lifecycle (no effects, memoization, or callbacks keyed on it), so a leaf subscriber can " +
      "wrap that call site.",
    research: [declarationStep(scope), ...childContractResearch(scope, targets)],
  };
}

function mountIdentityHypothesis(scope: HypothesisScope): Hypothesis {
  const { inputs } = scope;
  const { state, subtree, usage } = inputs;
  const targets = [...usage.jsxTargets].toSorted();
  const reach = targets.length > 0 ? joinNames(targets) : "its subtree";
  const sites = targets.flatMap((target) => usage.transportNodes.get(target) ?? []);
  return {
    inputs: {
      ...inputs,
      subtree: subtree ? { ...subtree, unstable: false } : null,
      usage: { ...usage, unstableTransport: false },
    },
    question:
      `\`${state.valueName}\` reaches ${reach} through a conditional or keyed call site; confirm ` +
      "wrapping that call site in a leaf subscriber keeps the same mount identity (the same " +
      "element mounts under the same key).",
    research: [
      declarationStep(scope),
      ...stepsAt(
        scope,
        sites.length > 0 ? sites : usage.directRenderNodes,
        "this call site is conditional or keyed; confirm a wrapper around it mounts the same element under the same key",
      ),
    ],
  };
}

function renderReadLines(nodes: readonly ts.Node[], sourceFile: ts.SourceFile): string {
  const lines = sortedLines(nodes, sourceFile);
  const preview = lines.slice(0, RENDER_READ_LINE_PREVIEW).join(", ");
  const listed = lines.length > RENDER_READ_LINE_PREVIEW ? `${preview}, …` : preview;
  return `${lines.length === 1 ? "line" : "lines"} ${listed}`;
}

function renderCutHypothesis(scope: HypothesisScope): Hypothesis | null {
  const { inputs } = scope;
  const { materiality, sourceFile, state, usage } = inputs;
  if (
    isCustomHookOwner(state.owner) ||
    jsxElementCount(state.owner) < materiality.broadOwnerJsx ||
    usage.directRenderNodes.length === 0
  ) {
    return null;
  }
  const owner = ownerName(inputs);
  const sites = usage.directRenderNodes.length;
  return {
    directVerdict: {
      action: "use-observable",
      confidence: "probable",
      message:
        `Replace \`${state.valueName}\` with a component-lifetime observable and wrap each of its ` +
        `${sites} render read sites in a leaf subscriber (a \`Memo\` block or a small wrapper ` +
        `component calling \`useValue\`), leaving the rest of ${owner} unsubscribed.`,
    },
    inputs,
    question:
      `\`${state.valueName}\` is read ${sites} ${sites === 1 ? "time" : "times"} in the render of ${owner} ` +
      `(${renderReadLines(usage.directRenderNodes, sourceFile)}); confirm each read site can be ` +
      "wrapped in its own leaf subscriber without changing which elements mount.",
    research: [
      declarationStep(scope),
      ...stepsAt(
        scope,
        usage.directRenderNodes,
        `\`${state.valueName}\` is read in render here; confirm the enclosing element can become a \`Memo\` block or a wrapper component without changing which elements mount`,
      ),
    ],
  };
}

/**
 * The generic leaf-subscriber rewrite for a broad owner: every render read and every transport call
 * site of the state becomes its own subscriber, so the owner stops rendering on updates. It stands
 * in when a more specific hypothesis leaves the same blocker in place.
 */
export function leafWrapHypothesis(scope: HypothesisScope): Hypothesis | null {
  const { inputs } = scope;
  const { materiality, state, usage } = inputs;
  const transports = [...usage.transportNodes.values()].flat();
  if (
    isCustomHookOwner(state.owner) ||
    jsxElementCount(state.owner) < materiality.broadOwnerJsx ||
    usage.directRenderNodes.length + transports.length === 0
  ) {
    return null;
  }
  const owner = ownerName(inputs);
  const reads = usage.directRenderNodes.length;
  const targets = [...usage.jsxTargets].toSorted();
  const sites = [
    reads > 0 ? `${reads} render read ${reads === 1 ? "site" : "sites"}` : "",
    transports.length > 0
      ? `${transports.length} transport call ${transports.length === 1 ? "site" : "sites"} (${joinNames(targets)})`
      : "",
  ].filter((part) => part.length > 0);
  return {
    directVerdict: {
      action: "use-observable",
      confidence: "probable",
      message:
        `Replace \`${state.valueName}\` with a component-lifetime observable and wrap each of its ` +
        `${sites.join(" and ")} in a leaf subscriber (a \`Memo\` block or a small wrapper component ` +
        `calling \`useValue\` and passing the plain value on), leaving the rest of ${owner} unsubscribed.`,
    },
    inputs,
    question:
      `\`${state.valueName}\` still reaches ${sites.join(" and ")} in ${owner}; confirm each site can ` +
      "be wrapped in its own leaf subscriber without changing which elements mount, and that each " +
      "receiving component renders the value directly.",
    research: [
      ...stepsAt(
        scope,
        usage.directRenderNodes,
        `\`${state.valueName}\` is read in render here; confirm the enclosing element can become a \`Memo\` block or a wrapper component without changing which elements mount`,
      ),
      ...stepsAt(
        scope,
        transports,
        `\`${state.valueName}\` is passed to a child here; confirm a wrapper around this call site can subscribe and pass the plain value without changing the child's mount identity`,
      ),
    ],
  };
}

const HYPOTHESES: ReadonlyMap<AbstentionReason, HypothesisBuilder> = new Map([
  ["async-command-origin-unresolved", asyncCommandHypothesis],
  ["atomic-transition-unproven", atomicTransitionHypothesis],
  ["callback-timing-unresolved", callbackTimingHypothesis],
  ["child-contract-unresolved", childContractHypothesis],
  ["effect-write-ownership-unresolved", effectWriteHypothesis],
  ["mount-identity-unproven", mountIdentityHypothesis],
  ["ownership-flow-unresolved", ownershipFlowHypothesis],
  ["render-cut-unproven", renderCutHypothesis],
]);

/** The hypothesis for one blocker, or null when no yes/no fact would unblock it. */
export function hypothesisFor(reason: AbstentionReason, scope: HypothesisScope): Hypothesis | null {
  return HYPOTHESES.get(reason)?.(scope) ?? null;
}
