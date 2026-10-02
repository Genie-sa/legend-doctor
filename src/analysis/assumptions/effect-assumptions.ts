import type { ClassifiedEffect, EffectCandidate } from "../model.js";
import { assumptionStatus, ownerFingerprint } from "./state-assumptions.js";
import type { ConfirmationSet } from "./confirmations.js";
import type { StateAssumption } from "../../core/types.js";
import { identityClaim } from "../../rules/effects/render-phase-resets.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { lineOf } from "../../core/ast.js";
import { runtimeFunctionName } from "../ast-helpers.js";
import type ts from "typescript";

export interface EffectAssumptionScope {
  readonly confirmations: ConfirmationSet | null;
  readonly effect: EffectCandidate;
  readonly reportFile: string;
  readonly sourceFile: ts.SourceFile;
}

export interface EffectAssumptionResult {
  readonly assumption: StateAssumption;
  readonly confirmed: ClassifiedEffect | null;
}

const REASON = "dependency-identity-unproven";

/** A render-phase reset waits only on its dependencies keeping their identity between renders. */
export function effectAssumption(
  classification: ClassifiedEffect,
  { confirmations, effect, reportFile, sourceFile }: EffectAssumptionScope,
): EffectAssumptionResult | null {
  const reset = classification.renderPhaseReset;
  if (!reset || !effect.owner) {
    return null;
  }
  const owner = runtimeFunctionName(effect.owner) ?? "anonymous";
  const targets = reset.targets.map((state) => state.valueName).join(",");
  const id = `${reportFile}::${owner}::useEffect:${targets}::${REASON}`;
  const fingerprint = ownerFingerprint(effect.owner, sourceFile);
  const status = assumptionStatus(confirmations?.confirmationFor(id) ?? null, fingerprint);
  return {
    assumption: {
      ...identityQuestion(reset.unprovenDependencies, reportFile, lineOf(effect.call, sourceFile)),
      facts: [REASON],
      fingerprint,
      id,
      ifConfirmed: "reset-during-render",
      renderCost: jsxElementCount(effect.owner),
      status,
      updateSites: 0,
    },
    confirmed:
      status === "confirmed"
        ? {
            action: "reset-during-render",
            confidence: "probable",
            derivedState: null,
            message: reset.instruction,
          }
        : null,
  };
}

function identityQuestion(
  dependencies: readonly string[],
  file: string,
  line: number,
): Pick<StateAssumption, "question" | "research"> {
  const listed = dependencies.map((name) => `\`${name}\``).join(", ");
  const each = dependencies.length === 1 ? "it is" : "each is";
  return {
    question: `${identityClaim(dependencies)} between renders unless the value changes: ${each} a primitive, a state value, or a memoized or cached reference, so comparing with the previous value during render settles instead of looping.`,
    research: [
      {
        check: `trace ${listed} to their sources; a value rebuilt on every render, such as an inline object, array, or function prop, means "no"`,
        file,
        line,
      },
    ],
  };
}
