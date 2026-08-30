import type {
  ClassifiedEffect,
  EffectCandidate,
  StateCandidate,
  StateUsage,
} from "../analyze-source.js";
import {
  bindingDeclarationCount,
  callRootIdentifier,
  collectBindingNames,
  containsCallExpression,
  isAssignmentOperator,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isInsideJsxAttribute,
  isNonValueIdentifier,
  isPureExpression,
  isValueTransitionProp,
  localBindingNames,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { ChildContractResolver } from "./child-contract.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { isDependencyDrivenBrowserStorageEffect } from "./browser-storage-effect.js";
import { isImportedHookCall } from "../imports.js";
import ts from "typescript";

const KNOWN_GLOBAL_OBJECTS = new Set(["console", "Date", "Math", "JSON", "Promise", "globalThis"]);
const MINIMUM_COMMITTED_GUARD_STATEMENTS = 2;
const PURE_GLOBAL_RECEIVERS = new Set(["console", "Math", "Promise"]);
const SCHEDULER_GLOBAL_PATTERN =
  /^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)$/u;
const STRING_SEARCH_METHOD_PATTERN = /^(?:endsWith|includes|indexOf|lastIndexOf|startsWith)$/u;
const NO_EXEMPT_BINDINGS: ReadonlySet<string> = new Set<string>();
const REACT_EFFECT_DIRECTIVE_PATTERN =
  /^(?:react-effect-allow\b|legend-doctor\s+keep-react-effect\b)/u;
const LIFETIME_API_PATTERN =
  /^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|addEventListener|subscribe)$/u;

interface CommittedRefContext {
  readonly reactNamespaces: ReadonlySet<string>;
  readonly useRefBindings: ReadonlySet<string>;
}

interface EffectClassificationContext extends CommittedRefContext {
  readonly childContracts: ChildContractResolver | null;
  readonly moduleScopeBindings: ReadonlySet<string>;
  readonly stateBySetter: ReadonlyMap<string, StateCandidate>;
  readonly stateByValue: ReadonlyMap<string, StateCandidate>;
  readonly usageBySetter: ReadonlyMap<string, StateUsage>;
  readonly useObservableBindings: ReadonlySet<string>;
  readonly useValueBindings: ReadonlySet<string>;
}

interface InlineEffectContext extends EffectClassificationContext {
  readonly hasCleanup: boolean;
}

interface DependencyEffectScope {
  readonly command: ts.CallExpression;
  readonly dependencies: ts.ArrayLiteralExpression;
  readonly effectCallback: ts.ArrowFunction | ts.FunctionExpression;
  readonly moduleScopeBindings: ReadonlySet<string>;
  readonly owner: RuntimeFunctionLike;
}

function calleeName(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

function calleeRootIdentifier(callee: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(callee)) {
    return callee;
  }
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    ? callee.expression
    : null;
}

function soleExpressionStatementBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | null {
  if (!ts.isBlock(callback.body)) {
    return callback.body;
  }
  const [statement] = callback.body.statements;
  return callback.body.statements.length === 1 && statement && ts.isExpressionStatement(statement)
    ? statement.expression
    : null;
}

function soleReturnStatementBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined {
  if (!ts.isBlock(callback.body)) {
    return callback.body;
  }
  const [statement] = callback.body.statements;
  return callback.body.statements.length === 1 && statement && ts.isReturnStatement(statement)
    ? statement.expression
    : undefined;
}

export function classifyEffect(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  stateByValue: ReadonlyMap<string, StateCandidate>,
  usageBySetter: ReadonlyMap<string, StateUsage>,
  useValueBindings: ReadonlySet<string>,
  useObservableBindings: ReadonlySet<string>,
  useRefBindings: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>,
  moduleScopeBindings: ReadonlySet<string>,
  nonProductionHarness: boolean,
  childContracts: ChildContractResolver | null,
): ClassifiedEffect {
  if (nonProductionHarness) {
    return harnessEffect();
  }
  if (hasReactEffectOwnershipDirective(effect)) {
    return ownershipDirectiveEffect();
  }
  if (!effect.callback) {
    return unresolvedCallbackEffect();
  }
  const context: EffectClassificationContext = {
    childContracts,
    moduleScopeBindings,
    reactNamespaces,
    stateBySetter,
    stateByValue,
    usageBySetter,
    useObservableBindings,
    useRefBindings,
    useValueBindings,
  };
  return classifyInlineEffect(effect, effect.callback, context);
}

function harnessEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message:
      "Keep this effect in its test, story, or demo harness; production lifecycle migrations do not apply here.",
  };
}

function ownershipDirectiveEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message:
      "Keep this React effect; its adjacent ownership directive explicitly preserves React lifecycle semantics.",
  };
}

function unresolvedCallbackEffect(): ClassifiedEffect {
  return {
    action: "review-effect",
    confidence: "probable",
    derivedState: null,
    message:
      "Review this effect; its callback is not defined inline, so execution and cleanup ownership are unresolved.",
  };
}

function classifyInlineEffect(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: EffectClassificationContext,
): ClassifiedEffect {
  const derivedState = findPureDerivedSetter(callback, effect.dependencies, context);
  if (derivedState) {
    return {
      action: "delete-effect",
      confidence: "certain",
      derivedState,
      message: `Delete this effect and calculate the value passed to \`${derivedState.setterName}\` directly during render.`,
    };
  }
  const eventReset = findMutationSiteReset(effect, context);
  if (eventReset) {
    return {
      action: "move-to-event",
      confidence: "probable",
      derivedState: null,
      message: `Move the \`${eventReset.target.valueName}\` reset into every ${eventReset.sources.map((source) => `\`${source.valueName}\``).join(", ")} mutation—inside the same observable action if this state is migrated—then delete this effect.`,
    };
  }
  const inline: InlineEffectContext = {
    ...context,
    hasCleanup: callbackHasCleanup(callback, context.stateBySetter),
  };
  if (effect.dependencies?.elements.length === 0) {
    return emptyDependencyClassification(effect, callback, inline);
  }
  return dependencyEffectClassification(effect, callback, inline);
}

function emptyDependencyClassification(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): ClassifiedEffect {
  if (isCleanupOnly(callback)) {
    return unmountEffect();
  }
  if (!inline.hasCleanup && effect.owner) {
    const mounted = mountClassification(callback, effect.owner, inline);
    if (mounted) {
      return mounted;
    }
  }
  if (!inline.hasCleanup && !callbackCallsKnownSetter(callback, inline.stateBySetter)) {
    return reviewEmptyDependencySetupEffect();
  }
  return keepPairedMountEffect();
}

function mountClassification(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  inline: InlineEffectContext,
): ClassifiedEffect | null {
  if (
    !capturesOwnerSnapshot(callback, owner, inline) &&
    callbackIsCommittedRefIntegration(callback, owner, inline)
  ) {
    return committedRefEffect();
  }
  return isSetupOnlyMountCandidate(callback, owner, inline) ? useMountEffect() : null;
}

function dependencyEffectClassification(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): ClassifiedEffect {
  if (!inline.hasCleanup && effect.owner && isCommittedRefEffect(effect, callback, inline)) {
    return committedRefEffect();
  }
  if (isObservableSourcedReaction(effect, callback, inline)) {
    return observeEffect();
  }
  if (!inline.hasCleanup && effect.owner && isDependencyDrivenBrowserStorageEffect(effect)) {
    return keepBrowserStorageEffect();
  }
  if (
    !inline.hasCleanup &&
    effect.owner &&
    isDependencyDrivenExternalCommandEffect(effect, inline)
  ) {
    return keepExternalIntegrationEffect();
  }
  return inline.hasCleanup ? keepLifecycleEffect() : reviewCausalOwnerEffect();
}

function isCommittedRefEffect(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): boolean {
  return (
    effect.owner !== null &&
    (isExactLatestValueRefMirror(effect, inline) ||
      isExactCommittedPreviousValueGuard(effect, inline) ||
      callbackIsCommittedRefIntegration(callback, effect.owner, inline) ||
      isCommittedPropRefSnapshot(effect, inline.stateBySetter))
  );
}

function isObservableSourcedReaction(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  inline: InlineEffectContext,
): boolean {
  const { dependencies } = effect;
  if (inline.hasCleanup || !dependencies || dependencies.elements.length === 0) {
    return false;
  }
  const dependencyNames = dependencies.elements.flatMap((element) =>
    ts.isIdentifier(element) ? [element.text] : [],
  );
  const directUseValueDependencies = dependencyNames.filter((name) =>
    inline.useValueBindings.has(name),
  );
  return (
    !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    !callback.asteriskToken &&
    dependencyNames.length === dependencies.elements.length &&
    dependencyNames.length > 0 &&
    directUseValueDependencies.length > 0 &&
    dependencyNames.every(
      (name) => inline.useValueBindings.has(name) || inline.useObservableBindings.has(name),
    ) &&
    directUseValueDependencies.every((name) => callbackReadsSynchronously(callback, name))
  );
}

function unmountEffect(): ClassifiedEffect {
  return {
    action: "use-unmount",
    confidence: "probable",
    derivedState: null,
    message:
      "Replace this teardown-only empty-dependency effect with `useUnmount` if once-only Legend lifecycle semantics are intended.",
  };
}

function useMountEffect(): ClassifiedEffect {
  return {
    action: "use-mount",
    confidence: "probable",
    derivedState: null,
    message:
      "Replace this module-global, setup-only effect with `useMount` if suppressing React Strict Mode's development replay is intended.",
  };
}

function reviewEmptyDependencySetupEffect(): ClassifiedEffect {
  return {
    action: "review-effect",
    confidence: "probable",
    derivedState: null,
    message:
      "Review this empty-dependency setup before choosing `useMount`; suppressing React Strict Mode's development replay changes lifecycle semantics.",
  };
}

function keepPairedMountEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message: "Keep this React effect; it owns paired mount setup and cleanup semantics.",
  };
}

function observeEffect(): ClassifiedEffect {
  return {
    action: "use-observe-effect",
    confidence: "probable",
    derivedState: null,
    message:
      "Rewrite this post-mount reaction with `useObserveEffect`, reading its observable sources directly; dependencies are `useValue` snapshots or stable `useObservable` handles.",
  };
}

function keepBrowserStorageEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message:
      "Keep this React effect; it persists React dependencies to browser storage after commit.",
  };
}

function keepExternalIntegrationEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "probable",
    derivedState: null,
    message:
      "Keep this React effect; external integration follows React dependencies and is not an observable reaction.",
  };
}

function keepLifecycleEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message: "Keep this React effect; it owns an explicit setup and cleanup lifecycle.",
  };
}

function reviewCausalOwnerEffect(): ClassifiedEffect {
  return {
    action: "review-effect",
    confidence: "probable",
    derivedState: null,
    message:
      "Review this effect's causal owner before choosing React lifecycle, an event handler, or an observable reaction.",
  };
}

function hasReactEffectOwnershipDirective(effect: EffectCandidate): boolean {
  const statement = findAncestorUntil(
    effect.call,
    ts.isExpressionStatement,
    effect.owner ?? effect.call.getSourceFile(),
  );
  const directive = statement && adjacentLeadingCommentText(statement);
  return directive !== null && REACT_EFFECT_DIRECTIVE_PATTERN.test(directive);
}

function adjacentLeadingCommentText(statement: ts.Statement): string | null {
  const sourceFile = statement.getSourceFile();
  const leadingComments =
    ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ?? [];
  const comment = leadingComments.at(-1);
  if (!comment) {
    return null;
  }
  const gap = sourceFile.text.slice(comment.end, statement.getStart(sourceFile));
  if (/\r?\n[\t ]*\r?\n/u.test(gap)) {
    return null;
  }
  return sourceFile.text
    .slice(comment.pos, comment.end)
    .replace(/^\s*\/[/*]+\s*/u, "")
    .replace(/\*\/\s*$/u, "");
}

function isCommittedPropRefSnapshot(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  const { callback, dependencies, owner } = effect;
  const [dependency] = dependencies?.elements ?? [];
  if (
    !callback ||
    !owner ||
    !ts.isBlock(callback.body) ||
    callback.body.statements.length !== 1 ||
    dependencies?.elements.length !== 1 ||
    !dependency ||
    !ts.isIdentifier(dependency)
  ) {
    return false;
  }
  const refName = dependency.text;
  const [statement] = callback.body.statements;
  const argument =
    statement && parameterBindingNames(owner).has(refName)
      ? refCurrentSetterArgument(statement, stateBySetter)
      : null;
  return (
    argument !== null &&
    ts.isPropertyAccessExpression(argument) &&
    argument.name.text === "current" &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === refName
  );
}

function refCurrentSetterArgument(
  statement: ts.Statement,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): ts.Expression | null {
  if (!ts.isExpressionStatement(statement)) {
    return null;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !stateBySetter.has(expression.expression.text) ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  return unwrapTransparentExpression(expression.arguments[0]!);
}

function parameterBindingNames(owner: RuntimeFunctionLike): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of owner.parameters) {
    collectBindingNames(parameter.name, names);
  }
  return names;
}

function isDependencyDrivenExternalCommandEffect(
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

interface EffectCallSurvey {
  readonly calls: readonly ts.CallExpression[];
  readonly commands: readonly ts.CallExpression[];
  readonly hasOtherMutation: boolean;
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

function commandSupportCallsAreInert(
  survey: EffectCallSurvey,
  scope: DependencyEffectScope,
): boolean {
  const nestedCalls = survey.calls.filter((candidate) => candidate !== scope.command);
  const argumentCalls = nestedCalls.filter((candidate) =>
    scope.command.arguments.some((argument) => nodeWithin(candidate, argument)),
  );
  const projectionCallbacks = new Set<ts.Node>(
    nestedCalls.flatMap((candidate) => {
      const projection = dependencyMapProjectionCallback(candidate, scope);
      return projection ? [projection] : [];
    }),
  );
  return !(
    containsFunctionLike(scope.effectCallback.body, projectionCallbacks) ||
    argumentCalls.length > 1 ||
    nestedCalls.length - argumentCalls.length > 1 ||
    nestedCalls.some((candidate) => !isDependencyEffectSupportCall(candidate, scope)) ||
    isSubscriptionCall(scope.command)
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

function isDependencyEffectSupportCall(
  call: ts.CallExpression,
  scope: DependencyEffectScope,
): boolean {
  if (dependencyMapProjectionCallback(call, scope)) {
    return true;
  }
  if (isCallbackDrivenCall(call) || isSubscriptionCall(call)) {
    return false;
  }
  if (isStringSearchCall(call)) {
    return true;
  }
  const root = callRootIdentifier(call.expression);
  if (root === null) {
    return false;
  }
  return bindingDeclarationCount(scope.owner, root) === 0
    ? scope.moduleScopeBindings.has(root) || KNOWN_GLOBAL_OBJECTS.has(root)
    : scope.command.arguments.some((argument) => nodeWithin(call, argument)) &&
        isImportedTranslationArgument(call, scope.owner, scope.dependencies);
}

function isStringSearchCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    STRING_SEARCH_METHOD_PATTERN.test(call.expression.name.text)
  );
}

function dependencyMapProjectionCallback(
  call: ts.CallExpression,
  scope: DependencyEffectScope,
): ts.ArrowFunction | null {
  if (
    !scope.command.arguments.some((argument) => nodeWithin(call, argument)) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "map" ||
    call.arguments.length !== 1
  ) {
    return null;
  }
  const [argument] = call.arguments;
  if (!argument || !ts.isArrowFunction(argument) || !isPureProjectionArrow(argument)) {
    return null;
  }
  const receiver = unwrapTransparentExpression(call.expression.expression);
  const root = staticAccessRoot(receiver);
  if (!root || bindingDeclarationCount(scope.effectCallback, root.text) !== 0) {
    return null;
  }
  return scope.dependencies.elements.some((dependency) =>
    sameStaticAccess(receiver, unwrapTransparentExpression(dependency)),
  )
    ? argument
    : null;
}

function isPureProjectionArrow(callback: ts.ArrowFunction): boolean {
  const parameter = callback.parameters.length === 1 ? callback.parameters[0]! : null;
  return (
    parameter !== null &&
    ts.isIdentifier(parameter.name) &&
    !parameter.dotDotDotToken &&
    !parameter.initializer &&
    !ts.isBlock(callback.body) &&
    !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
    isParameterProjection(callback.body, parameter.name.text)
  );
}

function staticAccessRoot(expression: ts.Expression): ts.Identifier | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return value;
  }
  return ts.isPropertyAccessExpression(value) ? staticAccessRoot(value.expression) : null;
}

function isParameterProjection(expression: ts.Expression, parameterName: string): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return value.text === parameterName;
  }
  return (
    ts.isPropertyAccessExpression(value) && isParameterProjection(value.expression, parameterName)
  );
}

function sameStaticAccess(left: ts.Expression, right: ts.Expression): boolean {
  if (ts.isIdentifier(left) || ts.isIdentifier(right)) {
    return ts.isIdentifier(left) && ts.isIdentifier(right) && left.text === right.text;
  }
  if (ts.isPropertyAccessExpression(left) || ts.isPropertyAccessExpression(right)) {
    return (
      ts.isPropertyAccessExpression(left) &&
      ts.isPropertyAccessExpression(right) &&
      left.name.text === right.name.text &&
      sameStaticAccess(
        unwrapTransparentExpression(left.expression),
        unwrapTransparentExpression(right.expression),
      )
    );
  }
  return false;
}

function isDependencyEffectValueConstructor(node: ts.NewExpression): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === "Date";
}

function isImportedTranslationArgument(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  dependencies: ts.ArrayLiteralExpression,
): boolean {
  if (!ts.isIdentifier(call.expression) || !owner.body) {
    return false;
  }
  const localName = call.expression.text;
  if (
    !dependencies.elements.some((element) => ts.isIdentifier(element) && element.text === localName)
  ) {
    return false;
  }
  const hookName = translationHookName(owner.body, localName);
  return (
    hookName !== null &&
    bindingDeclarationCount(owner, hookName) === 0 &&
    importsUseTranslationAs(owner.getSourceFile(), hookName)
  );
}

type ConstObjectDestructuring = ts.VariableDeclaration & {
  readonly initializer: ts.CallExpression;
  readonly name: ts.ObjectBindingPattern;
};

function isConstObjectDestructuring(node: ts.Node): node is ConstObjectDestructuring {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.initializer !== undefined &&
    ts.isCallExpression(node.initializer) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function isTranslationBinding(element: ts.BindingElement, localName: string): boolean {
  const sourceName = element.propertyName ?? element.name;
  return (
    !element.dotDotDotToken &&
    ts.isIdentifier(element.name) &&
    element.name.text === localName &&
    ts.isIdentifier(sourceName) &&
    sourceName.text === "t"
  );
}

function translationHookName(body: ts.Node, localName: string): string | null {
  let hookName: string | null = null;
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (hookName !== null || !isConstObjectDestructuring(node)) {
      return;
    }
    const binding = node.name.elements.find((element) => isTranslationBinding(element, localName));
    if (binding && ts.isIdentifier(node.initializer.expression)) {
      hookName = node.initializer.expression.text;
    }
  });
  return hookName;
}

function importsUseTranslationAs(sourceFile: ts.SourceFile, hookName: string): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "react-i18next" &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (specifier) =>
          specifier.name.text === hookName &&
          (specifier.propertyName?.text ?? specifier.name.text) === "useTranslation",
      ),
  );
}

function containsFunctionLike(node: ts.Node, allowed: ReadonlySet<ts.Node> = new Set()): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isFunctionLike(candidate) && !allowed.has(candidate)) {
      found = true;
    }
  });
  return found;
}

function isCallbackDrivenCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    /^(?:addEventListener|every|filter|find|findIndex|flatMap|forEach|map|reduce|reduceRight|some)$/u.test(
      call.expression.name.text,
    )
  );
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

function committedRefEffect(): ClassifiedEffect {
  return {
    action: "keep-effect",
    confidence: "certain",
    derivedState: null,
    message:
      "Keep this React effect; it operates on a committed ref and depends on React post-commit ordering.",
  };
}

function isExactLatestValueRefMirror(
  effect: EffectCandidate,
  context: CommittedRefContext,
): boolean {
  const { callback, dependencies, owner } = effect;
  const dependency = dependencies?.elements[0] ?? null;
  if (!callback || !owner || (dependencies !== null && dependencies.elements.length !== 1)) {
    return false;
  }
  const mirror = latestValueRefAssignment(callback);
  if (
    !mirror ||
    localBindingNames(callback, null).has(mirror.refName) ||
    !localCommittedRefBindings(owner, context.useRefBindings, context.reactNamespaces).has(
      mirror.refName,
    )
  ) {
    return false;
  }
  const sourceFile = effect.call.getSourceFile();
  return (
    isPureExpression(mirror.source) &&
    (dependency === null ||
      mirror.source.getText(sourceFile) ===
        unwrapTransparentExpression(dependency).getText(sourceFile))
  );
}

interface RefMirrorAssignment {
  readonly refName: string;
  readonly source: ts.Expression;
}

function latestValueRefAssignment(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): RefMirrorAssignment | null {
  const statementExpression = soleExpressionStatementBody(callback);
  const assignment = statementExpression && unwrapTransparentExpression(statementExpression);
  if (
    !assignment ||
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }
  const target = unwrapTransparentExpression(assignment.left);
  if (
    !ts.isPropertyAccessExpression(target) ||
    target.name.text !== "current" ||
    !ts.isIdentifier(target.expression)
  ) {
    return null;
  }
  return {
    refName: target.expression.text,
    source: unwrapTransparentExpression(assignment.right),
  };
}

function isExactCommittedPreviousValueGuard(
  effect: EffectCandidate,
  context: CommittedRefContext,
): boolean {
  const { callback, dependencies, owner } = effect;
  const ownerBody = owner?.body;
  const [dependency] = dependencies?.elements ?? [];
  if (
    !callback ||
    !owner ||
    !ownerBody ||
    !ts.isBlock(ownerBody) ||
    !ts.isBlock(callback.body) ||
    !isSynchronousParameterlessCallback(callback) ||
    dependencies?.elements.length !== 1 ||
    !dependency ||
    !ts.isIdentifier(dependency) ||
    callback.body.statements.length < MINIMUM_COMMITTED_GUARD_STATEMENTS
  ) {
    return false;
  }
  const refName = committedPreviousValueRefName(callback.body, dependency.text);
  if (!refName || localBindingNames(callback, null).has(refName)) {
    return false;
  }
  const query: SeededRefQuery = {
    context,
    dependencyName: dependency.text,
    owner,
    refName,
  };
  return ownerBody.statements.some((statement) => declaresSeededCommittedRef(statement, query));
}

function isSynchronousParameterlessCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  return (
    callback.parameters.length === 0 &&
    !callback.asteriskToken &&
    !callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function committedPreviousValueRefName(body: ts.Block, dependencyName: string): string | null {
  const [guard, commitStatement] = body.statements;
  if (
    !guard ||
    !ts.isIfStatement(guard) ||
    guard.elseStatement ||
    !isBareReturn(guard.thenStatement)
  ) {
    return null;
  }
  const condition = unwrapTransparentExpression(guard.expression);
  if (
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return null;
  }
  const refName = committedRefComparedWithDependency(condition, dependencyName);
  return refName && commitsDependencyToRef(commitStatement, refName, dependencyName)
    ? refName
    : null;
}

function commitsDependencyToRef(
  statement: ts.Statement | undefined,
  refName: string,
  dependencyName: string,
): boolean {
  if (!statement || !ts.isExpressionStatement(statement)) {
    return false;
  }
  const commit = unwrapTransparentExpression(statement.expression);
  if (!ts.isBinaryExpression(commit) || commit.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return false;
  }
  const committedValue = unwrapTransparentExpression(commit.right);
  return (
    committedRefName(commit.left) === refName &&
    ts.isIdentifier(committedValue) &&
    committedValue.text === dependencyName
  );
}

interface SeededRefQuery {
  readonly context: CommittedRefContext;
  readonly dependencyName: string;
  readonly owner: RuntimeFunctionLike;
  readonly refName: string;
}

function declaresSeededCommittedRef(statement: ts.Statement, query: SeededRefQuery): boolean {
  if (
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const)
  ) {
    return false;
  }
  return statement.declarationList.declarations.some((declaration) =>
    isSeededCommittedRefDeclaration(declaration, query),
  );
}

function isSeededCommittedRefDeclaration(
  declaration: ts.VariableDeclaration,
  query: SeededRefQuery,
): boolean {
  const { initializer } = declaration;
  return (
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === query.refName &&
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    isImportedHookCall(
      initializer,
      query.context.useRefBindings,
      query.context.reactNamespaces,
      "useRef",
    ) &&
    importedHookIsUnshadowed(initializer, query.owner) &&
    initializer.arguments.length === 1 &&
    ts.isIdentifier(initializer.arguments[0]!) &&
    initializer.arguments[0]!.text === query.dependencyName &&
    bindingDeclarationCount(query.owner, query.refName) === 1
  );
}

function isBareReturn(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) {
    return statement.expression === undefined;
  }
  return (
    ts.isBlock(statement) &&
    statement.statements.length === 1 &&
    ts.isReturnStatement(statement.statements[0]!) &&
    statement.statements[0]!.expression === undefined
  );
}

function committedRefComparedWithDependency(
  condition: ts.BinaryExpression,
  dependencyName: string,
): string | null {
  const left = unwrapTransparentExpression(condition.left);
  const right = unwrapTransparentExpression(condition.right);
  if (ts.isIdentifier(left) && left.text === dependencyName) {
    return committedRefName(right);
  }
  if (ts.isIdentifier(right) && right.text === dependencyName) {
    return committedRefName(left);
  }
  return null;
}

function committedRefName(expression: ts.Expression): string | null {
  const target = unwrapTransparentExpression(expression);
  return ts.isPropertyAccessExpression(target) &&
    target.name.text === "current" &&
    ts.isIdentifier(target.expression)
    ? target.expression.text
    : null;
}

interface RefIntegrationScope {
  readonly derivedBindings: Set<string>;
  integratesCommittedRef: boolean;
  readonly refs: ReadonlySet<string>;
}

function callbackIsCommittedRefIntegration(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: CommittedRefContext,
): boolean {
  if (!owner.body) {
    return false;
  }
  const refs = localCommittedRefBindings(owner, context.useRefBindings, context.reactNamespaces);
  if (refs.size === 0) {
    return false;
  }
  const scope: RefIntegrationScope = {
    derivedBindings: new Set<string>(),
    integratesCommittedRef: false,
    refs,
  };
  if (ts.isBlock(callback.body)) {
    return (
      statementsAreRefIntegration(callback.body.statements, scope) && scope.integratesCommittedRef
    );
  }
  return expressionIsRefIntegration(callback.body, scope) && scope.integratesCommittedRef;
}

function capturesOwnerBinding(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  exempt: ReadonlySet<string>,
): boolean {
  const ownerLocals = localBindingNames(owner, callback);
  const callbackLocals = localBindingNames(callback, null);
  let captures = false;
  visit(callback.body, (node) => {
    if (
      !captures &&
      ts.isIdentifier(node) &&
      ownerLocals.has(node.text) &&
      !exempt.has(node.text) &&
      !callbackLocals.has(node.text) &&
      !isNonValueIdentifier(node)
    ) {
      captures = true;
    }
  });
  return captures;
}

function capturesOwnerSnapshot(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: CommittedRefContext,
): boolean {
  return capturesOwnerBinding(
    callback,
    owner,
    localCommittedRefBindings(owner, context.useRefBindings, context.reactNamespaces),
  );
}

function isCommittedRefRead(child: ts.Node, refs: ReadonlySet<string>): boolean {
  if (
    !ts.isPropertyAccessExpression(child) ||
    child.name.text !== "current" ||
    !ts.isIdentifier(child.expression) ||
    !refs.has(child.expression.text)
  ) {
    return false;
  }
  const { parent } = child;
  const directAssignment =
    ts.isBinaryExpression(parent) &&
    parent.left === child &&
    isAssignmentOperator(parent.operatorToken.kind);
  const directUpdate =
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === child;
  return !directAssignment && !directUpdate;
}

function readsCommittedRef(node: ts.Node, refs: ReadonlySet<string>): boolean {
  let reads = false;
  visit(node, (child) => {
    if (!reads && isCommittedRefRead(child, refs)) {
      reads = true;
    }
  });
  return reads;
}

function callResultIsRefDerived(value: ts.CallExpression, scope: RefIntegrationScope): boolean {
  const receiver =
    ts.isPropertyAccessExpression(value.expression) ||
    ts.isElementAccessExpression(value.expression)
      ? value.expression.expression
      : null;
  return (
    receiver !== null &&
    expressionIsRefDerived(receiver, scope) &&
    value.arguments.every((argument) => !containsCallExpression(argument))
  );
}

function expressionIsRefDerived(expression: ts.Expression, scope: RefIntegrationScope): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return scope.derivedBindings.has(value.text);
  }
  if (ts.isPropertyAccessExpression(value)) {
    return (
      (value.name.text === "current" &&
        ts.isIdentifier(value.expression) &&
        scope.refs.has(value.expression.text)) ||
      expressionIsRefDerived(value.expression, scope)
    );
  }
  if (ts.isElementAccessExpression(value)) {
    return (
      expressionIsRefDerived(value.expression, scope) &&
      (!value.argumentExpression || !containsCallExpression(value.argumentExpression))
    );
  }
  return ts.isCallExpression(value) && callResultIsRefDerived(value, scope);
}

function expressionIsRefIntegration(
  expression: ts.Expression,
  scope: RefIntegrationScope,
): boolean {
  if (
    !ts.isCallExpression(expression) ||
    (!readsCommittedRef(expression, scope.refs) && !expressionIsRefDerived(expression, scope))
  ) {
    return false;
  }
  let safe = true;
  visit(expression, (node) => {
    if (
      safe &&
      ts.isCallExpression(node) &&
      !readsCommittedRef(node, scope.refs) &&
      !expressionIsRefDerived(node, scope)
    ) {
      safe = false;
    }
  });
  if (safe) {
    scope.integratesCommittedRef = true;
  }
  return safe;
}

function statementsAreRefIntegration(
  statements: readonly ts.Statement[],
  scope: RefIntegrationScope,
): boolean {
  const inheritedBindings = new Set(scope.derivedBindings);
  const safe =
    statements.length > 0 &&
    statements.every((statement) => statementIsRefIntegration(statement, scope));
  scope.derivedBindings.clear();
  for (const binding of inheritedBindings) {
    scope.derivedBindings.add(binding);
  }
  return safe;
}

function constDeclarationsAreRefDerived(
  statement: ts.VariableStatement,
  scope: RefIntegrationScope,
): boolean {
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
    return false;
  }
  for (const declaration of statement.declarationList.declarations) {
    if (
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      !expressionIsRefDerived(declaration.initializer, scope)
    ) {
      return false;
    }
    scope.derivedBindings.add(declaration.name.text);
  }
  return true;
}

function statementIsRefIntegration(statement: ts.Statement, scope: RefIntegrationScope): boolean {
  if (ts.isBlock(statement)) {
    return statementsAreRefIntegration(statement.statements, scope);
  }
  if (ts.isReturnStatement(statement)) {
    return statement.expression === undefined;
  }
  if (ts.isVariableStatement(statement)) {
    return constDeclarationsAreRefDerived(statement, scope);
  }
  if (ts.isIfStatement(statement)) {
    return (
      !containsCallExpression(statement.expression) &&
      statementIsRefIntegration(statement.thenStatement, scope) &&
      (!statement.elseStatement || statementIsRefIntegration(statement.elseStatement, scope))
    );
  }
  return (
    ts.isExpressionStatement(statement) && expressionIsRefIntegration(statement.expression, scope)
  );
}

function localCommittedRefBindings(
  owner: RuntimeFunctionLike,
  useRefBindings: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>,
): ReadonlySet<string> {
  const refs = new Set<string>();
  if (!owner.body) {
    return refs;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isImportedHookCall(node.initializer, useRefBindings, reactNamespaces, "useRef") &&
      importedHookIsUnshadowed(node.initializer, owner) &&
      bindingDeclarationCount(owner, node.name.text) === 1
    ) {
      refs.add(node.name.text);
    }
  });
  return refs;
}

function importedHookIsUnshadowed(call: ts.CallExpression, owner: RuntimeFunctionLike): boolean {
  const root = calleeRootIdentifier(call.expression);
  return root !== null && bindingDeclarationCount(owner, root.text) === 0;
}

function isSetupOnlyMountCandidate(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): boolean {
  if (
    !ts.isBlock(callback.body) ||
    callback.body.statements.length === 0 ||
    callbackCallsKnownSetter(callback, context.stateBySetter) ||
    !callback.body.statements.every(
      (statement) =>
        ts.isExpressionStatement(statement) && expressionContainsCall(statement.expression),
    ) ||
    hasLifetimeOrUnresolvedSetupCall(callback.body, context.moduleScopeBindings)
  ) {
    return false;
  }
  return !capturesOwnerBinding(callback, owner, NO_EXEMPT_BINDINGS);
}

function hasLifetimeOrUnresolvedSetupCall(
  body: ts.Block,
  moduleScopeBindings: ReadonlySet<string>,
): boolean {
  let unresolved = false;
  visit(body, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const callee = node.expression;
    if (LIFETIME_API_PATTERN.test(calleeName(callee))) {
      unresolved = true;
      return;
    }
    const root = callRootIdentifier(callee);
    if (root && !moduleScopeBindings.has(root) && !KNOWN_GLOBAL_OBJECTS.has(root)) {
      unresolved = true;
    }
  });
  return unresolved;
}

function expressionContainsCall(expression: ts.Expression): boolean {
  let contains = false;
  visit(expression, (node) => {
    if (ts.isCallExpression(node)) {
      contains = true;
    }
  });
  return contains;
}

function callbackReadsSynchronously(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
): boolean {
  let deferredRead = false;
  let reads = false;
  let shadowed = callback.parameters.some(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
  );
  visit(callback.body, (node) => {
    if (ts.isIdentifier(node) && isDeclarationName(node) && node.text === name) {
      shadowed = true;
      return;
    }
    if (
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    reads = true;
    if (readIsDeferred(node, callback)) {
      deferredRead = true;
    }
  });
  return reads && !deferredRead && !shadowed;
}

function readIsDeferred(
  node: ts.Node,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== callback;
    current = current.parent
  ) {
    if (
      isRuntimeFunctionLike(current) &&
      current !== callback &&
      !isSynchronousEffectCallback(current)
    ) {
      return true;
    }
  }
  return false;
}

function outermostTransparentWrapper(node: ts.Node): ts.Node {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isAsExpression(expression.parent) ||
    ts.isTypeAssertionExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent) ||
    ts.isNonNullExpression(expression.parent)
  ) {
    expression = expression.parent;
  }
  return expression;
}

function isSynchronousEffectCallback(callback: RuntimeFunctionLike): boolean {
  if (
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    callback.asteriskToken
  ) {
    return false;
  }
  const expression = outermostTransparentWrapper(callback);
  const call = expression.parent;
  if (!ts.isCallExpression(call)) {
    return false;
  }
  if (call.expression === expression) {
    return true;
  }
  // SAFETY: Every transparent wrapper admitted above is an Expression, so the
  // The callback node remains an Expression when it appears in call.arguments.
  return (
    call.arguments.includes(expression as ts.Expression) &&
    ts.isPropertyAccessExpression(call.expression) &&
    /^(?:every|filter|find|findIndex|flatMap|forEach|map|reduce|reduceRight|some)$/u.test(
      call.expression.name.text,
    ) &&
    hasSynchronousArrayReceiver(call.expression.expression)
  );
}

function soleBindingDeclaration(
  receiver: ts.Identifier,
): ts.BindingElement | ts.ParameterDeclaration | ts.VariableDeclaration | null {
  const declarations: (ts.BindingElement | ts.ParameterDeclaration | ts.VariableDeclaration)[] = [];
  visit(receiver.getSourceFile(), (node) => {
    if (
      (ts.isBindingElement(node) || ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === receiver.text
    ) {
      declarations.push(node);
    }
  });
  return declarations.length === 1 ? declarations[0]! : null;
}

function declarationHasArrayType(
  declaration: ts.BindingElement | ts.ParameterDeclaration | ts.VariableDeclaration,
): boolean {
  if (ts.isBindingElement(declaration)) {
    return bindingElementHasArrayType(declaration);
  }
  return (
    isArrayTypeNode(declaration.type) ||
    (ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      declaration.initializer !== undefined &&
      ts.isArrayLiteralExpression(unwrapTransparentExpression(declaration.initializer)))
  );
}

function hasSynchronousArrayReceiver(expression: ts.Expression): boolean {
  const receiver = unwrapTransparentExpression(expression);
  if (ts.isArrayLiteralExpression(receiver)) {
    return true;
  }
  if (!ts.isIdentifier(receiver)) {
    return false;
  }
  const declaration = soleBindingDeclaration(receiver);
  if (!declaration || arrayBindingHasDirectOverride(receiver)) {
    return false;
  }
  return declarationHasArrayType(declaration);
}

function arrayBindingHasDirectOverride(receiver: ts.Identifier): boolean {
  let overridden = false;
  visit(receiver.getSourceFile(), (node) => {
    if (overridden) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      expressionTargetsBinding(node.left, receiver.text)
    ) {
      overridden = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      expressionTargetsBinding(node.operand, receiver.text)
    ) {
      overridden = true;
      return;
    }
    if (ts.isDeleteExpression(node) && expressionTargetsBinding(node.expression, receiver.text)) {
      overridden = true;
    }
  });
  return overridden;
}

function expressionTargetsBinding(expression: ts.Expression, name: string): boolean {
  let current = unwrapTransparentExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === name;
}

function bindingElementHasArrayType(element: ts.BindingElement): boolean {
  const pattern = element.parent;
  if (!ts.isObjectBindingPattern(pattern)) {
    return false;
  }
  const declaration = pattern.parent;
  if (
    !ts.isParameter(declaration) ||
    !declaration.type ||
    !ts.isTypeLiteralNode(declaration.type)
  ) {
    return false;
  }
  const propertyName = element.propertyName?.getText() ?? element.name.getText();
  return declaration.type.members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      member.name?.getText() === propertyName &&
      isArrayTypeNode(member.type),
  );
}

function isArrayTypeNode(type: ts.TypeNode | undefined): boolean {
  if (!type) {
    return false;
  }
  if (ts.isArrayTypeNode(type)) {
    return true;
  }
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return isArrayTypeNode(type.type);
  }
  return false;
}

function findPureDerivedSetter(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  dependencies: ts.ArrayLiteralExpression | null,
  context: EffectClassificationContext,
): StateCandidate | null {
  if (!dependencies || dependencies.elements.length === 0) {
    return null;
  }
  const call = soleDirectSetterCall(callback, context.stateBySetter);
  if (!call || !isSoleUnescapedSetterUsage(context.usageBySetter.get(call.expression.text))) {
    return null;
  }
  const state = context.stateBySetter.get(call.expression.text);
  const [value] = call.arguments;
  return state && value && isTransparentDerivedValue(value, dependencies) ? state : null;
}

function isSoleUnescapedSetterUsage(usage: StateUsage | undefined): boolean {
  return (
    usage !== undefined &&
    usage.setterCalls === 1 &&
    usage.setterReferences === 1 &&
    !usage.escaped &&
    !usage.shadowed
  );
}

interface DerivedInputScan {
  readonly dependencyTexts: ReadonlySet<string>;
  hasInput: boolean;
  inputsMatch: boolean;
  readonly sourceFile: ts.SourceFile;
}

function isTransparentDerivedValue(
  value: ts.Expression,
  dependencies: ts.ArrayLiteralExpression,
): boolean {
  if (!isPureExpression(value)) {
    return false;
  }
  const sourceFile = value.getSourceFile();
  const scan: DerivedInputScan = {
    dependencyTexts: new Set(
      dependencies.elements.map((dependency) =>
        unwrapTransparentExpression(dependency).getText(sourceFile),
      ),
    ),
    hasInput: false,
    inputsMatch: true,
    sourceFile,
  };
  inspectDerivedInput(value, scan);
  return scan.hasInput && scan.inputsMatch;
}

function isOpaqueDerivedInput(node: ts.Node): boolean {
  return (
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassExpression(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node)
  );
}

function derivedInputText(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return unwrapTransparentExpression(node).getText(sourceFile);
  }
  return ts.isIdentifier(node) && !isNonValueIdentifier(node) ? node.text : null;
}

function recordDerivedInput(inputText: string, scan: DerivedInputScan): void {
  scan.hasInput = true;
  scan.inputsMatch = scan.dependencyTexts.has(inputText);
}

function inspectDerivedInput(node: ts.Node, scan: DerivedInputScan): void {
  if (!scan.inputsMatch) {
    return;
  }
  if (isOpaqueDerivedInput(node)) {
    scan.inputsMatch = false;
    return;
  }
  const inputText = derivedInputText(node, scan.sourceFile);
  if (inputText === null) {
    node.forEachChild((child) => inspectDerivedInput(child, scan));
    return;
  }
  recordDerivedInput(inputText, scan);
}

interface MutationSiteReset {
  sources: readonly StateCandidate[];
  target: StateCandidate;
}

function findMutationSiteReset(
  effect: EffectCandidate,
  context: EffectClassificationContext,
): MutationSiteReset | null {
  const sources = dependencySourceStates(effect, context.stateByValue);
  if (!effect.callback || !effect.owner || !sources) {
    return null;
  }
  const target = resetTargetState(effect.callback, effect.owner, context);
  if (!target || sources.includes(target)) {
    return null;
  }
  return sources.every((source) => setterOnlyMutatesAtEventBoundaries(source, context))
    ? { sources, target }
    : null;
}

function dependencySourceStates(
  effect: EffectCandidate,
  stateByValue: ReadonlyMap<string, StateCandidate>,
): readonly StateCandidate[] | null {
  const { dependencies, owner } = effect;
  if (!owner || !dependencies || dependencies.elements.length === 0) {
    return null;
  }
  const sourceNames = dependencies.elements.flatMap((element) =>
    ts.isIdentifier(element) ? [element.text] : [],
  );
  if (sourceNames.length !== dependencies.elements.length) {
    return null;
  }
  const sources = sourceNames.flatMap((name) => {
    const state = stateByValue.get(name);
    return state && state.owner === owner ? [state] : [];
  });
  return sources.length === sourceNames.length && new Set(sources).size === sources.length
    ? sources
    : null;
}

function resetTargetState(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): StateCandidate | null {
  const setterCall = soleDirectSetterCall(callback, context.stateBySetter);
  const target = setterCall ? context.stateBySetter.get(setterCall.expression.text) : undefined;
  if (!setterCall || !target || target.owner !== owner) {
    return null;
  }
  const [initializer] = target.call.arguments;
  const [reset] = setterCall.arguments;
  if (
    !initializer ||
    !reset ||
    !nodesHaveSameText(initializer, reset) ||
    !isStablePrimitiveReset(initializer)
  ) {
    return null;
  }
  const targetUsage = target.setterName ? context.usageBySetter.get(target.setterName) : undefined;
  return targetUsage && targetUsage.setterCalls > targetUsage.effectWrites ? target : null;
}

function setterOnlyMutatesAtEventBoundaries(
  source: StateCandidate,
  context: EffectClassificationContext,
): boolean {
  if (!source.setterName) {
    return false;
  }
  const usage = context.usageBySetter.get(source.setterName);
  return (
    usage !== undefined &&
    !usage.shadowed &&
    !usage.escaped &&
    usage.effectWrites === 0 &&
    usage.setterReferences !== 0 &&
    allSetterReferencesAreEventBoundaries(source, context.childContracts)
  );
}

function isStablePrimitiveReset(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    (ts.isPrefixUnaryExpression(value) &&
      (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
      (ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand)))
  );
}

function soleDirectSetterCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): (ts.CallExpression & { expression: ts.Identifier }) | null {
  const expression = soleExpressionStatementBody(callback);
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !stateBySetter.has(expression.expression.text) ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  // SAFETY: The guards prove both the CallExpression and Identifier parts of
  // They establish the intersection returned to callers.
  return expression as ts.CallExpression & { expression: ts.Identifier };
}

function nodesHaveSameText(left: ts.Node, right: ts.Node): boolean {
  return left.getText(left.getSourceFile()) === right.getText(right.getSourceFile());
}

function allSetterReferencesAreEventBoundaries(
  state: StateCandidate,
  childContracts: ChildContractResolver | null,
): boolean {
  if (!state.setterName) {
    return false;
  }
  let references = 0;
  let valid = true;
  visit(state.owner.body, (node) => {
    if (!valid || !ts.isIdentifier(node) || node.text !== state.setterName) {
      return;
    }
    if (node.parent === state.call.parent || isDeclarationName(node)) {
      return;
    }
    references += 1;
    if (!setterReferenceIsEventBoundary(node, state, childContracts)) {
      valid = false;
    }
  });
  return valid && references > 0;
}

interface EventBoundaryQuery {
  readonly attribute: ts.JsxAttribute;
  readonly childContracts: ChildContractResolver | null;
  readonly state: StateCandidate;
}

function setterReferenceIsEventBoundary(
  node: ts.Identifier,
  state: StateCandidate,
  childContracts: ChildContractResolver | null,
): boolean {
  const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
  if (!attribute) {
    return false;
  }
  const query: EventBoundaryQuery = { attribute, childContracts, state };
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return handlerCallSiteIsBoundToAttribute(node, query);
  }
  if (isDirectJsxAttributeExpression(attribute, node)) {
    return jsxAttributeHasProvenEventContract(attribute, childContracts);
  }
  return isDeferredArrayItemCallbackProperty(node, query);
}

function handlerCallSiteIsBoundToAttribute(
  node: ts.Identifier,
  query: EventBoundaryQuery,
): boolean {
  const callback = nearestNestedFunction(node, query.state.owner);
  if (!callback || !jsxAttributeHasProvenEventContract(query.attribute, query.childContracts)) {
    return false;
  }
  return isInsideJsxAttribute(callback, query.attribute);
}

function isDeferredArrayItemCallbackProperty(
  node: ts.Identifier,
  query: EventBoundaryQuery,
): boolean {
  const property = findAncestorUntil(node, ts.isPropertyAssignment, query.attribute);
  const opening = jsxOpeningForAttribute(query.attribute);
  const target = opening?.tagName.getText() ?? null;
  const callbackProperty = property ? staticPropertyName(property.name) : null;
  return (
    property !== null &&
    property.initializer === node &&
    callbackProperty !== null &&
    isValueTransitionProp(callbackProperty) &&
    target !== null &&
    query.childContracts?.componentArrayItemCallbackIsDeferred(
      target,
      query.attribute.name.getText(),
      callbackProperty,
    ) === true
  );
}

function jsxAttributeHasProvenEventContract(
  attribute: ts.JsxAttribute,
  childContracts: ChildContractResolver | null,
): boolean {
  const opening = jsxOpeningForAttribute(attribute);
  if (!opening) {
    return false;
  }
  const propName = attribute.name.getText();
  if (!isValueTransitionProp(propName) && !/^on[A-Z]/u.test(propName)) {
    return false;
  }
  const target = opening.tagName.getText();
  return (
    /^[a-z]/u.test(target) ||
    childContracts?.frameworkEventComponent(target) === true ||
    childContracts?.componentCallbackPropIsDeferred(target, propName) === true
  );
}

function jsxOpeningForAttribute(
  attribute: ts.JsxAttribute,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  const opening = attribute.parent.parent;
  return ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening) ? opening : null;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

export function callbackHasCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  if (!ts.isBlock(callback.body)) {
    if (
      ts.isCallExpression(callback.body) &&
      ts.isIdentifier(callback.body.expression) &&
      stateBySetter.has(callback.body.expression.text)
    ) {
      return false;
    }
    return (
      ts.isArrowFunction(callback.body) ||
      ts.isFunctionExpression(callback.body) ||
      ts.isIdentifier(callback.body) ||
      ts.isPropertyAccessExpression(callback.body) ||
      (ts.isCallExpression(callback.body) && isSubscriptionCall(callback.body))
    );
  }
  return callback.body.statements.some(
    (statement) => ts.isReturnStatement(statement) && statement.expression !== undefined,
  );
}

function isSubscriptionCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return /^(?:subscribe|listen|observe|register)/u.test(callee.text);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return /^(?:subscribe|listen|observe|register|addListener|on[A-Z])/u.test(callee.name.text);
  }
  return false;
}

function isCleanupOnly(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const expression = soleReturnStatementBody(callback);
  if (!expression) {
    return false;
  }
  const cleanup = unwrapTransparentExpression(expression);
  return (
    ts.isArrowFunction(cleanup) || ts.isFunctionExpression(cleanup) || ts.isIdentifier(cleanup)
  );
}

function callbackCallsKnownSetter(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
): boolean {
  let callsSetter = false;
  visit(callback.body, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      stateBySetter.has(node.expression.text)
    ) {
      callsSetter = true;
    }
  });
  return callsSetter;
}
