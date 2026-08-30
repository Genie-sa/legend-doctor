import ts from "typescript";

import {
  bindingDeclarationCount,
  containsElementAccess,
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
  rootIdentifier,
  staticPathHasBinding,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../ast.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { isImportedHookCall } from "../imports.js";
import type { HookImports } from "../imports.js";
import type { LegendPracticeFinding } from "../types.js";
import { propIsPrimitiveValueConsumer } from "./child-contract.js";
import type { ChildContractResolver } from "./child-contract.js";
import {
  bindingContainsName,
  callbackIsEventRooted,
  hasUnstableSubtreeLifetime,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "./state-proofs.js";

const MIN_LEAF_OWNER_ELEMENTS = 12,
  MAX_LEAF_OWNER_SHARE = 0.4;

export const RESERVED_OBSERVABLE_MEMBERS = new Set([
  "assign",
  "delete",
  "fire",
  "get",
  "getPrevious",
  "length",
  "onChange",
  "peek",
  "set",
  "size",
  "subscribe",
  "toggle",
]);

export function findObservableReadPractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  observableKeys: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  childContracts: ChildContractResolver | null = null,
): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      const directInput = directUseValueInput(node, imports, observableBindings);
      if (directInput) {
        findings.push(directUseValueFinding(node, directInput, sourceFile, fileName));
      }
      const snapshot = nonTrackingSnapshotObservable(
        node,
        imports,
        observableBindings,
        childContracts,
      );
      if (snapshot) {
        findings.push(nonTrackingSnapshotFinding(node, snapshot, sourceFile, fileName));
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const finding =
        moveUseValueIntoChildFinding(
          node,
          imports,
          observableBindings,
          childContracts,
          sourceFile,
          fileName,
        ) ??
        moveUseValueDownFinding(node, imports, observableBindings, sourceFile, fileName) ??
        narrowUseValueFinding(
          node,
          imports,
          observableBindings,
          observableKeys,
          sourceFile,
          fileName,
        );
      if (finding) {
        findings.push(finding);
      }
    }
  });
  return findings;
}

function moveUseValueIntoChildFinding(
  declaration: ts.VariableDeclaration,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  childContracts: ChildContractResolver | null,
  sourceFile: ts.SourceFile,
  fileName: string,
): LegendPracticeFinding | null {
  const call = declaration.initializer;
  if (
    !childContracts ||
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, imports) ||
    !ts.isIdentifier(declaration.name)
  ) {
    return null;
  }
  const observable = provenObservablePath(call.arguments[0]!, observableBindings),
    owner = findAncestor(declaration, isRuntimeFunctionLike),
    localName = declaration.name.text;
  if (
    !observable ||
    !owner?.body ||
    bindingDeclarationCount(owner, localName) !== 1 ||
    hasAncestorUseValueSubscription(owner, call, imports, observableBindings) ||
    hasOtherGetReadOfPath(owner, observable, observableBindings)
  ) {
    return null;
  }

  let reference: ts.Identifier | null = null,
    unsafe = false;
  visit(owner.body, (node) => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      node.text !== localName ||
      node === declaration.name ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (isDeclarationName(node) || reference !== null) {
      unsafe = true;
      return;
    }
    reference = node;
  });
  if (unsafe || !reference) {
    return null;
  }

  const transport = directJsxPropTransport(reference);
  if (!transport || !isInsideOwnerReturn(transport.subtree, owner)) {
    return null;
  }
  if (hasUnstableSubtreeLifetime(transport.subtree, owner)) {
    return null;
  }
  const child = childContracts.resolveComponent(transport.component);
  if (!child || !propIsPrimitiveValueConsumer(child, transport.prop)) {
    return null;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      declaration.getStart(sourceFile),
    ),
    observablePath = observable.getText(sourceFile);
  return {
    action: "move-use-value-into-child",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `the ${localName} binding is referenced once, as the direct \`${transport.prop}\` prop of source-resolved \`${transport.component}\``,
      "the child is not React-wrapped, declares that prop as a primitive value, and consumes it",
      "the child call site is unkeyed, unrepeated, unconditional, and owned by the component's only render return",
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Move \`useValue(${observablePath})\` out of this owner: pass \`${observablePath}\` to \`${transport.component}\` as an observable prop and subscribe inside the child, using the resulting primitive for \`${transport.prop}\`. Updates will rerender the existing child without rerunning this owner.`,
    practice: "reactivity",
  };
}

function hasOtherGetReadOfPath(
  owner: RuntimeFunctionLike,
  observable: ts.Expression,
  observableBindings: ReadonlySet<string>,
): boolean {
  if (!owner.body) {
    return true;
  }
  const currentPath = staticPropertyPath(observable);
  if (!currentPath) {
    return true;
  }
  let overlap = false;
  visit(owner.body, (node) => {
    if (overlap || !ts.isCallExpression(node)) {
      return;
    }
    const receiver = directGetReceiver(node),
      other = receiver && provenObservablePath(receiver, observableBindings),
      otherPath = other && staticPropertyPath(other);
    if (!otherPath) {
      return;
    }
    const shared = Math.min(currentPath.length, otherPath.length);
    overlap = currentPath.slice(0, shared).every((part, index) => part === otherPath[index]);
  });
  return overlap;
}

interface DirectJsxPropTransport {
  component: string;
  prop: string;
  subtree: ts.JsxElement | ts.JsxSelfClosingElement;
}

function directJsxPropTransport(reference: ts.Identifier): DirectJsxPropTransport | null {
  let expression: ts.Expression = reference;
  while (
    (ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  const container = expression.parent;
  if (
    !ts.isJsxExpression(container) ||
    container.expression !== expression ||
    !ts.isJsxAttribute(container.parent)
  ) {
    return null;
  }
  const attribute = container.parent,
    opening = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return null;
  }
  const prop = attribute.name.getText();
  if (prop === "children" || prop === "key" || prop === "ref" || /^on[A-Z]/.test(prop)) {
    return null;
  }
  return {
    component: opening.tagName.getText(),
    prop,
    subtree: ts.isJsxOpeningElement(opening) ? opening.parent : opening,
  };
}

function moveUseValueDownFinding(
  declaration: ts.VariableDeclaration,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
  fileName: string,
): LegendPracticeFinding | null {
  const call = declaration.initializer;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, imports) ||
    !ts.isIdentifier(declaration.name) ||
    !provenObservablePath(call.arguments[0]!, observableBindings)
  ) {
    return null;
  }
  const owner = findAncestor(declaration, isRuntimeFunctionLike),
    localName = declaration.name.text;
  if (
    !owner?.body ||
    bindingDeclarationCount(owner, localName) !== 1 ||
    jsxElementCount(owner) < MIN_LEAF_OWNER_ELEMENTS ||
    hasAncestorUseValueSubscription(owner, call, imports, observableBindings)
  ) {
    return null;
  }

  const references: ts.Identifier[] = [];
  let unsafe = false;
  visit(owner.body, (node) => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      node.text !== localName ||
      node === declaration.name ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (
      isDeclarationName(node) ||
      !isWholeValueProjection(node) ||
      !isSafeJsxProjectionReference(node, owner) ||
      nearestRepeatedRenderCall(node, owner)
    ) {
      unsafe = true;
      return;
    }
    references.push(node);
  });
  if (unsafe || references.length === 0) {
    return null;
  }

  const leaf = lowestCommonJsxSubtree(references, owner),
    ownerElements = jsxElementCount(owner),
    conditionalSlot = stableConditionalJsxSlot(references, owner, imports),
    stableLeaf = conditionalSlot || !leaf || hasUnstableSubtreeLifetime(leaf, owner) ? null : leaf;
  if (!stableLeaf && !conditionalSlot) {
    return null;
  }
  const leafElements = stableLeaf
    ? jsxElementCountIn(stableLeaf)
    : jsxElementCountIn(conditionalSlot!);
  if (leafElements / ownerElements > MAX_LEAF_OWNER_SHARE) {
    return null;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      declaration.getStart(sourceFile),
    ),
    target = stableLeaf ?? conditionalSlot!,
    leafLine = sourceFile.getLineAndCharacterOfPosition(target.getStart(sourceFile)).line + 1,
    leafLabel = stableLeaf
      ? ts.isJsxFragment(stableLeaf)
        ? "fragment"
        : `<${ts.isJsxElement(stableLeaf) ? stableLeaf.openingElement.tagName.getText(sourceFile) : stableLeaf.tagName.getText(sourceFile)}>`
      : "complete conditional JSX slot",
    observable = call.arguments[0]!.getText(sourceFile),
    readEvidence = stableLeaf
      ? `${references.length} render read${references.length === 1 ? "" : "s"} of ${localName} occur${references.length === 1 ? "s" : ""} only inside the stable ${leafLabel} leaf at line ${leafLine}`
      : `${references.length} render read${references.length === 1 ? "" : "s"} of ${localName} occur${references.length === 1 ? "s" : ""} only inside the complete conditional JSX slot at line ${leafLine}`,
    lifetimeEvidence = stableLeaf
      ? `that leaf contains ${leafElements} of the owner's ${ownerElements} JSX elements and is not conditional, keyed, repeated, or split across returns`
      : `replacing the complete conditional JSX slot with one always-mounted wrapper preserves the subscription lifetime and the conditional child's mount behavior`,
    wrapper = stableLeaf ? "a stable wrapper around" : "an always-mounted wrapper for",
    props = stableLeaf ? "the leaf's other inputs" : "non-observable gate values";
  return {
    action: "move-use-value-down",
    confidence: "certain",
    disposition: "change",
    evidence: [readEvidence, lifetimeEvidence],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Move \`useValue(${observable})\` for \`${localName}\` into ${wrapper} the ${leafLabel} at line ${leafLine}; keep observable ownership where it is and pass ${props} as ordinary props so updates rerender ${leafElements} JSX element${leafElements === 1 ? "" : "s"} instead of the ${ownerElements}-element owner.`,
    practice: "reactivity",
  };
}

function hasAncestorUseValueSubscription(
  owner: RuntimeFunctionLike,
  currentCall: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): boolean {
  const currentObservable = provenObservablePath(currentCall.arguments[0]!, observableBindings),
    currentPath = currentObservable && staticPropertyPath(currentObservable);
  if (!owner.body || !currentPath) {
    return true;
  }

  let overlap = false;
  visit(owner.body, (node) => {
    if (
      overlap ||
      !ts.isCallExpression(node) ||
      node === currentCall ||
      findAncestor(node, isRuntimeFunctionLike) !== owner ||
      !isUseValueCall(node, imports)
    ) {
      return;
    }
    overlap = trackedUseValuePaths(node, imports, observableBindings).some((otherObservable) => {
      const otherPath = staticPropertyPath(otherObservable);
      return (
        !!otherPath &&
        otherPath.length <= currentPath.length &&
        otherPath.every((part, index) => part === currentPath[index])
      );
    });
  });
  return overlap;
}

function trackedUseValuePaths(
  call: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): readonly ts.Expression[] {
  const direct = call.arguments[0] && provenObservablePath(call.arguments[0], observableBindings),
    simpleInput = directUseValueInput(call, imports, observableBindings)?.observable;
  if (direct || simpleInput) {
    return [direct ?? simpleInput!];
  }

  const selector = call.arguments[0];
  if (!selector || (!ts.isArrowFunction(selector) && !ts.isFunctionExpression(selector))) {
    return [];
  }
  const paths: ts.Expression[] = [];
  visit(selector.body, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const receiver = directGetReceiver(node),
      observable = receiver && provenObservablePath(receiver, observableBindings);
    if (observable) {
      paths.push(observable);
    }
  });
  return paths;
}

function stableConditionalJsxSlot(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.Expression | null {
  const slots = references.map((reference) => enclosingConditionalJsxExpression(reference, owner)),
    slot = slots[0];
  if (!slot || slots.some((candidate) => candidate !== slot) || !slot.expression) {
    return null;
  }

  const expression = unwrapTransparentExpression(slot.expression);
  if (!isConditionalRenderExpression(expression)) {
    return null;
  }
  if (!hasRenderOwnedConditionalInputs(expression, references[0]!.text, owner, imports)) {
    return null;
  }
  if (!ts.isJsxElement(slot.parent) && !ts.isJsxFragment(slot.parent)) {
    return null;
  }
  if (!isInsideOwnerReturn(slot, owner) || hasUnstableSubtreeLifetime(slot.parent, owner)) {
    return null;
  }

  let hasKey = false;
  visit(expression, (node) => {
    if (
      !hasKey &&
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties.some(
        (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
      )
    ) {
      hasKey = true;
    }
  });
  return hasKey ? null : expression;
}

function enclosingConditionalJsxExpression(
  node: ts.Node,
  boundary: ts.Node,
): ts.JsxExpression | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      ts.isJsxExpression(current) &&
      current.expression &&
      isConditionalRenderExpression(unwrapTransparentExpression(current.expression)) &&
      (ts.isJsxElement(current.parent) || ts.isJsxFragment(current.parent))
    ) {
      return current;
    }
  }
  return null;
}

function isConditionalRenderExpression(expression: ts.Expression): boolean {
  return (
    ts.isConditionalExpression(expression) ||
    (ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(expression.operatorToken.kind))
  );
}

function hasRenderOwnedConditionalInputs(
  expression: ts.Expression,
  observableValue: string,
  owner: RuntimeFunctionLike,
  imports: HookImports,
  resolving: ReadonlySet<string> = new Set(),
): boolean {
  let safe = true;
  const walk = (node: ts.Node): void => {
    if (
      !safe ||
      ts.isJsxElement(node) ||
      ts.isJsxFragment(node) ||
      ts.isJsxSelfClosingElement(node)
    ) {
      return;
    }
    if (
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind))
    ) {
      safe = false;
      return;
    }
    if (
      ts.isIdentifier(node) &&
      !isNonValueIdentifier(node) &&
      !conditionalIdentifierIsRenderOwned(node.text, observableValue, owner, imports, resolving)
    ) {
      safe = false;
      return;
    }
    node.forEachChild(walk);
  };
  walk(expression);
  return safe;
}

function conditionalIdentifierIsRenderOwned(
  name: string,
  observableValue: string,
  owner: RuntimeFunctionLike,
  imports: HookImports,
  resolving: ReadonlySet<string>,
): boolean {
  if (name === observableValue || name === "undefined") {
    return true;
  }
  if (
    owner.parameters.some((parameter) => bindingContainsName(parameter.name, name)) &&
    bindingDeclarationCount(owner, name) === 1
  ) {
    return true;
  }
  if (!owner.body || resolving.has(name)) {
    return false;
  }

  const declarations: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isVariableDeclaration(node) && bindingContainsName(node.name, name)) {
      declarations.push(node);
    }
  });
  const declaration = declarations.length === 1 ? declarations[0]! : null;
  if (!declaration?.initializer || !ts.isVariableDeclarationList(declaration.parent)) {
    return false;
  }

  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (
    ts.isArrayBindingPattern(declaration.name) &&
    declaration.name.elements[0] &&
    !ts.isOmittedExpression(declaration.name.elements[0]) &&
    bindingContainsName(declaration.name.elements[0].name, name) &&
    ts.isCallExpression(initializer) &&
    isImportedHookCall(initializer, imports.useState, imports.reactNamespaces, "useState")
  ) {
    return true;
  }
  if (
    ts.isIdentifier(declaration.name) &&
    ts.isCallExpression(initializer) &&
    isUseValueCall(initializer, imports)
  ) {
    return true;
  }
  if (!ts.isIdentifier(declaration.name) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
    return false;
  }
  return hasRenderOwnedConditionalInputs(
    initializer,
    observableValue,
    owner,
    imports,
    new Set([...resolving, name]),
  );
}

function isInsideOwnerReturn(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  const { body } = owner;
  if (!body) {
    return false;
  }
  if (!ts.isBlock(body)) {
    return node.pos >= body.pos && node.end <= body.end;
  }
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (ts.isReturnStatement(current)) {
      return true;
    }
  }
  return false;
}

function isWholeValueProjection(reference: ts.Identifier): boolean {
  let current: ts.Expression = reference;
  while (
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return !(
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  );
}

interface NonTrackingSnapshot {
  observable: ts.Expression;
  source: "observable-listener" | "react-or-event" | "source-proven-effect";
}

function nonTrackingSnapshotObservable(
  call: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  childContracts: ChildContractResolver | null,
): NonTrackingSnapshot | null {
  if (
    call.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "get"
  ) {
    return null;
  }
  const observable = provenObservablePath(call.expression.expression, observableBindings);
  if (!observable) {
    return null;
  }
  const callback = findAncestor(call, isRuntimeFunctionLike);
  if (!callback) {
    return null;
  }
  const source = provenNonTrackingCallbackSource(
    callback,
    imports,
    observableBindings,
    childContracts,
  );
  return source ? { observable, source } : null;
}

function provenNonTrackingCallbackSource(
  callback: RuntimeFunctionLike,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  childContracts: ChildContractResolver | null,
): NonTrackingSnapshot["source"] | null {
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return null;
  }
  if (
    isDirectHookCallback(callback, imports.useEffect, imports.reactNamespaces, "useEffect") ||
    isDirectHookCallback(
      callback,
      imports.useInsertionEffect,
      imports.reactNamespaces,
      "useInsertionEffect",
    ) ||
    isDirectHookCallback(
      callback,
      imports.useLayoutEffect,
      imports.reactNamespaces,
      "useLayoutEffect",
    ) ||
    isDirectHookCallback(callback, imports.useState, imports.reactNamespaces, "useState") ||
    isDirectHookCallback(callback, imports.useMount, imports.legendReactNamespaces, "useMount") ||
    isDirectHookCallback(callback, imports.useUnmount, imports.legendReactNamespaces, "useUnmount")
  ) {
    return "react-or-event";
  }
  if (isDirectObservableOnChangeCallback(callback, observableBindings)) {
    return "observable-listener";
  }

  const owner = findAncestor(callback, isRuntimeFunctionLike);
  if (!owner) {
    return null;
  }
  if (isDirectJsxEventCallback(callback)) {
    return "react-or-event";
  }
  if (sourceProvenEffectJsxCallback(callback, childContracts)) {
    return "source-proven-effect";
  }
  return callbackIsEventRooted(callback, owner, "", new Set()) ? "react-or-event" : null;
}

function isDirectObservableOnChangeCallback(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  observableBindings: ReadonlySet<string>,
): boolean {
  const { parent } = callback;
  if (
    !ts.isCallExpression(parent) ||
    parent.arguments.length !== 1 ||
    parent.arguments[0] !== callback ||
    parent.questionDotToken
  ) {
    return false;
  }
  const method = unwrapTransparentExpression(parent.expression);
  return (
    ts.isPropertyAccessExpression(method) &&
    !method.questionDotToken &&
    method.name.text === "onChange" &&
    provenObservablePath(method.expression, observableBindings) !== null
  );
}

function sourceProvenEffectJsxCallback(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  childContracts: ChildContractResolver | null,
): boolean {
  if (!childContracts || ts.isFunctionDeclaration(callback)) {
    return false;
  }
  const expression = callback.parent;
  if (
    !ts.isJsxExpression(expression) ||
    !expression.expression ||
    unwrapTransparentExpression(expression.expression) !== callback
  ) {
    return false;
  }
  const attribute = expression.parent;
  if (!ts.isJsxAttribute(attribute)) {
    return false;
  }
  const element = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return false;
  }
  return childContracts.componentCallbackPropRunsOnlyInReactEffect(
    element.tagName.getText(),
    attribute.name.getText(),
  );
}

function isDirectHookCallback(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  localNames: ReadonlySet<string>,
  namespaceNames: ReadonlySet<string>,
  hook:
    | "useEffect"
    | "useInsertionEffect"
    | "useLayoutEffect"
    | "useMount"
    | "useState"
    | "useUnmount",
): boolean {
  const { parent } = callback;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== callback) {
    return false;
  }
  return isImportedHookCall(parent, localNames, namespaceNames, hook);
}

function isDirectJsxEventCallback(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  const expression = callback.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== callback) {
    return false;
  }
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) && /^on[A-Z]/.test(attribute.name.getText());
}

function nonTrackingSnapshotFinding(
  call: ts.CallExpression,
  snapshot: NonTrackingSnapshot,
  sourceFile: ts.SourceFile,
  fileName: string,
): LegendPracticeFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)),
    path = snapshot.observable.getText(sourceFile);
  return {
    action: "use-peek-for-snapshot",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${path}.get() reads a proven Legend observable path`,
      snapshot.source === "source-proven-effect"
        ? "the source-proven React effect callback runs outside a Legend tracking context"
        : snapshot.source === "observable-listener"
          ? "the direct Legend observable onChange listener runs outside an observing context"
          : "the read is owned by a React snapshot or a uniquely event-rooted command, not a Legend tracking context",
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Replace \`${path}.get()\` with \`${path}.peek()\`; this code path needs a snapshot, not a reactive dependency.`,
    practice: "reactivity",
  };
}

interface DirectUseValueInput {
  kind: "eager-read" | "selector";
  observable: ts.Expression;
}

function directUseValueInput(
  call: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): DirectUseValueInput | null {
  if (!isUseValueCall(call, imports) || call.arguments.length < 1 || call.arguments.length > 2) {
    return null;
  }
  const input = call.arguments[0]!,
    eagerObservable = directObservableReadPath(input, observableBindings);
  if (eagerObservable) {
    return { kind: "eager-read", observable: eagerObservable };
  }
  const selectorObservable = directObservableSelectorPath(input, observableBindings);
  return selectorObservable ? { kind: "selector", observable: selectorObservable } : null;
}

export function directObservableSelectorPath(
  selector: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  if (
    (!ts.isArrowFunction(selector) && !ts.isFunctionExpression(selector)) ||
    selector.parameters.length > 0 ||
    ts.isBlock(selector.body)
  ) {
    return null;
  }
  return (
    directObservableReadPath(selector.body, observableBindings) ??
    dynamicallyKeyedObservableReadPath(selector.body, selector, observableBindings)
  );
}

function dynamicallyKeyedObservableReadPath(
  expression: ts.Expression,
  selector: ts.ArrowFunction | ts.FunctionExpression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  const path = directGetReceiver(expression);
  if (!path) {
    return null;
  }
  let current = path;
  while (ts.isPropertyAccessExpression(current)) {
    if (current.questionDotToken || RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) {
      return null;
    }
    current = unwrapTransparentExpression(current.expression);
  }
  if (
    !ts.isElementAccessExpression(current) ||
    current.questionDotToken ||
    !current.argumentExpression ||
    !stablePrimitiveParameter(current.argumentExpression, selector)
  ) {
    return null;
  }
  return provenObservablePath(current.expression, observableBindings) ? path : null;
}

function stablePrimitiveParameter(
  expression: ts.Expression,
  selector: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const key = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(key)) {
    return false;
  }
  const owner = findAncestor(selector, isRuntimeFunctionLike);
  if (!owner?.body || bindingDeclarationCount(owner, key.text) !== 1) {
    return false;
  }
  const parameter = owner.parameters.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === key.text,
  );
  if (
    !parameter?.type ||
    parameter.dotDotDotToken ||
    parameter.questionToken ||
    parameter.initializer ||
    !isPrimitiveKeyType(parameter.type)
  ) {
    return false;
  }

  return !bindingIsWritten(owner.body, key.text);
}

function isPrimitiveKeyType(type: ts.TypeNode): boolean {
  if (type.kind === ts.SyntaxKind.StringKeyword || type.kind === ts.SyntaxKind.NumberKeyword) {
    return true;
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return isPrimitiveKeyType(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.length > 0 && type.types.every(isPrimitiveKeyType);
  }
  if (!ts.isLiteralTypeNode(type)) {
    return false;
  }
  return ts.isStringLiteral(type.literal) || ts.isNumericLiteral(type.literal);
}

function bindingIsWritten(body: ts.ConciseBody, name: string): boolean {
  let written = false;
  visit(body, (node) => {
    if (written) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      nodeContainsValueIdentifier(node.left, name)
    ) {
      written = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      written = true;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      ts.isExpression(node.initializer) &&
      nodeContainsValueIdentifier(node.initializer, name)
    ) {
      written = true;
    }
  });
  return written;
}

function nodeContainsValueIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  visit(node, (current) => {
    if (
      !found &&
      ts.isIdentifier(current) &&
      current.text === name &&
      !isNonValueIdentifier(current)
    ) {
      found = true;
    }
  });
  return found;
}

function directObservableReadPath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  const path = directGetReceiver(expression);
  return path ? provenObservablePath(path, observableBindings) : null;
}

function directGetReceiver(expression: ts.Expression): ts.Expression | null {
  const read = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(read) ||
    read.arguments.length > 0 ||
    (read.typeArguments?.length ?? 0) > 0 ||
    read.questionDotToken ||
    !ts.isPropertyAccessExpression(read.expression) ||
    read.expression.questionDotToken ||
    read.expression.name.text !== "get"
  ) {
    return null;
  }
  return unwrapTransparentExpression(read.expression.expression);
}

function directUseValueFinding(
  call: ts.CallExpression,
  input: DirectUseValueInput,
  sourceFile: ts.SourceFile,
  fileName: string,
): LegendPracticeFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)),
    path = input.observable.getText(sourceFile),
    typeArguments = call.typeArguments?.length
      ? `<${call.typeArguments.map((argument) => argument.getText(sourceFile)).join(", ")}>`
      : "",
    hook = `${call.expression.getText(sourceFile)}${typeArguments}`,
    current = `${hook}(${call.arguments.map((argument) => argument.getText(sourceFile)).join(", ")})`,
    replacement = `${hook}(${[
      path,
      ...call.arguments.slice(1).map((argument) => argument.getText(sourceFile)),
    ].join(", ")})`,
    eager = input.kind === "eager-read";
  return {
    action: "pass-observable-to-use-value",
    confidence: "certain",
    disposition: "change",
    evidence: [
      eager
        ? "the observable is read with get() before useValue can subscribe"
        : "useValue selector only returns one zero-argument get() call",
      `${path} is a proven Legend observable path`,
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Replace \`${current}\` with \`${replacement}\`; the direct observable form ${eager ? "establishes the missing leaf subscription" : "keeps the same subscription with less code"}.`,
    practice: "reactivity",
  };
}

function narrowUseValueFinding(
  declaration: ts.VariableDeclaration,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  observableKeys: ReadonlyMap<string, ReadonlySet<string>>,
  sourceFile: ts.SourceFile,
  fileName: string,
): LegendPracticeFinding | null {
  const call = declaration.initializer;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, imports)
  ) {
    return null;
  }
  const observable = provenObservablePath(call.arguments[0]!, observableBindings);
  if (!observable) {
    return null;
  }

  if (ts.isObjectBindingPattern(declaration.name)) {
    const element = declaration.name.elements[0],
      property =
        element && !ts.isOmittedExpression(element)
          ? (element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile))
          : null;
    if (property && consumesEveryKnownField(observable, [[property]], observableKeys)) {
      return null;
    }
    return narrowObjectBindingFinding(
      declaration,
      declaration.name,
      observable,
      sourceFile,
      fileName,
    );
  }
  if (!ts.isIdentifier(declaration.name)) {
    return null;
  }
  const localName = declaration.name.text,
    owner = findAncestor(declaration, isRuntimeFunctionLike);
  if (!owner?.body || bindingDeclarationCount(owner, localName) !== 1) {
    return null;
  }

  const paths: (readonly string[])[] = [],
    optionalReferences: ts.Identifier[] = [];
  let unsafe = false;
  visit(owner.body, (node) => {
    if (
      unsafe ||
      !ts.isIdentifier(node) ||
      node.text !== localName ||
      node === declaration.name ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (isDeclarationName(node)) {
      unsafe = true;
      return;
    }
    const path = staticRawValuePath(node);
    if (!path) {
      unsafe = true;
      return;
    }
    if (rawValuePathHasOptionalAccess(node)) {
      optionalReferences.push(node);
    }
    paths.push(path);
  });
  if (unsafe || paths.length === 0) {
    return null;
  }
  if (consumesEveryKnownField(observable, paths, observableKeys)) {
    return null;
  }
  const commonPath = paths.slice(1).reduce(commonPathPrefix, paths[0]!);
  if (commonPath.length > 0) {
    if (
      optionalReferences.some(
        (reference) => !optionalAccessPreservesSuffix(reference, commonPath.length),
      )
    ) {
      return null;
    }
    return narrowFinding(
      declaration,
      observable,
      commonPath.join("."),
      localName,
      paths.length,
      false,
      sourceFile,
      fileName,
    );
  }
  if (optionalReferences.length > 0) {
    return null;
  }
  return splitLeavesFinding(declaration, localName, observable, paths, owner, sourceFile, fileName);
}

function consumesEveryKnownField(
  observable: ts.Expression,
  paths: readonly (readonly string[])[],
  observableKeys: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!ts.isIdentifier(observable) || paths.some((path) => path.length !== 1)) {
    return false;
  }
  const knownKeys = observableKeys.get(observable.text);
  if (!knownKeys || knownKeys.size === 0) {
    return false;
  }
  const consumed = new Set(paths.map((path) => path[0]!));
  return consumed.size === knownKeys.size && [...knownKeys].every((key) => consumed.has(key));
}

function splitLeavesFinding(
  declaration: ts.VariableDeclaration,
  localName: string,
  observable: ts.Expression,
  reads: readonly (readonly string[])[],
  owner: RuntimeFunctionLike,
  sourceFile: ts.SourceFile,
  fileName: string,
): LegendPracticeFinding | null {
  if (!owner.body) {
    return null;
  }
  const distinct: string[][] = [];
  for (const path of reads) {
    if (!distinct.some((existing) => existing.join(".") === path.join("."))) {
      distinct.push([...path]);
    }
  }
  distinct.sort((left, right) => left.length - right.length);
  const leaves = distinct.filter(
    (path) =>
      !distinct.some(
        (other) =>
          other.length < path.length && other.every((segment, index) => segment === path[index]),
      ),
  );
  if (leaves.length < 2) {
    return null;
  }

  const parentPath = observable.getText(sourceFile),
    leafNames = leaves.map((path) => ({
      name: leafSubscriptionName(path),
      path,
    })),
    proposedNames = new Set(leafNames.map((leaf) => leaf.name));
  if (proposedNames.size !== leafNames.length) {
    return null;
  }
  let collision = false;
  visit(owner.body, (node) => {
    if (
      !collision &&
      ts.isIdentifier(node) &&
      node !== declaration.name &&
      !isNonValueIdentifier(node) &&
      proposedNames.has(node.text)
    ) {
      collision = true;
    }
  });
  if (collision) {
    return null;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      declaration.getStart(sourceFile),
    ),
    declarations = leafNames
      .map((leaf) => `\`const ${leaf.name} = useValue(${parentPath}.${leaf.path.join(".")})\``)
      .join(", ");
  return {
    action: "split-use-value-leaves",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${reads.length} raw-value reads resolve through ${leafNames.length} distinct static leaf paths`,
      "every read is a static property chain and no read escapes as a whole value, call, write, or dynamic access",
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Split \`${localName}\` from \`useValue(${parentPath})\` into per-leaf subscriptions: ${declarations}; rewrite the ${reads.length} raw-value reads of \`${localName}.*\` to those leaf values so sibling fields no longer invalidate this component.`,
    practice: "reactivity",
  };
}

function leafSubscriptionName(path: readonly string[]): string {
  return path
    .map((segment, index) =>
      index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join("");
}

function staticRawValuePath(reference: ts.Identifier): readonly string[] | null {
  const path: string[] = [];
  let current: ts.Expression = reference;
  while (true) {
    const { parent } = current;
    if (ts.isParenthesizedExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === current) {
      return null;
    }
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== current) {
      break;
    }
    if (propertyAccessIsWritten(parent)) {
      return null;
    }
    if (RESERVED_OBSERVABLE_MEMBERS.has(parent.name.text) || propertyAccessIsExecutable(parent)) {
      return path.length > 0 ? path : null;
    }
    path.push(parent.name.text);
    current = parent;
  }
  return path.length > 0 ? path : null;
}

function rawValuePathHasOptionalAccess(reference: ts.Identifier): boolean {
  let current: ts.Expression = reference;
  while (
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    const access = current.parent;
    if (access.questionDotToken) {
      return true;
    }
    current = access;
  }
  return false;
}

function optionalAccessPreservesSuffix(reference: ts.Identifier, commonLength: number): boolean {
  let current: ts.Expression = reference,
    optionalInsideBoundary = false,
    segments = 0;
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    const access = current.parent;
    if (RESERVED_OBSERVABLE_MEMBERS.has(access.name.text) || propertyAccessIsExecutable(access)) {
      return !optionalInsideBoundary;
    }
    if (access.questionDotToken) {
      optionalInsideBoundary = true;
    }
    segments += 1;
    current = access;
    if (segments !== commonLength || !optionalInsideBoundary) {
      continue;
    }

    while (
      (ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent) ||
        ts.isNonNullExpression(current.parent)) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    const { parent } = current;
    return !(
      ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === current) ||
      (ts.isCallExpression(parent) && parent.expression === current) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === current)
    );
  }
  return true;
}

function commonPathPrefix(left: readonly string[], right: readonly string[]): readonly string[] {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return left.slice(0, length);
}

function narrowObjectBindingFinding(
  declaration: ts.VariableDeclaration,
  binding: ts.ObjectBindingPattern,
  observable: ts.Expression,
  sourceFile: ts.SourceFile,
  fileName: string,
): LegendPracticeFinding | null {
  const { elements } = binding;
  const element = elements[0];
  if (
    elements.length !== 1 ||
    !element ||
    element.dotDotDotToken ||
    element.initializer ||
    !ts.isIdentifier(element.name) ||
    (element.propertyName && !ts.isIdentifier(element.propertyName))
  ) {
    return null;
  }
  const property = element.propertyName?.text ?? element.name.text;
  if (RESERVED_OBSERVABLE_MEMBERS.has(property)) {
    return null;
  }
  return narrowFinding(
    declaration,
    observable,
    property,
    element.name.text,
    1,
    true,
    sourceFile,
    fileName,
  );
}

function narrowFinding(
  declaration: ts.VariableDeclaration,
  observable: ts.Expression,
  property: string,
  localName: string,
  reads: number,
  destructured: boolean,
  sourceFile: ts.SourceFile,
  fileName: string,
): LegendPracticeFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      declaration.getStart(sourceFile),
    ),
    parentPath = observable.getText(sourceFile),
    leafPath = `${parentPath}.${property}`,
    instruction = destructured
      ? `Replace the single-property destructure with \`const ${localName} = useValue(${leafPath})\``
      : `Narrow \`${localName}\` from \`useValue(${parentPath})\` to \`useValue(${leafPath})\`; bind the leaf value directly and replace the \`${localName}.${property}\` reads`;
  return {
    action: "narrow-use-value-subscription",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `the value from ${parentPath} is read only through the static \`${property}\` property`,
      `${leafPath} is a proven Legend observable path and has ${reads} raw-value read${reads === 1 ? "" : "s"}`,
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `${instruction} so sibling observable fields no longer invalidate this component.`,
    practice: "reactivity",
  };
}

function isUseValueCall(call: ts.CallExpression, imports: HookImports): boolean {
  if (!isImportedHookCall(call, imports.useValue, imports.legendReactNamespaces, "useValue")) {
    return false;
  }
  const binding = rootIdentifier(call.expression),
    owner = findAncestor(call, isRuntimeFunctionLike);
  return !binding || !owner || bindingDeclarationCount(owner, binding.text) === 0;
}

function provenObservablePath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  const path = unwrapTransparentExpression(expression);
  if (
    (!ts.isIdentifier(path) && !ts.isPropertyAccessExpression(path)) ||
    containsElementAccess(path)
  ) {
    return null;
  }
  let current: ts.Expression = path;
  while (ts.isPropertyAccessExpression(current)) {
    if (current.questionDotToken || RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) {
      return null;
    }
    current = current.expression;
  }
  return staticPathHasBinding(path, observableBindings) ? path : null;
}

function propertyAccessIsExecutable(access: ts.PropertyAccessExpression): boolean {
  const { parent } = access;
  return (
    (ts.isCallExpression(parent) && parent.expression === access) ||
    (ts.isNewExpression(parent) && parent.expression === access) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === access)
  );
}

function propertyAccessIsWritten(access: ts.PropertyAccessExpression): boolean {
  const { parent } = access;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === access &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operand === access &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === access) ||
    (ts.isDeleteExpression(parent) && parent.expression === access)
  );
}
