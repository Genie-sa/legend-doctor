import { broadTransportVerdict, singleTargetTransportVerdict } from "./residual-verdicts.js";
import { hookCallName, isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import {
  identifiersNamed,
  nearestNestedFunction,
  nodeWithin,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { isCustomHookOwner, jsxTargetName } from "../ast-helpers.js";
import {
  rendersWithoutSideEffects,
  subscriptionSitesAreMaterial,
  writesOutsideEffectsAreEventRooted,
} from "./site-subscription-verdict.js";
import {
  stateMayHoldCallable,
  stateReadIsEventCommand,
} from "../../rules/state-proofs/state-proofs.js";
import { stateValuesStayPrimitive, stateWritesAreUntracked } from "./transport-verdicts.js";
import type { ClassifiedState } from "../model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateClassificationContext } from "./classification-context.js";
import { hasUnboundCompanionWrites } from "./site-write-roots.js";
import { isHostTag } from "../../core/imports.js";
import { jsxElementCount } from "../../rules/state-proofs/jsx-subtrees.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { passThroughScope } from "./pass-through-leaf.js";
import ts from "typescript";
import { typeChangeKeepsMountIdentity } from "./mount-identity.js";
import { wrappedElementIsPassedThrough } from "../../rules/child-contract/element-identity.js";

type WrapRoot = ts.JsxElement | ts.JsxExpression | ts.JsxFragment | ts.JsxSelfClosingElement;

/**
 * A primitive state whose every render read, transport, and conditional mount sits inside one JSX
 * child slot of a broad owner can subscribe in that slot alone: a `Computed` block evaluates the
 * same JSX from the observable, so a toggle re-renders the slot instead of the owner. Conditionals
 * inside the slot are re-evaluated by the block, so a gated element mounts and unmounts exactly as
 * before; the block itself takes the slot's position, under a parent that passes it through, and
 * no enclosing branch or other return renders a same-typed element that could have kept the slot's
 * fiber. Writes are event commands, and every other read is an event command that peeks.
 */
export function wrapSiteVerdict(context: StateClassificationContext): ClassifiedState | null {
  if (!wrapSiteOwnershipHolds(context) || transportVerdictApplies(context)) {
    return null;
  }
  const forwardedSetters = deferredSetterTransports(context);
  const root = forwardedSetters && wrapRoot(context);
  return root && forwardedSetters
    ? {
        action: "use-observable",
        confidence: "probable",
        message: wrapSiteMessage(context, root, forwardedSetters),
      }
    : null;
}

function wrapSiteOwnershipHolds(context: StateClassificationContext): boolean {
  const { hasDetachedEffectWrites, state, usage } = context;
  return (
    !isCustomHookOwner(state.owner) &&
    jsxElementCount(state.owner) >= context.materiality.broadOwnerJsx &&
    stateValuesStayPrimitive(context) &&
    !stateMayHoldCallable(state) &&
    context.hasSafeCommands &&
    !context.hasReactiveMutationPath &&
    !context.hasCompanionWrites &&
    usage.effectReads === 0 &&
    (usage.effectWrites === 0 || hasDetachedEffectWrites) &&
    usage.setterCalls >= 1 &&
    !usage.repeatedTransport &&
    stateWritesAreUntracked(usage) &&
    writesOutsideEffectsAreEventRooted(context) &&
    !hasUnboundCompanionWrites(state, usage)
  );
}

/**
 * A state that only reaches one child call site is already cut by the transport verdicts, which
 * move it into a local wrapper or subscribe at that call site without restructuring the slot.
 * They run after this verdict, so it yields to them instead of shadowing a simpler fix.
 */
function transportVerdictApplies(context: StateClassificationContext): boolean {
  return singleTargetTransportVerdict(context) !== null || broadTransportVerdict(context) !== null;
}

/**
 * The bare setter references handed to children, each to a source component whose contract calls
 * that prop only after render. Inside the block each becomes `(next) => value$.set(next)`.
 */
function deferredSetterTransports(
  context: StateClassificationContext,
): readonly ts.JsxAttribute[] | null {
  const { childContracts, state, usage } = context;
  const transports = [...usage.transportNodes.values()]
    .flat()
    .filter(
      (node): node is ts.JsxAttribute =>
        ts.isJsxAttribute(node) && isBareReference(node, state.setterName),
    );
  const deferred = transports.every((attribute) => {
    const tag = jsxTargetName(attribute);
    return (
      tag !== null &&
      !isHostTag(tag, context.hostTags) &&
      childContracts?.componentCallbackPropIsDeferredAtInvocation(
        tag,
        attribute.name.getText(),
        attribute.parent.parent,
      ) === true
    );
  });
  return deferred && usage.setterReferences === usage.setterCalls + transports.length
    ? transports
    : null;
}

function isBareReference(attribute: ts.JsxAttribute, name: string | null): boolean {
  const { initializer } = attribute;
  return (
    initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === name
  );
}

function wrapRoot(context: StateClassificationContext): WrapRoot | null {
  const { state, usage } = context;
  const { owner } = state;
  const root = commonWrapRoot(
    [...usage.directRenderNodes, ...[...usage.transportNodes.values()].flat()],
    owner,
  );
  return root &&
    nearestNestedFunction(root, owner) === null &&
    referencesAreConfined(context, root) &&
    rendersWithoutSideEffects(root, context) &&
    rendersOnlyRefreshedOwnerValues(root, owner) &&
    wrappedElementIsPassedThrough(root, passThroughScope(context)) &&
    typeChangeKeepsMountIdentity(root, owner) &&
    subscriptionSitesAreMaterial([{ kind: "computed", label: "", node: root }], state)
    ? root
    : null;
}

/** A position React reconciles as one child: an element, a fragment, or a child expression. */
function isWrapRoot(node: ts.Node): node is WrapRoot {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node) ||
    (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)))
  );
}

function wrapRootAncestors(node: ts.Node, owner: RuntimeFunctionLike): readonly WrapRoot[] {
  const ancestors: WrapRoot[] = [];
  for (let current: ts.Node = node; current !== owner; current = current.parent) {
    if (isWrapRoot(current)) {
      ancestors.push(current);
    }
  }
  return ancestors;
}

/** The innermost single child slot that contains every node; never a range of siblings. */
function commonWrapRoot(nodes: readonly ts.Node[], owner: RuntimeFunctionLike): WrapRoot | null {
  const [first, ...rest] = nodes.map((node) => wrapRootAncestors(node, owner));
  return (
    first?.find((candidate) => rest.every((ancestors) => ancestors.includes(candidate))) ?? null
  );
}

/** Each read is a render read at the block's own level or an event command; nothing else sees it. */
function referencesAreConfined(context: StateClassificationContext, root: WrapRoot): boolean {
  const { eventTransitionCallbacks, state } = context;
  return identifiersNamed(state.owner.body ?? state.owner, state.valueName).every(
    (reference) =>
      isDeclarationName(reference) ||
      isNonValueIdentifier(reference) ||
      reference.parent === state.call.parent ||
      (nodeWithin(reference, root) && nearestNestedFunction(reference, state.owner) === null) ||
      stateReadIsEventCommand(reference, state, eventTransitionCallbacks),
  );
}

/** A hook's result changes only through a render of its caller; any other call may read a snapshot. */
const HOOK_CALLEE = /^use[A-Z0-9]/u;

/**
 * The block re-renders from the closure of the owner's last render, so each owner value it renders
 * must be one that only an owner render changes: a prop, a hook result, or a `const` derived from
 * them without other calls, constructors, or ref reads. A snapshot such as `ref.current` or
 * `Date.now()` taken in the owner body was refreshed by the toggle's owner render and would go stale.
 */
function rendersOnlyRefreshedOwnerValues(root: WrapRoot, owner: RuntimeFunctionLike): boolean {
  let refreshed = true;
  const seen = new Set<ts.VariableDeclaration>();
  visitSkippingNestedRuntimeFunctions(root, (node) => {
    refreshed &&= !ts.isIdentifier(node) || ownerValueIsRefreshed(node, owner, seen);
  });
  return refreshed;
}

function ownerValueIsRefreshed(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
  seen: Set<ts.VariableDeclaration>,
): boolean {
  const binding = isNonValueIdentifier(reference) ? null : lexicalBinding(reference);
  const declaration = binding?.kind === "value" ? binding.declaration : null;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !nodeWithin(declaration, owner) ||
    seen.has(declaration)
  ) {
    return true;
  }
  seen.add(declaration);
  return (
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer !== undefined &&
    initializerIsRefreshed(declaration.initializer, owner, seen)
  );
}

function initializerIsRefreshed(
  initializer: ts.Expression,
  owner: RuntimeFunctionLike,
  seen: Set<ts.VariableDeclaration>,
): boolean {
  let refreshed = true;
  visitSkippingNestedRuntimeFunctions(initializer, (node) => {
    refreshed &&= ts.isCallExpression(node)
      ? HOOK_CALLEE.test(hookCallName(node) ?? "")
      : !ts.isNewExpression(node) &&
        !(ts.isPropertyAccessExpression(node) && node.name.text === "current") &&
        (!ts.isIdentifier(node) || ownerValueIsRefreshed(node, owner, seen));
  });
  return refreshed;
}

function wrapRootLabel(root: WrapRoot): string {
  if (ts.isJsxExpression(root)) {
    return "child expression";
  }
  if (ts.isJsxFragment(root)) {
    return "fragment";
  }
  const tag = ts.isJsxElement(root) ? root.openingElement.tagName : root.tagName;
  return `<${tag.getText()}> element`;
}

function wrapSiteMessage(
  { sourceFile, state, usage }: StateClassificationContext,
  root: WrapRoot,
  forwardedSetters: readonly ts.JsxAttribute[],
): string {
  const line = sourceFile.getLineAndCharacterOfPosition(root.getStart(sourceFile)).line + 1;
  const forwarding = forwardedSetters
    .map(
      (attribute) =>
        ` Inside the block, pass \`${attribute.name.getText()}={(next) => ${state.valueName}$.set(next)}\`; that child calls it only after render.`,
    )
    .join("");
  const commands =
    usage.deferredReads > 0 ? " Snapshot command reads with `.peek()` at command entry." : "";
  return `Replace \`${state.valueName}\` with a component-lifetime observable and wrap the ${wrapRootLabel(root)} at line ${line} in \`Computed\`, reading the observable inside it; every render read of \`${state.valueName}\`, including the conditionals that mount children, sits in that one slot, so the block re-evaluates it with the same elements, keys, and mount lifetime.${forwarding} Keep the setter calls in place as observable writes.${commands} The owner, with ${jsxElementCount(state.owner)} JSX elements, no longer renders when \`${state.valueName}\` changes.`;
}
