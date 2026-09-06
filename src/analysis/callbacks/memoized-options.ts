import { HOOK_CALL_ARITY, MEMO_HOOK_NAMES } from "../constants.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  identifiersNamed,
  nodeWithin,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import { isCustomJsxTarget, jsxTargetName, soleReturnedExpression } from "../ast-helpers.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isHookDependencyReference } from "../../rules/state-proofs/callback-sites.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isJsxEventHandlerReference } from "../../rules/state-proofs/event-roots.js";
import { localCallbackByBinding } from "./local-callbacks.js";
import { staticPropertyName } from "../commands/memoized-option-command.js";
import ts from "typescript";

export function sourceProvenOptionEventCallbacks(
  owner: RuntimeFunctionLike,
  imports: HookImports,
  childContracts: ChildContractResolver,
): ReadonlySet<RuntimeFunctionLike> {
  const callbacks = new Set<RuntimeFunctionLike>();
  if (!owner.body) {
    return callbacks;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    collectMemoizedOptionCallbacks(node, callbacks, { childContracts, imports, owner });
  });
  return callbacks;
}

interface MemoizedOptionScope {
  readonly childContracts: ChildContractResolver;
  readonly imports: HookImports;
  readonly owner: RuntimeFunctionLike;
}

interface MemoizedOptionPublication extends MemoizedOptionScope {
  readonly memo: MemoizedObjectLiteral;
  readonly publications: readonly ComponentPublication[];
}

function uniqueMemoizedOptionsBinding(
  node: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): MemoizedObjectLiteral | null {
  if (!node.initializer || bindingDeclarationCount(owner, node.name.getText()) !== 1) {
    return null;
  }
  const memo = memoizedObjectLiteral(node.initializer, imports);
  return memo && !memo.object.properties.some(ts.isSpreadAssignment) ? memo : null;
}

function collectMemoizedOptionCallbacks(
  node: ts.Node,
  callbacks: Set<RuntimeFunctionLike>,
  scope: MemoizedOptionScope,
): void {
  const published = publishedMemoizedOptions(node, scope);
  if (!published) {
    return;
  }
  for (const property of published.memo.object.properties) {
    const callback = deferredOptionCallback(property, { ...scope, ...published });
    if (callback) {
      callbacks.add(callback);
    }
  }
}

interface PublishedMemoizedOptions {
  readonly memo: MemoizedObjectLiteral;
  readonly publications: readonly ComponentPublication[];
}

function publishedMemoizedOptions(
  node: ts.Node,
  { imports, owner }: MemoizedOptionScope,
): PublishedMemoizedOptions | null {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
    return null;
  }
  const memo = uniqueMemoizedOptionsBinding(node, owner, imports);
  const publications = memo ? jsxComponentPublications(owner, node.name.text) : [];
  return memo && publications.length > 0 ? { memo, publications } : null;
}

function deferredOptionCallback(
  property: ts.ObjectLiteralElementLike,
  { childContracts, imports, memo, owner, publications }: MemoizedOptionPublication,
): RuntimeFunctionLike | null {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
    return null;
  }
  const propertyName = staticPropertyName(property.name);
  const callbackName = ts.isShorthandPropertyAssignment(property)
    ? property.name
    : unwrapTransparentExpression(property.initializer);
  if (!propertyName || !ts.isIdentifier(callbackName)) {
    return null;
  }
  const callback = localCallbackByBinding(owner, callbackName.text, imports);
  if (
    !callback ||
    !memo.dependencies.elements.some(
      (element) => ts.isIdentifier(element) && element.text === callbackName.text,
    ) ||
    !callbackPublishedOnlyThroughMemo(owner, callbackName.text, {
      memoCall: memo.call,
      property,
    }) ||
    !publications.every((publication) =>
      childContracts.componentPropCallbackIsDeferred(
        publication.component,
        publication.prop,
        propertyName,
      ),
    )
  ) {
    return null;
  }
  return callback;
}

interface MemoizedObjectLiteral {
  call: ts.CallExpression;
  dependencies: ts.ArrayLiteralExpression;
  object: ts.ObjectLiteralExpression;
}

interface MemoHookCall {
  readonly call: ts.CallExpression;
  readonly dependencies: ts.ArrayLiteralExpression;
  readonly factory: ts.ArrowFunction | ts.FunctionExpression;
}

function memoHookCall(initializer: ts.Expression, imports: HookImports): MemoHookCall | null {
  const call = unwrapTransparentExpression(initializer);
  if (
    !ts.isCallExpression(call) ||
    !isImportedHookCall({
      call,
      localNames: imports.useMemo,
      namespaceNames: imports.reactNamespaces,
      canonicalName: "useMemo",
    }) ||
    call.arguments.length !== HOOK_CALL_ARITY
  ) {
    return null;
  }
  const [factory, dependencies] = call.arguments;
  if (
    !factory ||
    (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) ||
    !dependencies ||
    !ts.isArrayLiteralExpression(dependencies)
  ) {
    return null;
  }
  return { call, dependencies, factory };
}

function memoizedObjectLiteral(
  initializer: ts.Expression,
  imports: HookImports,
): MemoizedObjectLiteral | null {
  const memo = memoHookCall(initializer, imports);
  const returned = memo ? soleReturnedExpression(memo.factory.body) : null;
  if (!memo || !returned) {
    return null;
  }
  const expression = unwrapTransparentExpression(returned);
  return ts.isObjectLiteralExpression(expression)
    ? { call: memo.call, dependencies: memo.dependencies, object: expression }
    : null;
}

export interface ComponentPublication {
  component: string;
  intrinsic: boolean;
  prop: string;
}

export function jsxComponentPublications(
  owner: RuntimeFunctionLike,
  binding: string,
): readonly ComponentPublication[] {
  const publications: ComponentPublication[] = [];
  for (const node of identifiersNamed(owner.body, binding)) {
    if (isDeclarationName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    const publication = eventHandlerPublication(node, owner);
    if (!publication) {
      return [];
    }
    publications.push(publication);
  }
  return publications;
}

function eventHandlerPublication(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
): ComponentPublication | null {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
  const component = attribute ? jsxTargetName(attribute) : null;
  if (!attribute || !component || !isJsxEventHandlerReference(attribute, node)) {
    return null;
  }
  return {
    component,
    intrinsic: !isCustomJsxTarget(component),
    prop: attribute.name.getText(),
  };
}

interface MemoPublication {
  readonly memoCall: ts.CallExpression;
  readonly property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
}

function callbackPublishedOnlyThroughMemo(
  owner: RuntimeFunctionLike,
  binding: string,
  { memoCall, property }: MemoPublication,
): boolean {
  let propertyReferences = 0;
  for (const node of identifiersNamed(owner.body, binding)) {
    if (isDeclarationName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    if (nodeWithin(node, property)) {
      propertyReferences += 1;
      continue;
    }
    if (!isOwnMemoDependencyReference(node, owner, memoCall)) {
      return false;
    }
  }
  return propertyReferences === 1;
}

function isOwnMemoDependencyReference(
  node: ts.Identifier,
  owner: RuntimeFunctionLike,
  memoCall: ts.CallExpression,
): boolean {
  if (!isHookDependencyReference(node, MEMO_HOOK_NAMES)) {
    return false;
  }
  return findAncestorUntil(node, ts.isCallExpression, owner) === memoCall;
}
