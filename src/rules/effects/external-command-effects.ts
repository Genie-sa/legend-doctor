import type {
  DependencyEffectScope,
  EffectCallSurvey,
  EffectClassificationContext,
} from "./model.js";
import {
  bindingDeclarationCount,
  callRootIdentifier,
  isAssignmentOperator,
} from "../../core/analysis-ast.js";
import { commandSupportCallsAreInert, isCallbackDrivenCall } from "./command-support-calls.js";
import { visit, visitSkippingNestedFunctions } from "../../core/ast.js";
import type { EffectCandidate } from "../../analysis/model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

const PURE_GLOBAL_RECEIVERS = new Set(["console", "Math", "Promise"]);

const SCHEDULER_GLOBAL_PATTERN =
  /^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)$/u;

export function isDependencyDrivenExternalCommandEffect(
  effect: EffectCandidate,
  context: EffectClassificationContext,
): boolean {
  const { callback, dependencies, owner } = effect;
  if (
    !callback ||
    !ts.isBlock(callback.body) ||
    !dependencies?.elements.length ||
    !owner ||
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    callback.asteriskToken ||
    dependenciesReadLocalSnapshots(dependencies, context)
  ) {
    return false;
  }
  const survey = surveyEffectCalls(callback, callback.body);
  const [command] = survey.commands;
  if (survey.hasOtherMutation || survey.commands.length !== 1 || !command) {
    return false;
  }
  const scope: DependencyEffectScope = {
    command,
    dependencies,
    effectCallback: callback,
    moduleScopeBindings: context.moduleScopeBindings,
    owner,
  };
  return commandSupportCallsAreInert(survey, scope) && isExternalCommandCallee(command, owner);
}

function dependenciesReadLocalSnapshots(
  dependencies: ts.ArrayLiteralExpression,
  context: EffectClassificationContext,
): boolean {
  let reads = false;
  visit(dependencies, (node) => {
    if (
      ts.isIdentifier(node) &&
      (context.stateByValue.has(node.text) ||
        context.useValueBindings.has(node.text) ||
        context.useObservableBindings.has(node.text))
    ) {
      reads = true;
    }
  });
  return reads;
}

function surveyEffectCalls(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  body: ts.Block,
): EffectCallSurvey {
  const calls: ts.CallExpression[] = [];
  const commands: ts.CallExpression[] = [];
  let hasOtherMutation = false;
  visitSkippingNestedFunctions(body, callback, (node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node);
      if (isStandaloneEffectCommand(node, callback)) {
        commands.push(node);
      }
    }
    if (isMutatingEffectNode(node)) {
      hasOtherMutation = true;
    }
  });
  return { calls, commands, hasOtherMutation };
}

function isMutatingEffectNode(node: ts.Node): boolean {
  return (
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    (ts.isNewExpression(node) && !isDependencyEffectValueConstructor(node)) ||
    ts.isDeleteExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    (ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)) ||
    (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind))
  );
}

function isExternalCommandCallee(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return (
      bindingDeclarationCount(owner, callee.text) === 0 &&
      !SCHEDULER_GLOBAL_PATTERN.test(callee.text)
    );
  }
  if (
    (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) ||
    isCallbackDrivenCall(call)
  ) {
    return false;
  }
  const root = callRootIdentifier(callee);
  return root !== null && !PURE_GLOBAL_RECEIVERS.has(root);
}

function isDependencyEffectValueConstructor(node: ts.NewExpression): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === "Date";
}

function isStandaloneEffectCommand(
  call: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  let current: ts.Node = call;
  while (
    current.parent !== callback.body &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isVoidExpression(current.parent))
  ) {
    current = current.parent;
  }
  return ts.isExpressionStatement(current.parent) && current.parent.expression === current;
}
