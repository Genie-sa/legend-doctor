import { collectHookImports, isHostTag } from "../../core/imports.js";
import { identifiersNamed, nearestNestedFunction, visit } from "../../core/ast.js";
import {
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateClassificationInputs } from "./classification-context.js";
import { callbackBindingName } from "./site-write-roots.js";
import { isTransitionReference } from "../../rules/react-commit-sensitivity/direct-transitions.js";
import { jsxTargetName } from "../ast-helpers.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

export type CalleeTransitionScope = Pick<
  StateClassificationInputs,
  "childContracts" | "hostTags" | "state" | "usage"
>;

/**
 * A write inside a callback that a same-module or source-resolved imported helper, or a
 * source-resolved child component, invokes runs in that callee's transition when the callee starts
 * one, and an observable `.set()` there would commit urgently instead. Transitions the owner starts
 * are already commit-sensitive.
 */
export function writesRunInCalleeTransition(context: CalleeTransitionScope): boolean {
  return context.usage.setterCallNodes.some((call) =>
    enclosingCallbackRunsInCalleeTransition(call, context, new Set()),
  );
}

function enclosingCallbackRunsInCalleeTransition(
  node: ts.Node,
  context: CalleeTransitionScope,
  seen: ReadonlySet<string>,
): boolean {
  const { owner } = context.state;
  for (
    let callback = nearestNestedFunction(node, owner);
    callback !== null;
    callback = nearestNestedFunction(callback, owner)
  ) {
    if (callbackRunsInCalleeTransition(callback, context, seen)) {
      return true;
    }
  }
  return false;
}

function callbackRunsInCalleeTransition(
  callback: RuntimeFunctionLike,
  context: CalleeTransitionScope,
  seen: ReadonlySet<string>,
): boolean {
  if (handoffStartsTransition(callback, context)) {
    return true;
  }
  const name = callbackBindingName(callback);
  return name !== null && bindingRunsInCalleeTransition(name, context, seen);
}

function bindingRunsInCalleeTransition(
  name: string,
  context: CalleeTransitionScope,
  seen: ReadonlySet<string>,
): boolean {
  const { body } = context.state.owner;
  if (seen.has(name) || !body) {
    return false;
  }
  const nextSeen = new Set([...seen, name]);
  return identifiersNamed(body, name).some(
    (reference) =>
      !isDeclarationName(reference) &&
      !isNonValueIdentifier(reference) &&
      (handoffStartsTransition(reference, context) ||
        (isCalleeReference(reference) &&
          enclosingCallbackRunsInCalleeTransition(reference, context, nextSeen))),
  );
}

function isCalleeReference(reference: ts.Identifier): boolean {
  return ts.isCallExpression(reference.parent) && reference.parent.expression === reference;
}

/** The value is an argument of a resolved call, or the direct value of a component attribute. */
function handoffStartsTransition(value: ts.Node, context: CalleeTransitionScope): boolean {
  let position = value;
  while (ts.isParenthesizedExpression(position.parent)) {
    position = position.parent;
  }
  const { parent } = position;
  if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === position)) {
    return calleeStartsTransition(parent.expression, context);
  }
  return (
    ts.isJsxExpression(parent) &&
    ts.isJsxAttribute(parent.parent) &&
    isDirectJsxAttributeExpression(parent.parent, value) &&
    componentAttributeStartsTransition(parent.parent, context)
  );
}

function componentAttributeStartsTransition(
  attribute: ts.JsxAttribute,
  context: CalleeTransitionScope,
): boolean {
  const tag = jsxTargetName(attribute);
  const source =
    tag === null || isHostTag(tag, context.hostTags)
      ? null
      : (context.childContracts?.resolveComponent(tag) ?? null);
  return source !== null && bodyStartsTransition(source.body);
}

function calleeStartsTransition(
  callee: ts.LeftHandSideExpression,
  context: CalleeTransitionScope,
): boolean {
  const target = unwrapTransparentExpression(callee);
  const body = ts.isIdentifier(target) ? calleeDeclaration(target, context)?.body : undefined;
  return body !== undefined && bodyStartsTransition(body);
}

/** Only the callee's own body is read; a name the source index cannot resolve proves nothing. */
function calleeDeclaration(
  callee: ts.Identifier,
  { childContracts }: CalleeTransitionScope,
): RuntimeFunctionLike | null {
  const binding = lexicalBinding(callee);
  if (binding?.kind === "function") {
    return binding.declaration;
  }
  if (binding?.kind !== "import") {
    return null;
  }
  const imported = childContracts
    ?.reachResolver?.()
    .importedCallee(callee.getSourceFile(), binding);
  return imported?.kind === "function" ? imported.declaration : null;
}

function bodyStartsTransition(body: ts.Node): boolean {
  const imports = collectHookImports(body.getSourceFile());
  let starts = false;
  visit(body, (node) => {
    starts ||= isTransitionReference(node, imports);
  });
  return starts;
}
