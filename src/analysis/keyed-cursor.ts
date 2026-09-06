import type { StateCandidate, StateUsage } from "./model.js";
import { ancestorCallInSet, isCustomHookOwner, runtimeFunctionName } from "./ast-helpers.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import {
  findAncestor,
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../core/ast.js";
import type { ChildContractResolver } from "../rules/child-contract/model.js";
import { EMPTY_STATE_CANDIDATES } from "./constants.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import { callbackHasCleanup } from "../rules/effects/effects.js";
import { jsxElementCount } from "../rules/state-proofs/jsx-subtrees.js";
import { primitiveSetterUpdatersArePure } from "./mutations.js";
import { stateMayHoldCallable } from "../rules/state-proofs/state-proofs.js";
import ts from "typescript";

interface EffectCursorScope {
  readonly childContracts: ChildContractResolver;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
}

export function isEffectOwnedReturnedKeyedCursor(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, directEffectCalls }: EffectCursorScope,
): boolean {
  const hookName = runtimeFunctionName(state.owner);
  if (
    !hookName ||
    !isCustomHookOwner(state.owner) ||
    jsxElementCount(state.owner) !== 0 ||
    !hasNumericStateInitializer(state) ||
    usage.localRenderReads !== 1 ||
    usage.effectReads < 1 ||
    usage.deferredReads !== 0 ||
    usage.transportedOccurrences !== 0 ||
    usage.setterCalls < 1 ||
    usage.effectWrites !== usage.setterCalls ||
    usage.setterReferences !== usage.setterCalls + 1 ||
    usage.shadowed ||
    stateMayHoldCallable(state) ||
    !primitiveSetterUpdatersArePure(state, usage) ||
    !returnsStateAndSetter(state) ||
    !effectCursorReadsAreDeferred(state, directEffectCalls, childContracts)
  ) {
    return false;
  }
  return (
    state.setterName !== null &&
    childContracts.hookStateHasKeyedRowConsumer(hookName, state.valueName, state.setterName)
  );
}

function hasNumericStateInitializer(state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const value = unwrapTransparentExpression(initializer);
  return (
    ts.isNumericLiteral(value) ||
    (ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand))
  );
}

function returnsStateAndSetter(state: StateCandidate): boolean {
  if (!state.owner.body || !state.setterName) {
    return false;
  }
  let matched = false;
  let returns = 0;
  visitSkippingNestedRuntimeFunctions(state.owner.body, (node) => {
    if (!ts.isReturnStatement(node) || !node.expression) {
      return;
    }
    returns += 1;
    const value = unwrapTransparentExpression(node.expression);
    if (!ts.isObjectLiteralExpression(value)) {
      return;
    }
    const names = new Set(
      value.properties.flatMap((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return [property.name.text];
        }
        if (!ts.isPropertyAssignment(property)) {
          return [];
        }
        const initializer = unwrapTransparentExpression(property.initializer);
        return ts.isIdentifier(property.name) &&
          ts.isIdentifier(initializer) &&
          property.name.text === initializer.text
          ? [initializer.text]
          : [];
      }),
    );
    matched = names.has(state.valueName) && names.has(state.setterName!);
  });
  return returns === 1 && matched;
}

interface CursorReadScope {
  readonly childContracts: ChildContractResolver;
  readonly directEffectCalls: ReadonlySet<ts.CallExpression>;
}

function deferredCursorReadEffect(
  node: ts.Identifier,
  state: StateCandidate,
  { childContracts, directEffectCalls }: CursorReadScope,
): ts.CallExpression | "unsafe" | null {
  const returned = findAncestorUntil(node, ts.isReturnStatement, state.owner);
  if (
    returned?.expression &&
    ts.isObjectLiteralExpression(unwrapTransparentExpression(returned.expression))
  ) {
    return null;
  }
  const effect = ancestorCallInSet(node, directEffectCalls, state.owner);
  if (!effect) {
    return "unsafe";
  }
  const [callback, dependencies] = effect.arguments;
  if (dependencies && nodeWithin(node, dependencies)) {
    return null;
  }
  return readIsRegisteredWithCleanup(node, callback, { childContracts, owner: state.owner })
    ? effect
    : "unsafe";
}

interface RegisteredCleanupScope {
  readonly childContracts: ChildContractResolver;
  readonly owner: RuntimeFunctionLike;
}

function readIsRegisteredWithCleanup(
  node: ts.Identifier,
  callback: ts.Expression | undefined,
  { childContracts, owner }: RegisteredCleanupScope,
): boolean {
  const nested = nearestNestedFunction(node, owner);
  return (
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    nested !== null &&
    nested !== callback &&
    (ts.isArrowFunction(nested) || ts.isFunctionExpression(nested)) &&
    registeredCallbackHasEffectCleanup(nested, callback, childContracts)
  );
}

function effectCursorReadsAreDeferred(
  state: StateCandidate,
  directEffectCalls: ReadonlySet<ts.CallExpression>,
  childContracts: ChildContractResolver,
): boolean {
  if (!state.owner.body) {
    return false;
  }
  const nestedReadEffects = new Set<ts.CallExpression>();
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      node.parent === state.call.parent ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const deferred = deferredCursorReadEffect(node, state, {
      childContracts,
      directEffectCalls,
    });
    if (deferred === "unsafe") {
      safe = false;
      return;
    }
    if (deferred !== null) {
      nestedReadEffects.add(deferred);
    }
  });
  return (
    safe &&
    nestedReadEffects.size > 0 &&
    [...nestedReadEffects].every((effect) => effectCleansUpAndDependsOn(effect, state.valueName))
  );
}

function effectCleansUpAndDependsOn(effect: ts.CallExpression, valueName: string): boolean {
  const [callback, dependencies] = effect.arguments;
  if (
    callback === undefined ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    dependencies === undefined ||
    !ts.isArrayLiteralExpression(dependencies)
  ) {
    return false;
  }
  return (
    callbackHasCleanup(callback, EMPTY_STATE_CANDIDATES) &&
    dependencies.elements.some((element) => {
      const value = unwrapTransparentExpression(element);
      return ts.isIdentifier(value) && value.text === valueName;
    })
  );
}

interface CallbackRegistrationScope {
  readonly childContracts: ChildContractResolver;
  readonly effect: ts.ArrowFunction | ts.FunctionExpression;
}

function isDeferredCallbackRegistration(
  call: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  { childContracts, effect }: CallbackRegistrationScope,
): call is ts.CallExpression {
  const owner = findAncestor(effect, isRuntimeFunctionLike);
  return (
    owner !== null &&
    ts.isCallExpression(call) &&
    call.arguments.includes(callback) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    bindingDeclarationCount(owner, call.expression.expression.text) === 0 &&
    childContracts.callbackRegistrationIsDeferred(
      call.expression.expression.text,
      call.expression.name.text,
      call.arguments.indexOf(callback),
    )
  );
}

function constDisposerDeclaration(
  call: ts.CallExpression,
  effect: ts.ArrowFunction | ts.FunctionExpression,
): ts.VariableDeclaration | null {
  const declaration = findAncestorUntil(call, ts.isVariableDeclaration, effect);
  if (
    !declaration ||
    !declaration.initializer ||
    unwrapTransparentExpression(declaration.initializer) !== call ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(effect, declaration.name.text) !== 1
  ) {
    return null;
  }
  return declaration;
}

export function bindingReferencesIn(
  body: ts.Node,
  declaration: ts.VariableDeclaration,
): readonly ts.Identifier[] {
  const name = declaration.name.getText();
  const references: ts.Identifier[] = [];
  visit(body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node !== declaration.name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function registeredCallbackHasEffectCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  effect: ts.ArrowFunction | ts.FunctionExpression,
  childContracts: ChildContractResolver,
): boolean {
  const call = callback.parent;
  if (!isDeferredCallbackRegistration(call, callback, { childContracts, effect })) {
    return false;
  }
  const declaration = constDisposerDeclaration(call, effect);
  if (!declaration) {
    return false;
  }
  const references = bindingReferencesIn(effect.body, declaration);
  return (
    references.length > 0 &&
    references.every((reference) => {
      const returned = findAncestorUntil(reference, ts.isReturnStatement, effect);
      if (!returned?.expression) {
        return false;
      }
      const cleanup = unwrapTransparentExpression(returned.expression);
      if (cleanup === reference) {
        return true;
      }
      if (!ts.isArrowFunction(cleanup) && !ts.isFunctionExpression(cleanup)) {
        return false;
      }
      return (
        ts.isCallExpression(reference.parent) &&
        reference.parent.expression === reference &&
        nearestNestedFunction(reference, effect) === cleanup
      );
    })
  );
}
