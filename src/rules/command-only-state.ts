import ts from "typescript";

import {
  bindingDeclarationCount,
  callRootIdentifier,
  collectBindingNames,
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isEvaluationInert,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import type { StateCandidate } from "../analyze-source.js";
import {
  findAncestorUntil,
  isRuntimeFunctionLike,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedFunctions,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import {
  isInsideJsxEventCallback,
  isJsxNode,
  isSynchronousRenderCallback,
  setterCallUsesPreviousValue,
} from "./state-proofs.js";
import type { RuntimeFunctionLike } from "../ast.js";

export interface CommandOnlyCallableReads {
  effectSites: readonly ts.Identifier[];
  renderSites: readonly ts.Identifier[];
}

interface CommandOnlyUsage {
  setterCallNodes: readonly ts.CallExpression[];
  setterUsesPreviousValue: boolean;
}

export function refWouldChangeCommandSnapshot(
  state: StateCandidate,
  usage: CommandOnlyUsage,
  readsAreEventRooted: boolean,
): boolean {
  const writes = usage.setterCallNodes.map((call) => ({
    call,
    regions: commandRuntimeRegions(call, state.owner),
  }));
  if (writes.every((write) => write.regions.length === 0)) {
    return false;
  }

  let shared = false;
  visit(state.owner.body, (node) => {
    if (
      shared ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      node.parent === state.call.parent ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const readRegions = commandRuntimeRegions(node, state.owner);
    shared = writes.some((write) => {
      const commonRegions = readRegions.filter((region) => write.regions.includes(region));
      if (commonRegions.length === 0) {
        return false;
      }
      const readBeforeWrite =
        nodeWithin(node, write.call) || node.getStart() < write.call.getStart();
      return !readBeforeWrite || !readsAreEventRooted;
    });
  });
  return shared;
}

function commandRuntimeRegions(node: ts.Node, owner: RuntimeFunctionLike): RuntimeFunctionLike[] {
  const regions: RuntimeFunctionLike[] = [];
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (isRuntimeFunctionLike(current)) {
      regions.push(current);
    }
  }
  return regions;
}

export function collectCommandOnlyCallableReads(
  state: StateCandidate,
  effectNodes: ReadonlySet<ts.Node>,
): CommandOnlyCallableReads {
  const names = localStateReadCallableNames(state);
  return {
    effectSites: localCallableEffectSites(state, names, effectNodes),
    renderSites: localCallableRenderSites(state, names),
  };
}

export function functionalUpdaterPrecedesSnapshotRead(
  state: StateCandidate,
  usage: CommandOnlyUsage,
  nearestMutationFunction: (node: ts.Node, owner: RuntimeFunctionLike) => RuntimeFunctionLike,
): boolean {
  if (!usage.setterUsesPreviousValue) {
    return false;
  }
  return usage.setterCallNodes.some((call) => {
    if (!setterCallUsesPreviousValue(call)) {
      return false;
    }
    const region = nearestMutationFunction(call, state.owner);
    if (!region.body) {
      return true;
    }
    let readAfterWrite = false;
    visitSkippingNestedRuntimeFunctions(region.body, (node) => {
      if (
        ts.isIdentifier(node) &&
        node.text === state.valueName &&
        node.getStart() > call.end &&
        !isDeclarationName(node) &&
        !isNonValueIdentifier(node)
      ) {
        readAfterWrite = true;
      }
    });
    return readAfterWrite;
  });
}

export function functionalCounterUpdaterPreservesSnapshot(
  state: StateCandidate,
  usage: CommandOnlyUsage,
  nearestMutationFunction: (node: ts.Node, owner: RuntimeFunctionLike) => RuntimeFunctionLike,
): boolean {
  const call = usage.setterCallNodes[0];
  const updater = call?.arguments[0];
  if (
    usage.setterCallNodes.length !== 1 ||
    !call ||
    !updater ||
    !ts.isArrowFunction(updater) ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name) ||
    ts.isBlock(updater.body)
  ) {
    return false;
  }
  const expression = updater.body;
  const parameter = updater.parameters[0]!.name.text;
  if (
    !ts.isBinaryExpression(expression) ||
    ![ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(expression.operatorToken.kind) ||
    !ts.isIdentifier(expression.left) ||
    expression.left.text !== parameter ||
    !isEvaluationInert(expression.right)
  ) {
    return false;
  }

  const region = nearestMutationFunction(call, state.owner);
  if (!region.body) {
    return false;
  }
  let readsAfter = 0;
  let unsafe = false;
  visitSkippingNestedRuntimeFunctions(region.body, (node) => {
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
      unsafe = true;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      if (node.getStart() <= call.end) {
        unsafe = true;
      } else {
        readsAfter += 1;
      }
    }
  });
  return !unsafe && readsAfter > 0;
}

export function stateReadCallbackEscapesThroughUnknownHook(
  state: StateCandidate,
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  callbackPropertyIsDeferred?: (
    hookName: string,
    argumentIndex: number,
    property: string,
  ) => boolean,
): boolean {
  let escaped = false;
  visit(state.owner.body, (node) => {
    if (
      escaped ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node) ||
      node.parent === state.call.parent
    ) {
      return;
    }
    for (
      let current: ts.Node | undefined = node.parent;
      current && current !== state.owner;
      current = current.parent
    ) {
      if (
        !ts.isCallExpression(current) ||
        !current.arguments.some((argument) => nodeWithin(node, argument))
      ) {
        continue;
      }
      const hookName = ts.isIdentifier(current.expression)
        ? current.expression.text
        : ts.isPropertyAccessExpression(current.expression)
          ? current.expression.name.text
          : null;
      if (
        hookName &&
        /^use[A-Z0-9]/u.test(hookName) &&
        !["useCallback", "useMemo", "useEffect", "useLayoutEffect", "useInsertionEffect"].includes(
          hookName,
        ) &&
        bindingDeclarationCount(state.owner, hookName) === 0
      ) {
        const argumentIndex = current.arguments.findIndex((argument) => nodeWithin(node, argument));
        if (argumentIndex !== -1 && deferredCallbackHooks.get(hookName)?.has(argumentIndex)) {
          continue;
        }
        const property =
          argumentIndex === -1
            ? null
            : objectCallbackProperty(current.arguments[argumentIndex]!, node);
        if (property && callbackPropertyIsDeferred?.(hookName, argumentIndex, property) === true) {
          continue;
        }
        escaped = true;
        return;
      }
    }
  });
  return escaped;
}

function objectCallbackProperty(argument: ts.Expression, node: ts.Node): string | null {
  const object = unwrapTransparentExpression(argument);
  if (!ts.isObjectLiteralExpression(object)) {
    return null;
  }
  const property = findAncestorUntil(node, isObjectCallbackMember, object);
  if (
    !property ||
    property.parent !== object ||
    (ts.isPropertyAssignment(property) && !nodeWithin(node, property.initializer)) ||
    (ts.isMethodDeclaration(property) && !property.body)
  ) {
    return null;
  }
  return ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
    ? property.name.text
    : null;
}

function isObjectCallbackMember(
  node: ts.Node,
): node is ts.MethodDeclaration | ts.PropertyAssignment {
  return ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node);
}

export function statePublishesReadOnlyGetter(state: StateCandidate): boolean {
  const getterNames = [...localStateReadCallableNames(state)].filter((name) => {
    const callback = localCallableByName(state.owner, name);
    if (!callback?.body) {
      return false;
    }
    return (
      !ts.isBlock(callback.body) ||
      (callback.body.statements.length === 1 && ts.isReturnStatement(callback.body.statements[0]!))
    );
  });
  return getterNames.some((name) => localBindingReachesReturnedJsxValue(state.owner, name));
}

export function stateFeedsReturnedSwitchCommand(state: StateCandidate): boolean {
  if (bindingDeclarationCount(state.owner, state.valueName) !== 1) {
    return false;
  }
  const reads: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      reads.push(node);
    }
  });
  const read = reads.length === 1 ? reads[0]! : null;
  const callback = read ? nearestNestedFunction(read, state.owner) : null;
  if (
    !read ||
    !callback ||
    !ts.isArrowFunction(callback) ||
    !ts.isBlock(callback.body) ||
    callback.body.statements.length !== 1 ||
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return false;
  }
  const statement = callback.body.statements[0]!;
  if (
    !ts.isSwitchStatement(statement) ||
    unwrapTransparentExpression(statement.expression) !== read ||
    statement.caseBlock.clauses.length < 2 ||
    !statement.caseBlock.clauses.some(ts.isDefaultClause) ||
    !statement.caseBlock.clauses.every((clause) => switchClauseIsCommandOnly(clause, state))
  ) {
    return false;
  }
  const name = localCallableName(callback);
  if (!name || bindingDeclarationCount(state.owner, name) !== 1) {
    return false;
  }
  const references: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references.length === 1 && isDirectReturnedObjectMember(references[0]!, state.owner);
}

function switchClauseIsCommandOnly(clause: ts.CaseOrDefaultClause, state: StateCandidate): boolean {
  let commands = 0;
  for (const statement of clause.statements) {
    if (ts.isBreakStatement(statement)) {
      continue;
    }
    if (!isImportedCommandStatement(statement, state)) {
      return ts.isDefaultClause(clause) && guardedFallbackIsCommandOnly(clause, state);
    }
    commands += 1;
  }
  return commands === 1;
}

function guardedFallbackIsCommandOnly(clause: ts.DefaultClause, state: StateCandidate): boolean {
  const [guard, fallback, exit, ...extra] = clause.statements;
  if (
    extra.length > 0 ||
    !guard ||
    !ts.isIfStatement(guard) ||
    guard.elseStatement ||
    !fallback ||
    !isImportedCommandStatement(fallback, state) ||
    !exit ||
    !ts.isBreakStatement(exit)
  ) {
    return false;
  }
  const condition = unwrapTransparentExpression(guard.expression);
  if (!ts.isIdentifier(condition) || !ownerParameterNames(state.owner).has(condition.text)) {
    return false;
  }
  const branch = guard.thenStatement;
  return (
    ts.isBlock(branch) &&
    branch.statements.length === 2 &&
    isImportedCommandStatement(branch.statements[0]!, state) &&
    ts.isReturnStatement(branch.statements[1]!) &&
    branch.statements[1]!.expression === undefined
  );
}

function isImportedCommandStatement(statement: ts.Statement, state: StateCandidate): boolean {
  if (!ts.isExpressionStatement(statement)) {
    return false;
  }
  const expression = unwrapTransparentExpression(statement.expression);
  return ts.isCallExpression(expression) && callRootIsImported(expression, state);
}

function ownerParameterNames(owner: RuntimeFunctionLike): ReadonlySet<string> {
  const names = new Set<string>();
  for (const parameter of owner.parameters) {
    collectBindingNames(parameter.name, names);
  }
  return names;
}

function callRootIsImported(call: ts.CallExpression, state: StateCandidate): boolean {
  const root = callRootIdentifier(call.expression);
  if (!root || bindingDeclarationCount(state.owner, root) !== 0) {
    return false;
  }
  return state.call.getSourceFile().statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) {
      return false;
    }
    const clause = statement.importClause;
    if (clause?.name?.text === root) {
      return true;
    }
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      return bindings.name.text === root;
    }
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => element.name.text === root)
    );
  });
}

function localCallableName(callback: ts.ArrowFunction): string | null {
  const declaration = callback.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === callback &&
    ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : null;
}

function isDirectReturnedObjectMember(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  const property = reference.parent;
  if (
    !ts.isShorthandPropertyAssignment(property) &&
    !(ts.isPropertyAssignment(property) && property.initializer === reference)
  ) {
    return false;
  }
  const object = property.parent;
  const returned = ts.isObjectLiteralExpression(object) ? object.parent : null;
  return (
    returned !== null &&
    ts.isReturnStatement(returned) &&
    returned.expression === object &&
    nearestNestedFunction(reference, owner) === null
  );
}

function localStateReadCallableNames(state: StateCandidate): ReadonlySet<string> {
  const names = new Set<string>();
  visit(state.owner.body, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      functionReadsState(node, state) &&
      bindingDeclarationCount(state.owner, node.name.text) === 1
    ) {
      names.add(node.name.text);
      return;
    }
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }
    const callback = localCallableCallback(node.initializer);
    if (
      callback &&
      functionReadsState(callback, state) &&
      bindingDeclarationCount(state.owner, node.name.text) === 1
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}

function localCallableRenderSites(
  state: StateCandidate,
  names: ReadonlySet<string>,
): readonly ts.Identifier[] {
  if (names.size === 0) {
    return [];
  }
  const sites: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (!ts.isIdentifier(node) || !names.has(node.text)) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    if (
      attribute &&
      isDirectJsxAttributeExpression(attribute, node) &&
      jsxPropMayRenderCallable(attribute.name.getText())
    ) {
      sites.push(node);
      return;
    }
    if (
      !ts.isCallExpression(node.parent) ||
      node.parent.expression !== node ||
      isInsideJsxEventCallback(node, state.owner)
    ) {
      return;
    }
    const callback = nearestNestedFunction(node, state.owner);
    if (
      findAncestorUntil(node.parent, isJsxNode, state.owner) !== null ||
      callback === null ||
      isSynchronousRenderCallback(callback)
    ) {
      sites.push(node);
    }
  });
  return sites;
}

function localCallableEffectSites(
  state: StateCandidate,
  names: ReadonlySet<string>,
  effectNodes: ReadonlySet<ts.Node>,
): readonly ts.Identifier[] {
  if (names.size === 0 || effectNodes.size === 0) {
    return [];
  }
  const sites: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (ts.isIdentifier(node) && names.has(node.text) && hasAncestorInSet(node, effectNodes)) {
      sites.push(node);
    }
  });
  return sites;
}

function jsxPropMayRenderCallable(name: string): boolean {
  return (
    name === "children" ||
    name === "component" ||
    name === "renderer" ||
    /^render(?:[A-Z]|$)/u.test(name) ||
    /(?:Renderer|Component)$/u.test(name)
  );
}

function localCallableCallback(
  initializer: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer;
  }
  if (
    ts.isCallExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "useCallback"
  ) {
    const callback = initializer.arguments[0];
    return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ? callback
      : null;
  }
  return null;
}

function functionReadsState(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  state: StateCandidate,
): boolean {
  let reads = false;
  if (!callback.body) {
    return false;
  }
  visitSkippingNestedFunctions(callback.body, callback, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      reads = true;
    }
  });
  return reads;
}

function localCallableByName(owner: RuntimeFunctionLike, name: string): RuntimeFunctionLike | null {
  let callback: RuntimeFunctionLike | null = null;
  visit(owner.body, (node) => {
    if (callback) {
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      callback = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      callback = localCallableCallback(node.initializer);
    }
  });
  return callback;
}

function localBindingReachesReturnedJsxValue(owner: RuntimeFunctionLike, name: string): boolean {
  let published = false;
  visit(owner.body, (node) => {
    if (
      published ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (
      findAncestorUntil(node, ts.isReturnStatement, owner) &&
      !findAncestorUntil(node, isJsxNode, owner)
    ) {
      published = true;
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, owner);
    if (isContextValueAttribute(attribute)) {
      published = true;
      return;
    }
    const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
    if (!declaration || !ts.isIdentifier(declaration.name)) {
      return;
    }
    const valueName = declaration.name.text;
    visit(owner.body, (reference) => {
      if (
        published ||
        !ts.isIdentifier(reference) ||
        reference.text !== valueName ||
        reference === declaration.name ||
        isDeclarationName(reference) ||
        isNonValueIdentifier(reference)
      ) {
        return;
      }
      if (isContextValueAttribute(findAncestorUntil(reference, ts.isJsxAttribute, owner))) {
        published = true;
      }
    });
  });
  return published;
}

function isContextValueAttribute(attribute: ts.JsxAttribute | null): boolean {
  return (
    attribute?.name.getText() === "value" &&
    jsxTargetName(attribute)?.endsWith(".Provider") === true
  );
}

function jsxTargetName(attribute: ts.JsxAttribute): string | null {
  const opening = attribute.parent;
  if (!ts.isJsxAttributes(opening)) {
    return null;
  }
  const element = opening.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return null;
  }
  return element.tagName.getText();
}

function hasAncestorInSet(node: ts.Node, ancestors: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ancestors.has(current)) {
      return true;
    }
  }
  return false;
}
