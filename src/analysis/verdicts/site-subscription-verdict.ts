import type { ClassifiedState, StateCandidate, StateUsage } from "../model.js";
import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isDirectJsxAttributeExpression,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { hasHiddenCompanionWrites, writesAreEventRooted } from "./site-write-roots.js";
import {
  hasOnlyEventCommandReads,
  stateMayHoldCallable,
} from "../../rules/state-proofs/state-proofs.js";
import { jsxElementCount, jsxElementCountIn } from "../../rules/state-proofs/jsx-subtrees.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { HostTagImports } from "../../core/imports.js";
import { MAX_LEAF_SUBTREE_RATIO } from "../constants.js";
import type { MaterialityPolicy } from "../constants.js";
import type { StateClassificationContext } from "./classification-context.js";
import { isCustomHookOwner } from "../ast-helpers.js";
import { isHostTag } from "../../core/imports.js";
import { isImportedTranslationCall } from "../../rules/effects/command-support-calls.js";
import { isSafeProjectionExpression } from "../../rules/deferred-reveal/safe-projections.js";
import { oneHopRenderProjectionReferences } from "../../rules/state-proofs/projection-hops.js";
import { stateWritesAreUntracked } from "./transport-verdicts.js";
import ts from "typescript";

type SiteKind = "computed" | "leaf-wrapper" | "reactive-prop";

/** How many pure `const` projections a read may pass through before it must reach a JSX site. */
const MAX_PROJECTION_HOPS = 3;

interface SubscriptionSite {
  readonly kind: SiteKind;
  readonly label: string;
  readonly node: ts.Node;
}

interface SiteScope {
  readonly allowUnresolvedComponentCallSite?: boolean;
  readonly childContracts: ChildContractResolver | null;
  readonly hostTags: HostTagImports;
  readonly pureProjectionImports: ReadonlySet<string>;
  readonly state: StateCandidate;
}

export interface SubscriptionSites {
  readonly derivedBindings: readonly string[];
  readonly sites: readonly SubscriptionSite[];
}

/**
 * A broad owner that reads one state at several independent JSX sites can subscribe at each site
 * instead of rendering itself: child expressions become `Computed`, host attributes become reactive
 * props, and transports into proven leaf consumers become leaf wrappers. Every read must sit in such
 * a position; reads that feed derived values, guards, hook arguments, or callbacks abstain.
 */
export function siteSubscriptionVerdict(
  context: StateClassificationContext,
): ClassifiedState | null {
  const { childContracts, state, usage } = context;
  if (!siteSubscriptionPreconditionsHold(context)) {
    return null;
  }
  const resolved = subscriptionSites(usage, {
    childContracts,
    hostTags: context.hostTags,
    pureProjectionImports: context.pureProjectionImports,
    state,
  });
  if (!resolved || !subscriptionSitesAreMaterial(resolved.sites, state)) {
    return null;
  }
  return {
    action: "use-observable",
    confidence: "probable",
    message: siteSubscriptionMessage(state, resolved, usage),
  };
}

function writesOutsideEffects(
  usage: StateUsage,
  effectRegions: StateClassificationContext["effectRegions"],
): ts.CallExpression[] {
  return usage.setterCallNodes.filter(
    (call) => ![...effectRegions].some((region) => nodeWithin(call, region)),
  );
}

function siteSubscriptionPreconditionsHold(context: StateClassificationContext): boolean {
  const { childContracts, eventTransitionCallbacks, hasDetachedEffectWrites, state, usage } =
    context;
  const eventWrites = hasDetachedEffectWrites
    ? { ...usage, setterCallNodes: writesOutsideEffects(usage, context.effectRegions) }
    : usage;
  return (
    context.hasSafeCommands &&
    !context.hasReactiveMutationPath &&
    stateQualifiesForSiteSubscriptions(state, usage, context) &&
    (usage.deferredReads === 0 ||
      hasOnlyEventCommandReads(
        state,
        new Set(usage.directRenderNodes),
        eventTransitionCallbacks,
      )) &&
    writesAreEventRooted(eventWrites, {
      childContracts,
      eventTransitionCallbacks,
      hostTags: context.hostTags,
      state,
    }) &&
    !hasHiddenCompanionWrites(state, usage)
  );
}

interface SiteSubscriptionGates {
  readonly hasCompanionWrites: boolean;
  readonly hasDetachedEffectWrites: boolean;
  readonly materiality: MaterialityPolicy;
}

export function stateQualifiesForSiteSubscriptions(
  state: StateCandidate,
  usage: StateUsage,
  { hasCompanionWrites, hasDetachedEffectWrites, materiality }: SiteSubscriptionGates,
): boolean {
  return (
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= materiality.broadOwnerJsx &&
    usage.localRenderReads > 0 &&
    usage.effectReads === 0 &&
    (usage.effectWrites === 0 || hasDetachedEffectWrites) &&
    usage.setterCalls >= 1 &&
    usage.setterReferences === usage.setterCalls &&
    !usage.repeatedTransport &&
    !usage.unstableTransport &&
    !hasCompanionWrites &&
    stateWritesAreUntracked(usage) &&
    !stateMayHoldCallable(state)
  );
}

export function subscriptionSites(usage: StateUsage, scope: SiteScope): SubscriptionSites | null {
  const derivedBindings = new Set<string>();
  const trail: ProjectionTrail = { derivedBindings, scope };
  const reads = usage.directRenderNodes.flatMap((read) =>
    ts.isIdentifier(read) ? projectedReads(read, trail, MAX_PROJECTION_HOPS) : [null],
  );
  if (reads.some((read) => read === null)) {
    return null;
  }
  const sites = [
    ...reads.map((read) => (read ? renderReadSite(read, scope) : null)),
    ...transportAttributes(scope.state).map((attribute) => transportSite(attribute, scope)),
  ];
  return sites.some((site) => site === null)
    ? null
    : { derivedBindings: [...derivedBindings].toSorted(), sites: uniqueSites(sites) };
}

interface ProjectionTrail {
  readonly derivedBindings: Set<string>;
  readonly scope: SiteScope;
}

/**
 * A read inside a uniquely bound pure `const` initializer stands for every render reference of
 * that binding: the binding can be recomputed inside the subscribing sites. Impure initializers,
 * unused bindings, and trails longer than the hop budget abstain.
 */
function projectedReads(
  read: ts.Identifier,
  trail: ProjectionTrail,
  hops: number,
): readonly (ts.Identifier | null)[] {
  const { owner } = trail.scope.state;
  const declaration = findAncestorUntil(read, ts.isVariableDeclaration, owner);
  if (!declaration) {
    return [read];
  }
  const references = hops > 0 ? projectionHop(read, declaration, trail) : null;
  return references
    ? references.flatMap((reference) => projectedReads(reference, trail, hops - 1))
    : [null];
}

function projectionHop(
  read: ts.Identifier,
  declaration: ts.VariableDeclaration,
  trail: ProjectionTrail,
): readonly ts.Identifier[] | null {
  if (!declaration.initializer || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  const pureCalls = pureCalleesIn(declaration.initializer, trail.scope);
  const references = oneHopRenderProjectionReferences(trail.scope.state.owner, [read], (query) =>
    isSafeProjectionExpression({ ...query, allowedIdentifierCalls: pureCalls }),
  );
  if (references) {
    trail.derivedBindings.add(declaration.name.text);
  }
  return references;
}

function pureCalleesIn(expression: ts.Expression, scope: SiteScope): ReadonlySet<string> {
  const callees = new Set<string>();
  visit(expression, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isPureSiteCall(node, scope)
    ) {
      callees.add(node.expression.text);
    }
  });
  return callees;
}

function uniqueSites(sites: readonly (SubscriptionSite | null)[]): readonly SubscriptionSite[] {
  const unique = new Map<ts.Node, SubscriptionSite>();
  for (const site of sites) {
    if (site) {
      unique.set(site.node, site);
    }
  }
  return [...unique.values()].toSorted(
    (left, right) => left.node.getStart() - right.node.getStart(),
  );
}

function renderReadSite(read: ts.Identifier, scope: SiteScope): SubscriptionSite | null {
  const { state } = scope;
  if (nearestNestedFunction(read, state.owner) !== null) {
    return null;
  }
  const attribute = findAncestorUntil(read, ts.isJsxAttribute, state.owner);
  if (attribute) {
    return attributeSite(attribute, scope);
  }
  const expression = childExpressionContaining(read, state.owner);
  return expression && rendersWithoutSideEffects(expression, scope)
    ? { kind: "computed", label: "child expression", node: expression }
    : null;
}

function attributeSite(attribute: ts.JsxAttribute, scope: SiteScope): SubscriptionSite | null {
  const tag = attributeTagName(attribute);
  if (tag === null || !rendersWithoutSideEffects(attribute, scope)) {
    return null;
  }
  const propName = attribute.name.getText();
  if (isHostTag(tag, scope.hostTags)) {
    return { kind: "reactive-prop", label: `${propName} on <${tag}>`, node: attribute };
  }
  return scope.allowUnresolvedComponentCallSite ||
    scope.childContracts?.componentPropIsLeafRenderConsumer(tag, propName) === true
    ? {
        kind: "leaf-wrapper",
        label: `<${tag}> call site, computing ${propName}`,
        node: attribute.parent.parent,
      }
    : null;
}

/**
 * A wrapped site re-evaluates from the observable instead of the owner render, so it may not run
 * calls, constructors, awaits, or writes of its own. Imported pure projections and the translation
 * function of an imported `useTranslation()` are reads, not effects. Handlers nested inside rendered
 * JSX are skipped: they run on events, not during evaluation.
 */
function rendersWithoutSideEffects(site: ts.Node, scope: SiteScope): boolean {
  let pure = true;
  visitSkippingNestedRuntimeFunctions(site, (node) => {
    if (ts.isCallExpression(node)) {
      pure &&= isPureSiteCall(node, scope);
      return;
    }
    if (
      ts.isNewExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind))
    ) {
      pure = false;
    }
  });
  return pure;
}

function isPureSiteCall(call: ts.CallExpression, scope: SiteScope): boolean {
  const { owner } = scope.state;
  if (isImportedTranslationCall(call, owner)) {
    return true;
  }
  const callee = call.expression;
  return (
    ts.isIdentifier(callee) &&
    scope.pureProjectionImports.has(callee.text) &&
    bindingDeclarationCount(owner, callee.text) === 0
  );
}

function childExpressionContaining(
  read: ts.Identifier,
  owner: StateCandidate["owner"],
): ts.JsxExpression | null {
  let candidate: ts.JsxExpression | null = null;
  for (let current: ts.Node = read; current !== owner && current.parent; current = current.parent) {
    if (
      ts.isJsxExpression(current) &&
      (ts.isJsxElement(current.parent) || ts.isJsxFragment(current.parent))
    ) {
      candidate = current;
    }
    if (
      ts.isJsxAttribute(current) ||
      ts.isReturnStatement(current) ||
      ts.isVariableDeclaration(current)
    ) {
      break;
    }
  }
  return candidate;
}

function transportAttributes(state: StateCandidate): readonly ts.JsxAttribute[] {
  const attributes: ts.JsxAttribute[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === state.valueName &&
      isDirectJsxAttributeExpression(node, node.initializer.expression)
    ) {
      const tag = attributeTagName(node);
      if (tag !== null && !/^[a-z]/u.test(tag)) {
        attributes.push(node);
      }
    }
  });
  return attributes;
}

function transportSite(attribute: ts.JsxAttribute, scope: SiteScope): SubscriptionSite | null {
  const tag = attributeTagName(attribute);
  if (
    tag === null ||
    nearestNestedFunction(attribute, scope.state.owner) !== null ||
    isHostTag(tag, scope.hostTags)
  ) {
    return null;
  }
  const propName = attribute.name.getText();
  return scope.allowUnresolvedComponentCallSite ||
    scope.childContracts?.componentPropIsLeafRenderConsumer(tag, propName) === true
    ? { kind: "leaf-wrapper", label: `<${tag}> call site`, node: attribute.parent.parent }
    : null;
}

function attributeTagName(attribute: ts.JsxAttribute): string | null {
  const opening = attribute.parent.parent;
  return ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)
    ? opening.tagName.getText()
    : null;
}

export function subscriptionSitesAreMaterial(
  sites: readonly SubscriptionSite[],
  state: StateCandidate,
): boolean {
  const wrapped = sites.reduce((total, site) => total + jsxElementCountIn(site.node), 0);
  return wrapped / jsxElementCount(state.owner) <= MAX_LEAF_SUBTREE_RATIO;
}

const SITE_INSTRUCTIONS = {
  computed: "wrap the child expression in `Computed`",
  "leaf-wrapper": "wrap the call site in a stable leaf subscriber that passes the same plain value",
  "reactive-prop": "make the attribute a reactive prop",
} as const satisfies Record<SiteKind, string>;

function siteSubscriptionMessage(
  state: StateCandidate,
  { derivedBindings, sites }: SubscriptionSites,
  usage: StateUsage,
): string {
  const sourceFile = state.owner.getSourceFile();
  const steps = sites.map((site) => {
    const line = sourceFile.getLineAndCharacterOfPosition(site.node.getStart(sourceFile)).line + 1;
    return `${SITE_INSTRUCTIONS[site.kind]} (${site.label}, line ${line})`;
  });
  const derived =
    derivedBindings.length > 0
      ? ` Recompute ${derivedBindings.map((name) => `\`${name}\``).join(", ")} inside the subscribing sites instead of the owner render.`
      : "";
  const commands =
    usage.deferredReads > 0 ? " Snapshot command reads with `.peek()` at command entry." : "";
  return `Replace \`${state.valueName}\` with a component-lifetime observable and subscribe at its ${sites.length} render ${sites.length === 1 ? "site" : "sites"} instead of this owner: ${steps.join("; ")}.${derived} Keep the setter calls in place as observable writes.${commands} The owner no longer renders when \`${state.valueName}\` changes.`;
}
