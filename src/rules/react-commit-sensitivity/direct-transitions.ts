import {
  bindingIsUnshadowed,
  constInitializer,
  isImportedReactCall,
  isSoleReference,
} from "./binding-resolution.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { callbackIsEventRooted } from "../state-proofs/event-roots.js";
import { localFunctionBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";

interface DirectTransitionContext {
  callbacks: readonly RuntimeFunctionLike[];
  eventCallbacks: ReadonlySet<RuntimeFunctionLike>;
}

interface TransitionWalk {
  readonly owner: RuntimeFunctionLike;
  readonly body: ts.Node;
  readonly imports: HookImports;
  readonly bindings: ReadonlySet<string>;
  readonly callbacks: RuntimeFunctionLike[];
  readonly eventCallbacks: Set<RuntimeFunctionLike>;
  safe: boolean;
}

export function directTransitionContext(
  owner: RuntimeFunctionLike,
  imports: HookImports,
): DirectTransitionContext | null {
  if (!owner.body) {
    return null;
  }
  const walk: TransitionWalk = {
    bindings: transitionStartBindings(owner.body, imports),
    body: owner.body,
    callbacks: [],
    eventCallbacks: new Set(),
    imports,
    owner,
    safe: true,
  };
  collectDirectTransitions(walk);
  if (!walk.safe || transitionsEscapeCallPosition(walk)) {
    return null;
  }
  return { callbacks: walk.callbacks, eventCallbacks: walk.eventCallbacks };
}

function transitionStartBindings(body: ts.Node, imports: HookImports): ReadonlySet<string> {
  const bindings = new Set<string>();
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isImportedReactCall(node.initializer, imports, "useTransition")
    ) {
      const [, start] = node.name.elements;
      if (start && !ts.isOmittedExpression(start) && ts.isIdentifier(start.name)) {
        bindings.add(start.name.text);
      }
    }
  });
  return bindings;
}

function collectDirectTransitions(walk: TransitionWalk): void {
  visit(walk.body, (node) => {
    if (walk.safe && ts.isCallExpression(node)) {
      collectTransitionCall(node, walk);
    }
  });
}

function isDirectTransitionCall(node: ts.CallExpression, walk: TransitionWalk): boolean {
  return (
    (ts.isIdentifier(node.expression) && walk.bindings.has(node.expression.text)) ||
    isImportedReactCall(node, walk.imports, "startTransition")
  );
}

function collectTransitionCall(node: ts.CallExpression, walk: TransitionWalk): void {
  if (!isDirectTransitionCall(node, walk)) {
    return;
  }
  const callback = node.arguments[0]
    ? directTransitionCallback(node.arguments[0]!, walk.owner)
    : null;
  if (!callback) {
    walk.safe = false;
    return;
  }
  walk.safe = !callbackReadsOwnerFunction(callback, walk.owner);
  walk.callbacks.push(callback);
  if (isEventRootedTransition(node, walk.owner)) {
    walk.eventCallbacks.add(callback);
  }
}

function callbackReadsOwnerFunction(
  callback: RuntimeFunctionLike,
  owner: RuntimeFunctionLike,
): boolean {
  let reads = false;
  visit(callback.body, (reference) => {
    if (
      ts.isIdentifier(reference) &&
      !isDeclarationName(reference) &&
      !isNonValueIdentifier(reference) &&
      localFunctionBinding(owner, reference.text)
    ) {
      reads = true;
    }
  });
  return reads;
}

function isEventRootedTransition(node: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const caller = findAncestor(node, isRuntimeFunctionLike);
  return (
    caller !== null &&
    caller !== owner &&
    (ts.isArrowFunction(caller) ||
      ts.isFunctionDeclaration(caller) ||
      ts.isFunctionExpression(caller)) &&
    callbackIsEventRooted({ callback: caller, owner, dependencyName: "", seen: new Set() })
  );
}

function referenceIsCalledOrListed(node: ts.Node): boolean {
  return (
    (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
    ts.isArrayLiteralExpression(node.parent)
  );
}

function isBareTransitionIdentifier(
  node: ts.Node,
  transitionBindings: ReadonlySet<string>,
): boolean {
  return (
    ts.isIdentifier(node) &&
    transitionBindings.has(node.text) &&
    !isDeclarationName(node) &&
    !isNonValueIdentifier(node) &&
    !referenceIsCalledOrListed(node)
  );
}

function isBareNamespacedStartTransition(node: ts.Node, imports: HookImports): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    imports.reactNamespaces.has(node.expression.text) &&
    node.name.text === "startTransition" &&
    !referenceIsCalledOrListed(node)
  );
}

function transitionsEscapeCallPosition(walk: TransitionWalk): boolean {
  const transitionBindings = new Set([...walk.bindings, ...walk.imports.startTransition]);
  let escapes = false;
  visit(walk.body, (node) => {
    if (
      isBareTransitionIdentifier(node, transitionBindings) ||
      isBareNamespacedStartTransition(node, walk.imports)
    ) {
      escapes = true;
    }
  });
  return escapes;
}

function directTransitionCallback(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): RuntimeFunctionLike | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  if (!ts.isIdentifier(value)) {
    return null;
  }
  const callback = constInitializer(owner, value.text);
  if (callback === null || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return null;
  }
  return isSoleReference(owner, value) ? callback : null;
}

export function isTransitionReference(node: ts.Node, imports: HookImports): boolean {
  if (ts.isCallExpression(node) && isImportedReactCall(node, imports, "useTransition")) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    return imports.startTransition.has(node.text) && bindingIsUnshadowed(node, node.text);
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    imports.reactNamespaces.has(node.expression.text) &&
    node.name.text === "startTransition" &&
    bindingIsUnshadowed(node, node.expression.text)
  );
}
