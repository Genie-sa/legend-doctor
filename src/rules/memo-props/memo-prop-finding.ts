import type { FreshAllocation, FreshIdentity } from "./identity-model.js";
import type { ElementProp } from "./element-props.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { MemoizedComponent } from "../../project/source-components/memoized-components.js";
import type { RenderTrigger } from "./render-triggers.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { findAncestor } from "../../core/ast.js";
import ts from "typescript";

/** A value whose identity between renders the analyzer cannot establish. */
export interface UnprovenInput {
  readonly name: string;
  readonly reason: string;
}

export interface FreshProp extends ElementProp {
  readonly identity: FreshIdentity;
  /** Owner bindings that could change a stabilized value's identity anyway. */
  readonly blockers: readonly UnprovenInput[];
  /** Whether the allocation reads nothing from the render, so it can move to module scope. */
  readonly hoistable: boolean;
}

/** A memoized element whose owner re-renders it with rebuilt props for state it never reads. */
export interface MemoBust {
  readonly component: MemoizedComponent;
  readonly element: ts.JsxOpeningLikeElement;
  readonly freeTriggers: readonly RenderTrigger[];
  readonly fresh: readonly FreshProp[];
  /** Some write of a free trigger leaves every other input of the element unchanged. */
  readonly isolated: boolean;
  readonly owner: RuntimeFunctionLike;
  readonly unproven: readonly UnprovenInput[];
}

interface FindingSite {
  readonly fileName: string;
  readonly sourceFile: ts.SourceFile;
}

const LISTED_ITEMS = 3;

/**
 * Always a candidate: a memoized child can also render from state outside React, such as a global
 * its owner mutates before an otherwise unrelated update, and that render is what the rebuilt prop
 * lets through.
 */
export function memoPropFinding(bust: MemoBust, site: FindingSite): LegendPracticeFinding {
  const { line, character } = site.sourceFile.getLineAndCharacterOfPosition(
    bust.element.getStart(site.sourceFile),
  );
  return {
    action: "stabilize-memo-prop",
    confidence: "probable",
    disposition: "candidate",
    evidence: memoBustEvidence(bust, site),
    location: { column: character + 1, file: site.fileName, line: line + 1 },
    message: candidateMessage(bust, site),
    practice: "memoization",
  };
}

export function isMemoAllocation(allocation: FreshAllocation): boolean {
  return (
    allocation === "memo with a fresh dependency" || allocation === "memo without dependencies"
  );
}

function candidateMessage(bust: MemoBust, site: FindingSite): string {
  const unproven = distinctInputs(bust);
  const names = listed(unproven.map((input) => `\`${input.name}\``));
  const conditions = [
    `\`${bust.component.name}\` in ${bust.component.file} is shown to render only from its props, state, and subscriptions`,
    ...(unproven.length === 0
      ? []
      : [
          `${names} ${unproven.length === 1 ? "is shown to keep its" : "are shown to keep their"} identity across those renders`,
        ]),
    ...(bust.isolated
      ? []
      : [
          `some write of ${triggerList(bust.freeTriggers, site)} is shown to change nothing else the element reads`,
        ]),
  ];
  return `${busted(bust)}, including renders for ${triggerList(bust.freeTriggers, site)}, which it never reads. ${fixInstructions(bust.fresh, site)} to skip those renders once ${conditions.join(", and ")}.`;
}

function busted(bust: MemoBust): string {
  const verb = bust.fresh.length === 1 ? "is" : "are";
  return `${tagText(bust)} is wrapped in \`${bust.component.wrapper}\`, but ${listed(bust.fresh.map((prop) => `\`${prop.name}\``))} ${verb} recreated on every render of ${ownerName(bust.owner)}`;
}

function memoBustEvidence(bust: MemoBust, site: FindingSite): string[] {
  const unproven = distinctInputs(bust);
  const triggers = triggerList(bust.freeTriggers, site);
  return [
    `${tagText(bust)} resolves to \`${bust.component.name}\` in ${bust.component.file}, wrapped in \`${bust.component.wrapper}\` without a props comparator, so it re-renders when any prop changes identity`,
    ...bust.fresh.map((prop) => freshEvidence(prop, site)),
    ...bust.freeTriggers.map(
      (trigger) =>
        `${ownerName(bust.owner)} re-renders for \`${triggerName(trigger)}\` (${trigger.hook} at line ${lineOf(trigger.declaration, site)}), which neither the element nor the conditions that render it read`,
    ),
    unproven.length === 0
      ? `every other input keeps its identity when only ${triggers} changes`
      : `unproven identity: ${unproven.map((input) => `\`${input.name}\` (${input.reason})`).join(", ")}`,
    ...(bust.isolated
      ? []
      : [`every write of ${triggers} sits beside a write the element may read`]),
  ];
}

function distinctInputs(bust: MemoBust): UnprovenInput[] {
  const inputs = [...bust.unproven, ...bust.fresh.flatMap((prop) => prop.blockers)];
  return [
    ...new Map(inputs.toReversed().map((input) => [input.name, input])).values(),
  ].toReversed();
}

function fixInstructions(fresh: readonly FreshProp[], site: FindingSite): string {
  const [first = "", ...rest] = new Set(fresh.map((prop) => fixInstruction(prop, site)));
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join("; ");
}

function fixInstruction(prop: FreshProp, site: FindingSite): string {
  const { allocation, origin } = prop.identity;
  const subject = ts.isIdentifier(prop.value) ? `\`${prop.value.text}\`` : `\`${prop.name}\``;
  if (allocation === "memo without dependencies") {
    return `give the memo at line ${lineOf(origin, site)} a dependency list`;
  }
  if (allocation === "memo with a fresh dependency") {
    return `stabilize the dependency the memo at line ${lineOf(origin, site)} recreates on every render`;
  }
  if (prop.hoistable) {
    return `move ${subject} to module scope`;
  }
  return `wrap ${subject} in ${allocation === "function" ? "useCallback" : "useMemo"}`;
}

function freshEvidence(prop: FreshProp, site: FindingSite): string {
  const { allocation, origin } = prop.identity;
  const article = /^[aeiou]/u.test(allocation) ? "an" : "a";
  return isMemoAllocation(allocation)
    ? `\`${prop.name}\` comes from ${article} ${allocation} at line ${lineOf(origin, site)}, which returns a new value on every render`
    : `\`${prop.name}\` is ${article} ${allocation} built during render at line ${lineOf(origin, site)}`;
}

function triggerList(triggers: readonly RenderTrigger[], site: FindingSite): string {
  return listed(
    triggers.map(
      (trigger) => `\`${triggerName(trigger)}\` (line ${lineOf(trigger.declaration, site)})`,
    ),
    "or",
  );
}

function triggerName(trigger: RenderTrigger): string {
  const [name] = trigger.names;
  return name ?? trigger.setter?.text ?? trigger.declaration.name.getText();
}

function listed(items: readonly string[], conjunction = "and"): string {
  const shown = items.slice(0, LISTED_ITEMS);
  const hidden = items.length - shown.length;
  if (hidden > 0) {
    return `${shown.join(", ")} ${conjunction} ${hidden} more`;
  }
  return shown.length <= 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} ${conjunction} ${shown.at(-1) ?? ""}`;
}

function tagText(bust: MemoBust): string {
  return `\`<${bust.element.tagName.getText()}>\``;
}

function ownerName(owner: RuntimeFunctionLike): string {
  if ((ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner)) && owner.name) {
    return `\`${owner.name.text}\``;
  }
  const holder = findAncestor(owner, ts.isVariableDeclaration);
  return holder && ts.isIdentifier(holder.name) ? `\`${holder.name.text}\`` : "its owner";
}

function lineOf(node: ts.Node, site: FindingSite): number {
  return site.sourceFile.getLineAndCharacterOfPosition(node.getStart(site.sourceFile)).line + 1;
}
