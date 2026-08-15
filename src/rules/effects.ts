import ts from "typescript";

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
  isNonProductionHarness,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  type RuntimeFunctionLike,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import { isImportedHookCall } from "../imports.js";
import type {
  ClassifiedEffect,
  EffectCandidate,
  StateCandidate,
  StateUsage,
} from "../analyze-source.js";
import { isDependencyDrivenBrowserStorageEffect } from "./browser-storage-effect.js";

export function classifyEffect(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  stateByValue: ReadonlyMap<string, StateCandidate>,
  usageBySetter: ReadonlyMap<string, StateUsage>,
  useValueBindings: ReadonlySet<string>,
  useObservableBindings: ReadonlySet<string>,
  useRefBindings: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>,
  moduleScopeBindings: ReadonlySet<string>
): ClassifiedEffect {
  if (hasReactEffectOwnershipDirective(effect)) {
    return {
      action: "keep-effect",
      confidence: "certain",
      derivedState: null,
      message: "Keep this React effect; its adjacent ownership directive explicitly preserves React lifecycle semantics.",
    };
  }
  if (!effect.callback) {
    return {
      action: "review-effect",
      confidence: "probable",
      derivedState: null,
      message: "Review this effect; its callback is not defined inline, so execution and cleanup ownership are unresolved.",
    };
  }

  const derivedState = findPureDerivedSetter(
    effect.callback,
    effect.dependencies,
    stateBySetter,
    usageBySetter
  );
  if (derivedState) {
    return {
      action: "delete-effect",
      confidence: "certain",
      derivedState,
      message: `Delete this effect and calculate the value passed to \`${derivedState.setterName}\` directly during render.`,
    };
  }

  const eventReset = findMutationSiteReset(
    effect,
    stateBySetter,
    stateByValue,
    usageBySetter
  );
  if (eventReset) {
    return {
      action: "move-to-event",
      confidence: "probable",
      derivedState: null,
      message: `Move the \`${eventReset.target.valueName}\` reset into every ${eventReset.sources.map(source => `\`${source.valueName}\``).join(", ")} mutation—inside the same observable action if this state is migrated—then delete this effect.`,
    };
  }

  const hasCleanup = callbackHasCleanup(effect.callback, stateBySetter);
  if (effect.dependencies?.elements.length === 0) {
    if (isCleanupOnly(effect.callback)) {
      return {
        action: "use-unmount",
        confidence: "probable",
        derivedState: null,
        message: "Replace this teardown-only empty-dependency effect with `useUnmount` if once-only Legend lifecycle semantics are intended.",
      };
    }
    if (
      !hasCleanup &&
      effect.owner &&
      callbackIsCommittedRefIntegration(
        effect.callback,
        effect.owner,
        useRefBindings,
        reactNamespaces,
        true
      )
    ) {
      return committedRefEffect();
    }
    if (
      !hasCleanup &&
      effect.owner &&
      isSetupOnlyMountCandidate(effect.callback, effect.owner, stateBySetter, moduleScopeBindings)
    ) {
      return {
        action: "use-mount",
        confidence: "probable",
        derivedState: null,
        message: "Replace this module-global, setup-only effect with `useMount` if suppressing React Strict Mode's development replay is intended.",
      };
    }
    if (!hasCleanup && !callbackCallsKnownSetter(effect.callback, stateBySetter)) {
      return {
        action: "review-effect",
        confidence: "probable",
        derivedState: null,
        message: "Review this empty-dependency setup before choosing `useMount`; suppressing React Strict Mode's development replay changes lifecycle semantics.",
      };
    }
    return {
      action: "keep-effect",
      confidence: "certain",
      derivedState: null,
      message: "Keep this React effect; it owns paired mount setup and cleanup semantics.",
    };
  }

  if (
    !hasCleanup &&
    effect.owner &&
    (isExactLatestValueRefMirror(effect, useRefBindings, reactNamespaces) ||
      callbackIsCommittedRefIntegration(
        effect.callback,
        effect.owner,
        useRefBindings,
        reactNamespaces
      ) ||
      isCommittedPropRefSnapshot(effect, stateBySetter))
  ) {
    return committedRefEffect();
  }

  if (effect.dependencies && effect.dependencies.elements.length > 0 && !hasCleanup) {
    const dependencyNames = effect.dependencies.elements.flatMap(element =>
      ts.isIdentifier(element) ? [element.text] : []
    );
    const directUseValueDependencies = dependencyNames.filter(name => useValueBindings.has(name));
    if (
      !effect.callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
      !effect.callback.asteriskToken &&
      dependencyNames.length === effect.dependencies.elements.length &&
      dependencyNames.length > 0 &&
      directUseValueDependencies.length > 0 &&
      dependencyNames.every(name => useValueBindings.has(name) || useObservableBindings.has(name)) &&
      directUseValueDependencies.every(name => callbackReadsSynchronously(effect.callback!, name))
    ) {
      return {
        action: "use-observe-effect",
        confidence: "probable",
        derivedState: null,
        message: "Rewrite this post-mount reaction with `useObserveEffect`, reading its observable sources directly; dependencies are `useValue` snapshots or stable `useObservable` handles.",
      };
    }
  }

  if (
    !hasCleanup &&
    effect.owner &&
    isDependencyDrivenBrowserStorageEffect(effect)
  ) {
    return {
      action: "keep-effect",
      confidence: "probable",
      derivedState: null,
      message: "Keep this React effect; it persists React dependencies to browser storage after commit.",
    };
  }

  if (
    !hasCleanup &&
    effect.owner &&
    isDependencyDrivenExternalCommandEffect(
      effect,
      stateByValue,
      useValueBindings,
      useObservableBindings,
      moduleScopeBindings
    )
  ) {
    return {
      action: "keep-effect",
      confidence: "probable",
      derivedState: null,
      message: "Keep this React effect; external integration follows React dependencies and is not an observable reaction.",
    };
  }

  if (hasCleanup) {
    return {
      action: "keep-effect",
      confidence: "certain",
      derivedState: null,
      message: "Keep this React effect; it owns an explicit setup and cleanup lifecycle.",
    };
  }
  return {
    action: "review-effect",
    confidence: "probable",
    derivedState: null,
    message: "Review this effect's causal owner before choosing React lifecycle, an event handler, or an observable reaction.",
  };
}

function hasReactEffectOwnershipDirective(effect: EffectCandidate): boolean {
  const statement = findAncestorUntil(
    effect.call,
    ts.isExpressionStatement,
    effect.owner ?? effect.call.getSourceFile()
  );
  if (!statement) return false;
  const sourceFile = effect.call.getSourceFile();
  const leadingComments = ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ?? [];
  const comment = leadingComments.at(-1);
  if (!comment) return false;
  const gap = sourceFile.text.slice(comment.end, statement.getStart(sourceFile));
  if (/\r?\n[\t ]*\r?\n/.test(gap)) return false;
  const body = sourceFile.text
    .slice(comment.pos, comment.end)
    .replace(/^\s*\/[/\*]+\s*/, "")
    .replace(/\*\/\s*$/, "");
  return /^(?:react-effect-allow\b|legend-doctor\s+keep-react-effect\b)/.test(body);
}

function isCommittedPropRefSnapshot(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): boolean {
  const { callback, dependencies, owner } = effect;
  const dependency = dependencies?.elements[0];
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
  if (!parameterBindingNames(owner).has(refName)) return false;
  const statement = callback.body.statements[0]!;
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = unwrapTransparentExpression(statement.expression);
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !stateBySetter.has(expression.expression.text) ||
    expression.arguments.length !== 1
  ) {
    return false;
  }
  const argument = unwrapTransparentExpression(expression.arguments[0]!);
  return (
    ts.isPropertyAccessExpression(argument) &&
    argument.name.text === "current" &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === refName
  );
}

function parameterBindingNames(owner: RuntimeFunctionLike): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of owner.parameters) collectBindingNames(parameter.name, names);
  return names;
}

function isDependencyDrivenExternalCommandEffect(
  effect: EffectCandidate,
  stateByValue: ReadonlyMap<string, StateCandidate>,
  useValueBindings: ReadonlySet<string>,
  useObservableBindings: ReadonlySet<string>,
  moduleScopeBindings: ReadonlySet<string>
): boolean {
  const { callback, dependencies, owner } = effect;
  if (
    !callback ||
    !ts.isBlock(callback.body) ||
    !dependencies?.elements.length ||
    !owner ||
    callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    callback.asteriskToken
  ) {
    return false;
  }

  let readsLocalStateOrObservableSnapshot = false;
  for (const dependency of dependencies.elements) {
    visit(dependency, node => {
      if (
        ts.isIdentifier(node) &&
        (stateByValue.has(node.text) ||
          useValueBindings.has(node.text) ||
          useObservableBindings.has(node.text))
      ) {
        readsLocalStateOrObservableSnapshot = true;
      }
    });
  }
  if (readsLocalStateOrObservableSnapshot) return false;

  const calls: ts.CallExpression[] = [];
  const commands: ts.CallExpression[] = [];
  let hasOtherMutation = false;
  visitSkippingNestedFunctions(callback.body, callback, node => {
    if (ts.isCallExpression(node)) {
      calls.push(node);
      if (isStandaloneEffectCommand(node, callback)) commands.push(node);
    }
    if (
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      (ts.isNewExpression(node) && !isDependencyEffectValueConstructor(node)) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind))
    ) {
      hasOtherMutation = true;
    }
  });
  if (hasOtherMutation || commands.length !== 1) return false;

  const call = commands[0]!;
  const nestedCalls = calls.filter(candidate => candidate !== call);
  const argumentCalls = nestedCalls.filter(candidate =>
    call.arguments.some(argument => nodeWithin(candidate, argument))
  );
  if (
    containsFunctionLike(callback.body) ||
    argumentCalls.length > 1 ||
    nestedCalls.length - argumentCalls.length > 1 ||
    nestedCalls.some(
      candidate =>
        !isDependencyEffectSupportCall(
          candidate,
          call,
          owner,
          dependencies,
          moduleScopeBindings
        )
    ) ||
    isSubscriptionCall(call)
  ) {
    return false;
  }
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return (
      bindingDeclarationCount(owner, callee.text) === 0 &&
      !/^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)$/.test(callee.text)
    );
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
  if (isCallbackDrivenCall(call)) return false;
  const root = callRootIdentifier(callee);
  return root !== null && !["console", "Math", "Promise"].includes(root);
}

function isDependencyEffectSupportCall(
  call: ts.CallExpression,
  command: ts.CallExpression,
  owner: RuntimeFunctionLike,
  dependencies: ts.ArrayLiteralExpression,
  moduleScopeBindings: ReadonlySet<string>
): boolean {
  if (
    isCallbackDrivenCall(call) ||
    isSubscriptionCall(call)
  ) {
    return false;
  }

  if (
    ts.isPropertyAccessExpression(call.expression) &&
    /^(?:endsWith|includes|indexOf|lastIndexOf|startsWith)$/.test(call.expression.name.text)
  ) {
    return true;
  }

  const root = callRootIdentifier(call.expression);
  if (root === null) return false;
  if (bindingDeclarationCount(owner, root) !== 0) {
    return (
      command.arguments.some(argument => nodeWithin(call, argument)) &&
      isImportedTranslationArgument(call, owner, dependencies)
    );
  }
  return moduleScopeBindings.has(root) || KNOWN_GLOBAL_OBJECTS.has(root);
}

function isDependencyEffectValueConstructor(node: ts.NewExpression): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === "Date";
}

function isImportedTranslationArgument(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  dependencies: ts.ArrayLiteralExpression
): boolean {
  if (!ts.isIdentifier(call.expression) || !owner.body) return false;
  const localName = call.expression.text;
  if (!dependencies.elements.some(element => ts.isIdentifier(element) && element.text === localName)) {
    return false;
  }

  let hookName: string | null = null;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
    if (
      hookName !== null ||
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !ts.isVariableDeclarationList(node.parent) ||
      (node.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return;
    }
    const binding = node.name.elements.find(element => {
      const sourceName = element.propertyName ?? element.name;
      return (
        !element.dotDotDotToken &&
        ts.isIdentifier(element.name) &&
        element.name.text === localName &&
        ts.isIdentifier(sourceName) &&
        sourceName.text === "t"
      );
    });
    if (binding && ts.isIdentifier(node.initializer.expression)) {
      hookName = node.initializer.expression.text;
    }
  });
  return (
    hookName !== null &&
    bindingDeclarationCount(owner, hookName) === 0 &&
    owner.getSourceFile().statements.some(
      statement =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "react-i18next" &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some(
          specifier =>
            specifier.name.text === hookName &&
            (specifier.propertyName?.text ?? specifier.name.text) === "useTranslation"
        )
    )
  );
}

function containsFunctionLike(node: ts.Node): boolean {
  let found = false;
  visit(node, candidate => {
    if (ts.isFunctionLike(candidate)) found = true;
  });
  return found;
}

function isCallbackDrivenCall(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    /^(?:addEventListener|every|filter|find|findIndex|flatMap|forEach|map|reduce|reduceRight|some)$/.test(call.expression.name.text)
  );
}

function isStandaloneEffectCommand(
  call: ts.CallExpression,
  callback: ts.ArrowFunction | ts.FunctionExpression
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
    message: "Keep this React effect; it operates on a committed ref and depends on React post-commit ordering.",
  };
}

function isExactLatestValueRefMirror(
  effect: EffectCandidate,
  useRefBindings: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>
): boolean {
  const { callback, dependencies, owner } = effect;
  const dependency = dependencies?.elements[0] ?? null;
  if (
    !callback ||
    !owner ||
    (dependencies !== null && dependencies.elements.length !== 1)
  ) {
    return false;
  }

  const statementExpression = ts.isBlock(callback.body)
    ? callback.body.statements.length === 1 && ts.isExpressionStatement(callback.body.statements[0]!)
      ? callback.body.statements[0]!.expression
      : null
    : callback.body;
  const assignment = statementExpression && unwrapTransparentExpression(statementExpression);
  if (
    !assignment ||
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return false;
  }
  const target = unwrapTransparentExpression(assignment.left);
  if (
    !ts.isPropertyAccessExpression(target) ||
    target.name.text !== "current" ||
    !ts.isIdentifier(target.expression)
  ) {
    return false;
  }
  const refName = target.expression.text;
  if (
    localBindingNames(callback, null).has(refName) ||
    !localCommittedRefBindings(owner, useRefBindings, reactNamespaces).has(refName)
  ) {
    return false;
  }
  const sourceFile = effect.call.getSourceFile();
  const source = unwrapTransparentExpression(assignment.right);
  return isPureExpression(source) && (
    dependency === null ||
    source.getText(sourceFile) === unwrapTransparentExpression(dependency).getText(sourceFile)
  );
}

function callbackIsCommittedRefIntegration(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  useRefBindings: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>,
  rejectSnapshotCaptures = false
): boolean {
  if (!owner.body) return false;
  const refs = localCommittedRefBindings(owner, useRefBindings, reactNamespaces);
  if (refs.size === 0) return false;

  if (rejectSnapshotCaptures) {
    const ownerLocals = localBindingNames(owner, callback);
    const callbackLocals = localBindingNames(callback, null);
    let capturesSnapshot = false;
    visit(callback.body, node => {
      if (
        !capturesSnapshot &&
        ts.isIdentifier(node) &&
        ownerLocals.has(node.text) &&
        !refs.has(node.text) &&
        !callbackLocals.has(node.text) &&
        !isNonValueIdentifier(node)
      ) {
        capturesSnapshot = true;
      }
    });
    if (capturesSnapshot) return false;
  }

  const readsCommittedRef = (node: ts.Node): boolean => {
    let reads = false;
    visit(node, child => {
      if (
        reads ||
        !ts.isPropertyAccessExpression(child) ||
        child.name.text !== "current" ||
        !ts.isIdentifier(child.expression) ||
        !refs.has(child.expression.text)
      ) {
        return;
      }
      const parent = child.parent;
      const directAssignment = ts.isBinaryExpression(parent) &&
        parent.left === child &&
        isAssignmentOperator(parent.operatorToken.kind);
      const directUpdate = (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        parent.operand === child;
      if (!directAssignment && !directUpdate) reads = true;
    });
    return reads;
  };
  const expressionIsRefIntegration = (expression: ts.Expression): boolean => {
    if (!ts.isCallExpression(expression) || !readsCommittedRef(expression)) return false;
    let safe = true;
    visit(expression, node => {
      if (safe && ts.isCallExpression(node) && !readsCommittedRef(node)) safe = false;
    });
    return safe;
  };
  const statementIsRefIntegration = (statement: ts.Statement): boolean => {
    if (ts.isBlock(statement)) return statement.statements.every(statementIsRefIntegration);
    if (ts.isIfStatement(statement)) {
      return !containsCallExpression(statement.expression) &&
        statementIsRefIntegration(statement.thenStatement) &&
        (!statement.elseStatement || statementIsRefIntegration(statement.elseStatement));
    }
    return ts.isExpressionStatement(statement) && expressionIsRefIntegration(statement.expression);
  };
  if (ts.isBlock(callback.body)) {
    return callback.body.statements.length > 0 && callback.body.statements.every(statementIsRefIntegration);
  }
  return expressionIsRefIntegration(callback.body);
}

function localCommittedRefBindings(
  owner: RuntimeFunctionLike,
  useRefBindings: ReadonlySet<string>,
  reactNamespaces: ReadonlySet<string>
): ReadonlySet<string> {
  const refs = new Set<string>();
  if (!owner.body) return refs;
  visitSkippingNestedRuntimeFunctions(owner.body, node => {
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

function importedHookIsUnshadowed(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike
): boolean {
  const callee = call.expression;
  const root = ts.isIdentifier(callee)
    ? callee
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      ? callee.expression
      : null;
  return root !== null && bindingDeclarationCount(owner, root.text) === 0;
}

function isSetupOnlyMountCandidate(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  moduleScopeBindings: ReadonlySet<string>
): boolean {
  if (!ts.isBlock(callback.body) || callback.body.statements.length === 0) return false;
  if (callbackCallsKnownSetter(callback, stateBySetter)) return false;
  if (
    !callback.body.statements.every(
      statement => ts.isExpressionStatement(statement) && expressionContainsCall(statement.expression)
    )
  ) {
    return false;
  }

  let ownsLifetimeApi = false;
  let callsUnresolvedSetup = false;
  visit(callback.body, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
    if (/^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|addEventListener|subscribe)$/.test(name)) {
      ownsLifetimeApi = true;
    }
    const root = callRootIdentifier(callee);
    if (root && !moduleScopeBindings.has(root) && !KNOWN_GLOBAL_OBJECTS.has(root)) {
      callsUnresolvedSetup = true;
    }
  });
  if (ownsLifetimeApi || callsUnresolvedSetup) return false;

  const ownerLocals = localBindingNames(owner, callback);
  const callbackLocals = localBindingNames(callback, null);
  let capturesOwnerLocal = false;
  visit(callback.body, node => {
    if (
      ts.isIdentifier(node) &&
      ownerLocals.has(node.text) &&
      !callbackLocals.has(node.text) &&
      !isNonValueIdentifier(node)
    ) {
      capturesOwnerLocal = true;
    }
  });
  return !capturesOwnerLocal;
}

const KNOWN_GLOBAL_OBJECTS = new Set(["console", "Date", "Math", "JSON", "Promise", "globalThis"]);


function expressionContainsCall(expression: ts.Expression): boolean {
  let contains = false;
  visit(expression, node => {
    if (ts.isCallExpression(node)) contains = true;
  });
  return contains;
}

function callbackReadsSynchronously(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  name: string
): boolean {
  let reads = false;
  let deferredRead = false;
  let shadowed = callback.parameters.some(
    parameter => ts.isIdentifier(parameter.name) && parameter.name.text === name
  );
  visit(callback.body, node => {
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
    let current: ts.Node | undefined = node.parent;
    while (current && current !== callback) {
      if (
        isRuntimeFunctionLike(current) &&
        current !== callback &&
        !isSynchronousEffectCallback(current)
      ) {
        deferredRead = true;
        return;
      }
      current = current.parent;
    }
  });
  return reads && !deferredRead && !shadowed;
}

function isSynchronousEffectCallback(callback: RuntimeFunctionLike): boolean {
  if (
    callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    callback.asteriskToken
  ) {
    return false;
  }
  let expression: ts.Node = callback;
  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isAsExpression(expression.parent) ||
    ts.isTypeAssertionExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent) ||
    ts.isNonNullExpression(expression.parent)
  ) {
    expression = expression.parent;
  }
  const call = expression.parent;
  if (!ts.isCallExpression(call)) return false;
  if (call.expression === expression) return true;
  return (
    call.arguments.includes(expression as ts.Expression) &&
    ts.isPropertyAccessExpression(call.expression) &&
    /^(?:every|filter|find|findIndex|flatMap|forEach|map|reduce|reduceRight|some)$/.test(
      call.expression.name.text
    )
  );
}

function findPureDerivedSetter(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  dependencies: ts.ArrayLiteralExpression | null,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  usageBySetter: ReadonlyMap<string, StateUsage>
): StateCandidate | null {
  if (!dependencies || dependencies.elements.length === 0) return null;
  const statements = ts.isBlock(callback.body)
    ? callback.body.statements
    : [ts.factory.createExpressionStatement(callback.body)];
  if (statements.length !== 1) return null;
  const statement = statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null;
  const call = statement.expression;
  if (!ts.isIdentifier(call.expression) || !stateBySetter.has(call.expression.text) || call.arguments.length !== 1) {
    return null;
  }
  const state = stateBySetter.get(call.expression.text);
  const usage = usageBySetter.get(call.expression.text);
  if (
    !state ||
    !usage ||
    usage.setterCalls !== 1 ||
    usage.setterReferences !== 1 ||
    usage.escaped ||
    usage.shadowed
  ) {
    return null;
  }
  const value = call.arguments[0];
  if (!value || !isTransparentDerivedValue(value, dependencies)) return null;
  return state;
}

function isTransparentDerivedValue(
  value: ts.Expression,
  dependencies: ts.ArrayLiteralExpression
): boolean {
  if (!isPureExpression(value)) return false;

  const sourceFile = value.getSourceFile();
  const dependencyTexts = new Set(
    dependencies.elements.map(dependency =>
      unwrapTransparentExpression(dependency).getText(sourceFile)
    )
  );
  let hasInput = false;
  let inputsMatch = true;
  const inspect = (node: ts.Node): void => {
    if (!inputsMatch) return;
    if (
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
    ) {
      inputsMatch = false;
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      hasInput = true;
      if (!dependencyTexts.has(unwrapTransparentExpression(node).getText(sourceFile))) {
        inputsMatch = false;
      }
      return;
    }
    if (ts.isIdentifier(node) && !isNonValueIdentifier(node)) {
      hasInput = true;
      if (!dependencyTexts.has(node.text)) inputsMatch = false;
      return;
    }
    node.forEachChild(inspect);
  };
  inspect(value);
  return hasInput && inputsMatch;
}

interface MutationSiteReset {
  sources: readonly StateCandidate[];
  target: StateCandidate;
}

function findMutationSiteReset(
  effect: EffectCandidate,
  stateBySetter: ReadonlyMap<string, StateCandidate>,
  stateByValue: ReadonlyMap<string, StateCandidate>,
  usageBySetter: ReadonlyMap<string, StateUsage>
): MutationSiteReset | null {
  if (
    !effect.callback ||
    !effect.owner ||
    !effect.dependencies ||
    effect.dependencies.elements.length === 0 ||
    isNonProductionHarness(effect.call.getSourceFile().fileName)
  ) {
    return null;
  }
  const sourceNames = effect.dependencies.elements.flatMap(element =>
    ts.isIdentifier(element) ? [element.text] : []
  );
  if (sourceNames.length !== effect.dependencies.elements.length) return null;
  const sources = sourceNames.flatMap(name => {
    const state = stateByValue.get(name);
    return state && state.owner === effect.owner ? [state] : [];
  });
  if (sources.length !== sourceNames.length || new Set(sources).size !== sources.length) return null;

  const setterCall = soleDirectSetterCall(effect.callback, stateBySetter);
  if (!setterCall) return null;
  const target = stateBySetter.get(setterCall.expression.text);
  if (!target || target.owner !== effect.owner || sources.includes(target)) return null;
  const initializer = target.call.arguments[0];
  const reset = setterCall.arguments[0];
  if (!initializer || !reset || !nodesHaveSameText(initializer, reset)) return null;
  const targetUsage = target.setterName ? usageBySetter.get(target.setterName) : undefined;
  if (!targetUsage || targetUsage.setterCalls <= targetUsage.effectWrites) return null;

  for (const source of sources) {
    if (!source.setterName) return null;
    const usage = usageBySetter.get(source.setterName);
    if (
      !usage ||
      usage.shadowed ||
      usage.escaped ||
      usage.effectWrites > 0 ||
      usage.setterReferences === 0 ||
      !allSetterReferencesAreEventBoundaries(source)
    ) {
      return null;
    }
  }
  return { sources, target };
}

function soleDirectSetterCall(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): (ts.CallExpression & { expression: ts.Identifier }) | null {
  const expression = ts.isBlock(callback.body)
    ? (() => {
        const statement = callback.body.statements[0];
        return callback.body.statements.length === 1 && statement && ts.isExpressionStatement(statement)
          ? statement.expression
          : null;
      })()
    : callback.body;
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !stateBySetter.has(expression.expression.text) ||
    expression.arguments.length !== 1
  ) {
    return null;
  }
  return expression as ts.CallExpression & { expression: ts.Identifier };
}

function nodesHaveSameText(left: ts.Node, right: ts.Node): boolean {
  return left.getText(left.getSourceFile()) === right.getText(right.getSourceFile());
}

function allSetterReferencesAreEventBoundaries(state: StateCandidate): boolean {
  if (!state.setterName) return false;
  let references = 0;
  let valid = true;
  visit(state.owner.body, node => {
    if (!valid || !ts.isIdentifier(node) || node.text !== state.setterName) return;
    if (node.parent === state.call.parent || isDeclarationName(node)) return;
    references += 1;
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    if (!attribute) {
      valid = false;
      return;
    }
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      const callback = nearestNestedFunction(node, state.owner);
      if (
        !jsxAttributeHasProvenEventContract(attribute) ||
        !callback ||
        !isInsideJsxAttribute(callback, attribute)
      ) {
        valid = false;
      }
      return;
    }
    if (isDirectJsxAttributeExpression(attribute, node)) {
      if (!jsxAttributeHasProvenEventContract(attribute)) valid = false;
      return;
    }
    const property = findAncestorUntil(node, ts.isPropertyAssignment, attribute);
    if (
      !property ||
      property.initializer !== node ||
      !isValueTransitionProp(property.name.getText())
    ) {
      valid = false;
    }
  });
  return valid && references > 0;
}

function jsxAttributeHasProvenEventContract(attribute: ts.JsxAttribute): boolean {
  if (isValueTransitionProp(attribute.name.getText())) return true;
  const opening = attribute.parent.parent;
  return (
    (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
    /^[a-z]/.test(opening.tagName.getText()) &&
    /^on[A-Z]/.test(attribute.name.getText())
  );
}

export function callbackHasCleanup(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
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
    statement => ts.isReturnStatement(statement) && statement.expression !== undefined
  );
}

function isSubscriptionCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return /^(?:subscribe|listen|observe|register)/.test(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    return /^(?:subscribe|listen|observe|register|addListener|on[A-Z])/.test(callee.name.text);
  }
  return false;
}

function isCleanupOnly(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const expression = ts.isBlock(callback.body)
    ? callback.body.statements.length === 1 && ts.isReturnStatement(callback.body.statements[0]!)
      ? callback.body.statements[0]!.expression
      : undefined
    : callback.body;
  if (!expression) return false;
  const cleanup = unwrapTransparentExpression(expression);
  return ts.isArrowFunction(cleanup) || ts.isFunctionExpression(cleanup) || ts.isIdentifier(cleanup);
}

function callbackCallsKnownSetter(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  stateBySetter: ReadonlyMap<string, StateCandidate>
): boolean {
  let callsSetter = false;
  visit(callback.body, node => {
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
