import { findAncestorUntil, nearestNestedFunction } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingDeclarationCount } from "../../core/analysis-ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isJsxEventHandlerReference } from "../state-proofs/event-roots.js";
import { isReactEffectCall } from "../react-commit-sensitivity/effect-lifecycle.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

const DEFERRING_GLOBAL =
  /^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)$/u;
const EVENT_HANDLER_PROP = /^on[A-Z]/u;
const HOOK_NAME = /^use[A-Z]/u;

interface RenderExclusion {
  readonly imports: HookImports;
  readonly owner: RuntimeFunctionLike;
  readonly seen: ReadonlySet<ts.Identifier>;
}

/**
 * No render of `owner` executes `node`: an enclosing callback runs only at commit, from an event
 * handler, or from a deferred scheduler, and every owner-level alias of it keeps that property.
 */
export function runsOutsideRender(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  return enclosedOutsideRender(node, { imports, owner, seen: new Set() });
}

function isCommitCallback(callback: RuntimeFunctionLike, imports: HookImports): boolean {
  const call = callback.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== callback) {
    return false;
  }
  if (isReactEffectCall(call, imports)) {
    return true;
  }
  return (
    ts.isIdentifier(call.expression) &&
    (imports.useObserveEffect.has(call.expression.text) ||
      imports.useMount.has(call.expression.text) ||
      imports.useUnmount.has(call.expression.text))
  );
}

export function isInlineJsxEventHandler(callback: RuntimeFunctionLike): boolean {
  let expression: ts.Node = callback;
  while (ts.isParenthesizedExpression(expression.parent)) {
    expression = expression.parent;
  }
  const container = expression.parent;
  return (
    ts.isJsxExpression(container) &&
    ts.isJsxAttribute(container.parent) &&
    EVENT_HANDLER_PROP.test(container.parent.name.getText())
  );
}

function enclosedOutsideRender(node: ts.Node, exclusion: RenderExclusion): boolean {
  for (
    let callback = nearestNestedFunction(node, exclusion.owner);
    callback;
    callback = nearestNestedFunction(callback, exclusion.owner)
  ) {
    if (neverInvokedByRender(callback, exclusion)) {
      return true;
    }
  }
  return false;
}

function neverInvokedByRender(callback: RuntimeFunctionLike, exclusion: RenderExclusion): boolean {
  if (
    isCommitCallback(callback, exclusion.imports) ||
    isInlineJsxEventHandler(callback) ||
    isDeferredCallback(callback, callback.parent, exclusion.owner)
  ) {
    return true;
  }
  const binding = ownerLevelCallbackBinding(callback, exclusion);
  if (
    !binding ||
    exclusion.seen.has(binding) ||
    bindingDeclarationCount(exclusion.owner, binding.text) !== 1
  ) {
    return false;
  }
  const nested = { ...exclusion, seen: new Set(exclusion.seen).add(binding) };
  return ownerLevelReferences(exclusion.owner, binding).every((reference) =>
    referenceStaysOutsideRender(reference, nested),
  );
}

/** An alias only names the callback: hook dependencies, event props, schedulers, or non-render code. */
function referenceStaysOutsideRender(
  reference: ts.Identifier,
  exclusion: RenderExclusion,
): boolean {
  if (
    isHookDependency(reference) ||
    isDeferredCallback(reference, reference.parent, exclusion.owner)
  ) {
    return true;
  }
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, exclusion.owner);
  if (
    attribute &&
    EVENT_HANDLER_PROP.test(attribute.name.getText()) &&
    isJsxEventHandlerReference(attribute, reference)
  ) {
    return true;
  }
  return enclosedOutsideRender(reference, exclusion);
}

/** The owner-level `const` or function declaration name, bare or wrapped in `useCallback`. */
function ownerLevelCallbackBinding(
  callback: RuntimeFunctionLike,
  { imports, owner }: RenderExclusion,
): ts.Identifier | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.parent === owner.body && callback.name ? callback.name : null;
  }
  const wrapper =
    ts.isCallExpression(callback.parent) &&
    callback.parent.arguments[0] === callback &&
    isImportedHookCall({
      call: callback.parent,
      canonicalName: "useCallback",
      localNames: imports.useCallback,
      namespaceNames: imports.reactNamespaces,
    })
      ? callback.parent
      : callback;
  const declaration = wrapper.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === wrapper &&
    ts.isIdentifier(declaration.name) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.parent.parent.parent === owner.body
    ? declaration.name
    : null;
}

function isHookDependency(reference: ts.Identifier): boolean {
  const dependencies = reference.parent;
  const call = dependencies.parent;
  if (!ts.isArrayLiteralExpression(dependencies) || !call || !ts.isCallExpression(call)) {
    return false;
  }
  const callee = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression;
  return (
    call.arguments[1] === dependencies && ts.isIdentifier(callee) && HOOK_NAME.test(callee.text)
  );
}

/** `node` is the callback argument of a global scheduler, which never invokes it synchronously. */
function isDeferredCallback(node: ts.Node, call: ts.Node, owner: RuntimeFunctionLike): boolean {
  return (
    ts.isCallExpression(call) &&
    call.arguments[0] === node &&
    ts.isIdentifier(call.expression) &&
    DEFERRING_GLOBAL.test(call.expression.text) &&
    bindingDeclarationCount(owner, call.expression.text) === 0 &&
    !declaresModuleBinding(call.getSourceFile(), call.expression.text)
  );
}

function declaresModuleBinding(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      return (
        clause?.name?.text === name ||
        (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === name) ||
        (bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some((element) => element.name.text === name))
      );
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
      );
    }
    return (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    );
  });
}
