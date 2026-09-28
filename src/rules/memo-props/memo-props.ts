import type { DisabledRule, LegendPracticeFinding } from "../../core/types.js";
import type { FreshProp, MemoBust, UnprovenInput } from "./memo-prop-finding.js";
import type { HookResolver, IdentityContext } from "./identity-model.js";
import { expressionIdentity, freeOwnerIdentifiers } from "./prop-identity.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import { isMemoAllocation, memoPropFinding } from "./memo-prop-finding.js";
import { readsOwnerProps, triggerChangesAlone } from "./trigger-isolation.js";
import { renderTriggers, triggerReads } from "./render-triggers.js";
import type { ElementInputs } from "./trigger-isolation.js";
import type { ElementProp } from "./element-props.js";
import type { MemoizedComponent } from "../../project/source-components/memoized-components.js";
import type { RenderReach } from "./render-reach.js";
import type { RenderTrigger } from "./render-triggers.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingDeclaration } from "./identity-model.js";
import { elementProps } from "./element-props.js";
import { isNonValueIdentifier } from "../../core/analysis-ast.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { renderGates } from "./render-gates.js";
import { renderReach } from "./render-reach.js";
import ts from "typescript";

export interface MemoPropScan {
  readonly fileName: string;
  /** The memoized component a module-scope JSX tag renders, or null when it is not memoized. */
  readonly memoizedComponentFor: (localName: string) => MemoizedComponent | null;
  readonly resolveHook: HookResolver;
  readonly sourceFile: ts.SourceFile;
}

/** A memoized element that receives at least one prop its owner allocates on every render. */
interface BustCandidate {
  readonly component: MemoizedComponent;
  readonly element: ts.JsxOpeningLikeElement;
  readonly fresh: readonly FreshProp[];
  readonly owner: RuntimeFunctionLike;
  readonly props: readonly ElementProp[];
}

export const MEMO_PROPS_COMPILER_GATE: Omit<DisabledRule, "files"> = {
  detail:
    "the React Compiler memoizes render-scope allocations, so props built during render keep their identity",
  reason: "react-compiler",
  rule: "memo-props",
};

/**
 * JSX elements that hand a memoized component a value their owner allocates on every render,
 * where the owner also renders for state the element never reads. Each such render re-renders
 * the memoized component with inputs that are equal in value but not in identity.
 */
export function findMemoPropPractices(scan: MemoPropScan): LegendPracticeFinding[] {
  const busts: MemoBust[] = [];
  visit(scan.sourceFile, (node) => {
    const bust =
      ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
        ? memoBust(node, scan)
        : null;
    if (bust) {
      busts.push(bust);
    }
  });
  return busts
    .filter((bust) => !insideFreshProp(bust, busts))
    .map((bust) => memoPropFinding(bust, scan));
}

/** Stabilizing an enclosing element's fresh prop also reuses every element inside that prop. */
function insideFreshProp(bust: MemoBust, busts: readonly MemoBust[]): boolean {
  return busts.some(
    (other) => other !== bust && other.fresh.some((prop) => nodeWithin(bust.element, prop.value)),
  );
}

function memoBust(element: ts.JsxOpeningLikeElement, scan: MemoPropScan): MemoBust | null {
  const component = memoizedTag(element.tagName, scan);
  const owner = findAncestor(element, isRuntimeFunctionLike);
  if (!component || component.comparator || !owner) {
    return null;
  }
  const context: IdentityContext = { owner, resolveHook: scan.resolveHook };
  const props = elementProps(element, context);
  const fresh = props.flatMap((prop) => freshProp(prop, context));
  return fresh.length > 0 ? ownerRenders({ component, element, fresh, owner, props }) : null;
}

/** Only a module-scope binding names the same component on every render. */
function memoizedTag(tag: ts.JsxTagNameExpression, scan: MemoPropScan): MemoizedComponent | null {
  if (!ts.isIdentifier(tag)) {
    return null;
  }
  const binding = lexicalBinding(tag);
  const moduleScope =
    binding?.kind === "import" ||
    ((binding?.kind === "value" || binding?.kind === "function") &&
      findAncestor(binding.declaration, isRuntimeFunctionLike) === null);
  return moduleScope ? scan.memoizedComponentFor(tag.text) : null;
}

function ownerRenders(candidate: BustCandidate): MemoBust | null {
  const triggers = renderTriggers(candidate.owner);
  const reach = triggers.length > 0 ? elementReach(candidate.element, candidate.owner) : null;
  if (!reach) {
    return null;
  }
  const freeTriggers = triggers.filter((trigger) => !triggerReads(trigger, reach));
  const inputs: ElementInputs = {
    readsProps: readsOwnerProps(reach, candidate.owner),
    readTriggers: triggers.filter((trigger) => triggerReads(trigger, reach)),
  };
  return freeTriggers.length > 0 ? bustOf(candidate, freeTriggers, inputs) : null;
}

/** Everything the element and the conditions that render it read, or null when it is open. */
function elementReach(
  element: ts.JsxOpeningLikeElement,
  owner: RuntimeFunctionLike,
): RenderReach | null {
  const rendered = ts.isJsxOpeningElement(element) ? element.parent : element;
  const gates = renderGates(rendered, owner);
  const reach = gates && renderReach([rendered, ...gates], owner);
  return reach?.blocker === null ? reach : null;
}

function bustOf(
  candidate: BustCandidate,
  freeTriggers: readonly RenderTrigger[],
  inputs: ElementInputs,
): MemoBust {
  return {
    component: candidate.component,
    element: candidate.element,
    freeTriggers,
    fresh: candidate.fresh,
    isolated: freeTriggers.some((trigger) => triggerChangesAlone(trigger, inputs, candidate.owner)),
    owner: candidate.owner,
    unproven: candidate.props.flatMap((prop) =>
      prop.identity.kind === "unproven" ? [{ name: prop.name, reason: prop.identity.reason }] : [],
    ),
  };
}

function freshProp(prop: ElementProp, context: IdentityContext): FreshProp[] {
  const { identity } = prop;
  if (identity.kind !== "fresh") {
    return [];
  }
  return [
    {
      ...prop,
      blockers: fixBlockers(identity.origin, context, new Set()),
      hoistable: !isMemoAllocation(identity.allocation) && readsOnlyModuleScope(identity.origin),
      identity,
    },
  ];
}

/** Every binding the allocation reads is imported, global, module-level, or its own. */
function readsOnlyModuleScope(origin: ts.Node): boolean {
  let moduleOnly = true;
  visit(origin, (node) => {
    if (!moduleOnly || !ts.isIdentifier(node) || isNonValueIdentifier(node)) {
      return;
    }
    const declaration = bindingDeclaration(lexicalBinding(node));
    moduleOnly =
      declaration === null ||
      nodeWithin(declaration, origin) ||
      findAncestor(declaration, isRuntimeFunctionLike) === null;
  });
  return moduleOnly;
}

/** Owner bindings a memoized form of `origin` depends on whose identity stays unproven. */
function fixBlockers(
  origin: ts.Node,
  context: IdentityContext,
  visited: Set<ts.Node>,
): UnprovenInput[] {
  if (visited.has(origin)) {
    return [];
  }
  visited.add(origin);
  const blockers = freeOwnerIdentifiers(origin, context.owner).flatMap((identifier) =>
    identifierBlockers(identifier, context, visited),
  );
  return [...new Map(blockers.map((blocker) => [blocker.name, blocker])).values()];
}

function identifierBlockers(
  identifier: ts.Identifier,
  context: IdentityContext,
  visited: Set<ts.Node>,
): UnprovenInput[] {
  const identity = expressionIdentity(identifier, context);
  if (identity.kind === "unproven") {
    return [{ name: identifier.text, reason: identity.reason }];
  }
  return identity.kind === "fresh" ? fixBlockers(identity.origin, context, visited) : [];
}
