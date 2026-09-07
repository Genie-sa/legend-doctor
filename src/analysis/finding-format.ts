import type {
  ClassifiedEffect,
  ClassifiedState,
  EffectCandidate,
  StateCandidate,
  StateUsage,
} from "./model.js";
import type { HookAction, HookFinding, StateAction } from "../core/types.js";
import { ownerLineSpan, runtimeFunctionName } from "./ast-helpers.js";
import type { MaterialityPolicy } from "./constants.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { WIDE_OWNER_LINE_SPAN } from "./constants.js";
import { callbackHasCleanup } from "../rules/effects/effects.js";
import { jsxElementCount } from "../rules/state-proofs/jsx-subtrees.js";
import path from "node:path";
import type ts from "typescript";

interface FindingContext {
  readonly evidence?: readonly string[];
  readonly fileName: string;
  readonly hook: "useEffect" | "useState";
  readonly name: string | null;
  readonly sourceFile: ts.SourceFile;
}

export function findingFor(
  call: ts.CallExpression,
  classification: ClassifiedState | ClassifiedEffect,
  context: FindingContext,
): HookFinding {
  const { evidence = [], fileName, hook, name, sourceFile } = context;
  const position = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  const base = {
    confidence: classification.confidence,
    disposition: dispositionFor(classification.action),
    evidence,
    hook,
    location: {
      column: position.character + 1,
      file: path.normalize(fileName),
      line: position.line + 1,
    },
    message: classification.message,
    name,
  };
  if (classification.action === "review-state" || classification.action === "review-effect") {
    const reviewFinding = {
      ...base,
      action: classification.action,
      abstentionReason: classification.abstentionReason,
    };
    return hook === "useState"
      ? { ...reviewFinding, stateModel: stateModelFor("review-state") }
      : reviewFinding;
  }
  const action: Exclude<HookAction, "review-effect" | "review-state"> = classification.action;
  if (hook !== "useState") {
    return { ...base, action };
  }
  // SAFETY: a "useState" hook is only ever classified by classifyState, whose action is a StateAction.
  return { ...base, action, stateModel: stateModelFor(action as StateAction) };
}

function dispositionFor(action: HookFinding["action"]): HookFinding["disposition"] {
  if (action === "keep-effect" || action === "keep-state") {
    return "keep";
  }
  if (
    action === "review-effect" ||
    action === "review-state" ||
    action === "persist-observable" ||
    action === "use-mount" ||
    action === "use-unmount"
  ) {
    return "candidate";
  }
  return "change";
}

export interface StructuralCandidateScope {
  readonly materiality: MaterialityPolicy;
  readonly sourceFile: ts.SourceFile;
}

export function isStructuralLegendCandidate(
  state: StateCandidate,
  usage: StateUsage,
  { materiality, sourceFile }: StructuralCandidateScope,
): boolean {
  return (
    ownerLineSpan(state.owner, sourceFile) >= WIDE_OWNER_LINE_SPAN &&
    jsxElementCount(state.owner) >= materiality.broadOwnerJsx &&
    usage.localRenderReads === 0 &&
    usage.transportedOccurrences > 0
  );
}

export function legendCandidateMessage(
  state: StateCandidate,
  usage: StateUsage,
  sourceComponents: ReadonlySet<string> = new Set(),
): string {
  const targets = [...usage.jsxTargets].toSorted().join(", ") || "the receiving descendants";
  const resolved = [...usage.jsxTargets].filter((target) => sourceComponents.has(target));
  const proof =
    resolved.length > 0
      ? ` Source declarations resolved for ${resolved.toSorted().join(", ")}, but their prop contracts and mount identity still need verification.`
      : "";
  return `Legend-first restructuring candidate: keep \`${state.valueName}\` in a stable observable owner and subscribe only inside ${targets}; verify the child contract before changing it.${proof}`;
}

const STATE_MODEL_BY_ACTION = {
  "delete-derived-state": { ownership: "delete", subscription: "none" },
  "delete-unused-state": { ownership: "delete", subscription: "none" },
  "keep-state": { ownership: "react", subscription: "owner-react" },
  "move-state-down": { ownership: "react", subscription: "leaf-react" },
  "review-state": { ownership: "review", subscription: "review" },
  "use-observable": { ownership: "local-observable", subscription: "leaf-use-value" },
  "use-ref": { ownership: "ref", subscription: "none" },
  "use-value": { ownership: "existing-observable", subscription: "owner-use-value" },
} satisfies Record<StateAction, NonNullable<HookFinding["stateModel"]>>;

function stateModelFor(action: StateAction): NonNullable<HookFinding["stateModel"]> {
  return { ...STATE_MODEL_BY_ACTION[action] };
}

export function stateEvidence(
  state: StateCandidate,
  usage: StateUsage,
  sourceFile: ts.SourceFile,
): readonly string[] {
  return [
    `${ownerEvidence(state.owner, sourceFile)}, JSX elements ${jsxElementCount(state.owner)}`,
    `reads: render ${usage.localRenderReads}, effects ${usage.effectReads}, deferred ${usage.deferredReads}, transported ${usage.transportedOccurrences}`,
    `writes: setter calls ${usage.setterCalls}, effect writes ${usage.effectWrites}`,
    `transport targets: ${[...usage.jsxTargets].toSorted().join(", ") || "none"}`,
  ];
}

export function effectEvidence(
  effect: EffectCandidate,
  sourceFile: ts.SourceFile,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): readonly string[] {
  return [
    effect.owner ? ownerEvidence(effect.owner, sourceFile) : "owner: unresolved",
    `dependencies: ${effect.dependencies?.elements.length ?? "unresolved"}`,
    `cleanup: ${effect.callback ? callbackHasCleanup(effect.callback, stateBySetter) : "unresolved"}`,
  ];
}

function ownerEvidence(owner: RuntimeFunctionLike, sourceFile: ts.SourceFile): string {
  const start = sourceFile.getLineAndCharacterOfPosition(owner.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(owner.end).line + 1;
  return `owner: ${runtimeFunctionName(owner) ?? "anonymous"}, lines ${start}-${end}`;
}
