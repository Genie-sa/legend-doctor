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
import type { ChildContractResolver } from "./child-contract.js";
import type { HookImports } from "../imports.js";
import type { LegendPracticeFinding } from "../types.js";
import type { RuntimeFunctionLike } from "../ast.js";
import { isImportedHookCall } from "../imports.js";
import { propIsPrimitiveValueConsumer } from "./child-contract.js";
import ts from "typescript";

const MAX_LEAF_OWNER_SHARE = 0.4;
const MIN_LEAF_OWNER_ELEMENTS = 12;
const MAX_USE_VALUE_ARGUMENTS = 2;
const MIN_SPLIT_LEAVES = 2;

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

type JsxSubtree = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

type HookCallback = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

interface ObservableReadScan {
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly observableKeys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly childContracts: ChildContractResolver | null;
  readonly sourceFile: ts.SourceFile;
  readonly fileName: string;
}

interface UseValueDeclaration {
  readonly declaration: ts.VariableDeclaration;
  readonly call: ts.CallExpression;
  readonly localName: string;
  readonly observable: ts.Expression;
  readonly owner: RuntimeFunctionLike;
}

export function findObservableReadPractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  observableKeys: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  childContracts: ChildContractResolver | null = null,
): LegendPracticeFinding[] {
  const scan: ObservableReadScan = {
    childContracts,
    fileName,
    imports,
    observableBindings,
    observableKeys,
    sourceFile,
  };
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, (node) => {
    collectReadFindings(node, scan, findings);
  });
  return findings;
}

function collectReadFindings(
  node: ts.Node,
  scan: ObservableReadScan,
  findings: LegendPracticeFinding[],
): void {
  if (ts.isCallExpression(node)) {
    collectCallFindings(node, scan, findings);
  }
  if (ts.isVariableDeclaration(node)) {
    const finding =
      moveUseValueIntoChildFinding(node, scan) ??
      moveUseValueDownFinding(node, scan) ??
      narrowUseValueFinding(node, scan);
    if (finding) {
      findings.push(finding);
    }
  }
}

function collectCallFindings(
  call: ts.CallExpression,
  scan: ObservableReadScan,
  findings: LegendPracticeFinding[],
): void {
  const directInput = directUseValueInput(call, scan.imports, scan.observableBindings);
  if (directInput) {
    findings.push(directUseValueFinding(call, directInput, scan));
  }
  const snapshot = nonTrackingSnapshotObservable(call, scan);
  if (snapshot) {
    findings.push(nonTrackingSnapshotFinding(call, snapshot, scan));
  }
}

function identifiedUseValueDeclaration(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): UseValueDeclaration | null {
  const call = declaration.initializer;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, scan.imports) ||
    !ts.isIdentifier(declaration.name)
  ) {
    return null;
  }
  const observable = provenObservablePath(call.arguments[0]!, scan.observableBindings);
  const owner = findAncestor(declaration, isRuntimeFunctionLike);
  if (!observable || !owner?.body) {
    return null;
  }
  return { call, declaration, localName: declaration.name.text, observable, owner };
}

function isValueReferenceTo(
  node: ts.Node,
  localName: string,
  declarationName: ts.BindingName,
): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === localName &&
    node !== declarationName &&
    !isNonValueIdentifier(node)
  );
}

function moveUseValueIntoChildFinding(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const use = scan.childContracts ? identifiedUseValueDeclaration(declaration, scan) : null;
  if (
    !use ||
    bindingDeclarationCount(use.owner, use.localName) !== 1 ||
    hasAncestorUseValueSubscription(use.call, use.owner, scan) ||
    hasOtherGetReadOfPath(use.owner, use.observable, scan.observableBindings)
  ) {
    return null;
  }
  const reference = soleValueReference(use);
  const transport = reference ? directJsxPropTransport(reference) : null;
  if (!transport || !childAcceptsPrimitiveProp(transport, use.owner, scan)) {
    return null;
  }
  return moveIntoChildFinding(use, transport, scan);
}

function soleValueReference(use: UseValueDeclaration): ts.Identifier | null {
  let reference: ts.Identifier | null = null;
  let unsafe = false;
  visit(use.owner.body, (node) => {
    if (unsafe || !isValueReferenceTo(node, use.localName, use.declaration.name)) {
      return;
    }
    if (isDeclarationName(node) || reference !== null) {
      unsafe = true;
      return;
    }
    reference = node;
  });
  return unsafe ? null : reference;
}

function childAcceptsPrimitiveProp(
  transport: DirectJsxPropTransport,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (
    !isInsideOwnerReturn(transport.subtree, owner) ||
    hasUnstableSubtreeLifetime(transport.subtree, owner)
  ) {
    return false;
  }
  const child = scan.childContracts?.resolveComponent(transport.component);
  return Boolean(child && propIsPrimitiveValueConsumer(child, transport.prop));
}

function moveIntoChildFinding(
  use: UseValueDeclaration,
  transport: DirectJsxPropTransport,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    use.declaration.getStart(scan.sourceFile),
  );
  const observablePath = use.observable.getText(scan.sourceFile);
  return {
    action: "move-use-value-into-child",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `the ${use.localName} binding is referenced once, as the direct \`${transport.prop}\` prop of source-resolved \`${transport.component}\``,
      "the child is not React-wrapped, declares that prop as a primitive value, and consumes it",
      "the child call site is unkeyed, unrepeated, unconditional, and owned by the component's only render return",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
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
    const receiver = directGetReceiver(node);
    const other = receiver && provenObservablePath(receiver, observableBindings);
    const otherPath = other && staticPropertyPath(other);
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

function outermostTransparentParent(expression: ts.Expression): ts.Expression {
  let current = expression;
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
  return current;
}

function isTransportableJsxProp(prop: string): boolean {
  return prop !== "children" && prop !== "key" && prop !== "ref" && !/^on[A-Z]/u.test(prop);
}

function directJsxPropTransport(reference: ts.Identifier): DirectJsxPropTransport | null {
  const expression = outermostTransparentParent(reference);
  const container = expression.parent;
  if (
    !ts.isJsxExpression(container) ||
    container.expression !== expression ||
    !ts.isJsxAttribute(container.parent)
  ) {
    return null;
  }
  const attribute = container.parent;
  const opening = attribute.parent.parent;
  const prop = attribute.name.getText();
  if (
    (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
    !isTransportableJsxProp(prop)
  ) {
    return null;
  }
  return {
    component: opening.tagName.getText(),
    prop,
    subtree: ts.isJsxOpeningElement(opening) ? opening.parent : opening,
  };
}

interface MoveDownTarget {
  readonly leaf: JsxSubtree | null;
  readonly node: ts.Node;
  readonly leafElements: number;
  readonly ownerElements: number;
  readonly references: readonly ts.Identifier[];
}

function moveUseValueDownFinding(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const use = identifiedUseValueDeclaration(declaration, scan);
  if (
    !use ||
    bindingDeclarationCount(use.owner, use.localName) !== 1 ||
    jsxElementCount(use.owner) < MIN_LEAF_OWNER_ELEMENTS ||
    hasAncestorUseValueSubscription(use.call, use.owner, scan)
  ) {
    return null;
  }
  const references = projectedValueReferences(use);
  if (references === null) {
    return null;
  }
  const target = moveDownTarget(references, use.owner, scan);
  return target ? moveDownFinding(use, target, scan) : null;
}

function projectedValueReferences(use: UseValueDeclaration): readonly ts.Identifier[] | null {
  const references: ts.Identifier[] = [];
  let unsafe = false;
  visit(use.owner.body, (node) => {
    if (unsafe || !isValueReferenceTo(node, use.localName, use.declaration.name)) {
      return;
    }
    if (
      isDeclarationName(node) ||
      !isWholeValueProjection(node) ||
      !isSafeJsxProjectionReference(node, use.owner) ||
      nearestRepeatedRenderCall(node, use.owner)
    ) {
      unsafe = true;
      return;
    }
    references.push(node);
  });
  return unsafe || references.length === 0 ? null : references;
}

function stableJsxLeaf(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
): JsxSubtree | null {
  const leaf = lowestCommonJsxSubtree(references, owner);
  return leaf && !hasUnstableSubtreeLifetime(leaf, owner) ? leaf : null;
}

function moveDownTarget(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): MoveDownTarget | null {
  const conditionalSlot = stableConditionalJsxSlot(references, owner, scan.imports);
  const leaf = conditionalSlot ? null : stableJsxLeaf(references, owner);
  const node = leaf ?? conditionalSlot;
  if (!node) {
    return null;
  }
  const ownerElements = jsxElementCount(owner);
  const leafElements = jsxElementCountIn(node);
  if (leafElements / ownerElements > MAX_LEAF_OWNER_SHARE) {
    return null;
  }
  return { leaf, leafElements, node, ownerElements, references };
}

function jsxLeafLabel(leaf: JsxSubtree, sourceFile: ts.SourceFile): string {
  if (ts.isJsxFragment(leaf)) {
    return "fragment";
  }
  const tagName = ts.isJsxElement(leaf) ? leaf.openingElement.tagName : leaf.tagName;
  return `<${tagName.getText(sourceFile)}>`;
}

function moveDownFinding(
  use: UseValueDeclaration,
  target: MoveDownTarget,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    use.declaration.getStart(scan.sourceFile),
  );
  const leafLine =
    scan.sourceFile.getLineAndCharacterOfPosition(target.node.getStart(scan.sourceFile)).line + 1;
  const leafLabel = target.leaf
    ? jsxLeafLabel(target.leaf, scan.sourceFile)
    : "complete conditional JSX slot";
  const reads = target.references.length;
  const readEvidence = `${reads} render read${reads === 1 ? "" : "s"} of ${use.localName} occur${reads === 1 ? "s" : ""} only inside the ${target.leaf ? `stable ${leafLabel} leaf` : leafLabel} at line ${leafLine}`;
  const lifetimeEvidence = target.leaf
    ? `that leaf contains ${target.leafElements} of the owner's ${target.ownerElements} JSX elements and is not conditional, keyed, repeated, or split across returns`
    : `replacing the complete conditional JSX slot with one always-mounted wrapper preserves the subscription lifetime and the conditional child's mount behavior`;
  const observable = use.call.arguments[0]!.getText(scan.sourceFile);
  return {
    action: "move-use-value-down",
    confidence: "certain",
    disposition: "change",
    evidence: [readEvidence, lifetimeEvidence],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Move \`useValue(${observable})\` for \`${use.localName}\` into ${target.leaf ? "a stable wrapper around" : "an always-mounted wrapper for"} the ${leafLabel} at line ${leafLine}; keep observable ownership where it is and pass ${target.leaf ? "the leaf's other inputs" : "non-observable gate values"} as ordinary props so updates rerender ${target.leafElements} JSX element${target.leafElements === 1 ? "" : "s"} instead of the ${target.ownerElements}-element owner.`,
    practice: "reactivity",
  };
}

function hasAncestorUseValueSubscription(
  currentCall: ts.CallExpression,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  const currentObservable = provenObservablePath(
    currentCall.arguments[0]!,
    scan.observableBindings,
  );
  const currentPath = currentObservable && staticPropertyPath(currentObservable);
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
      !isUseValueCall(node, scan.imports)
    ) {
      return;
    }
    overlap = trackedUseValuePaths(node, scan.imports, scan.observableBindings).some(
      (otherObservable) => {
        const otherPath = staticPropertyPath(otherObservable);
        return (
          otherPath !== null &&
          otherPath.length <= currentPath.length &&
          otherPath.every((part, index) => part === currentPath[index])
        );
      },
    );
  });
  return overlap;
}

function trackedUseValuePaths(
  call: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): readonly ts.Expression[] {
  const direct = call.arguments[0] && provenObservablePath(call.arguments[0], observableBindings);
  const simpleInput = directUseValueInput(call, imports, observableBindings)?.observable;
  if (direct || simpleInput) {
    return [direct ?? simpleInput!];
  }

  const [selector] = call.arguments;
  if (!selector || (!ts.isArrowFunction(selector) && !ts.isFunctionExpression(selector))) {
    return [];
  }
  const paths: ts.Expression[] = [];
  visit(selector.body, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const receiver = directGetReceiver(node);
    const observable = receiver && provenObservablePath(receiver, observableBindings);
    if (observable) {
      paths.push(observable);
    }
  });
  return paths;
}

function containsKeyedJsxElement(expression: ts.Expression): boolean {
  let keyed = false;
  visit(expression, (node) => {
    if (
      !keyed &&
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties.some(
        (property) => ts.isJsxAttribute(property) && property.name.getText() === "key",
      )
    ) {
      keyed = true;
    }
  });
  return keyed;
}

function stableConditionalJsxSlot(
  references: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  imports: HookImports,
): ts.Expression | null {
  const slots = references.map((reference) => enclosingConditionalJsxExpression(reference, owner));
  const [slot] = slots;
  if (!slot || slots.some((candidate) => candidate !== slot) || !slot.expression) {
    return null;
  }
  const expression = unwrapTransparentExpression(slot.expression);
  const container =
    ts.isJsxElement(slot.parent) || ts.isJsxFragment(slot.parent) ? slot.parent : null;
  if (
    !container ||
    !isConditionalRenderExpression(expression) ||
    !hasRenderOwnedConditionalInputs(expression, {
      imports,
      observableValue: references[0]!.text,
      owner,
      resolving: new Set(),
    }) ||
    !isInsideOwnerReturn(slot, owner) ||
    hasUnstableSubtreeLifetime(container, owner)
  ) {
    return null;
  }
  return containsKeyedJsxElement(expression) ? null : expression;
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

interface ConditionalOwnership {
  readonly observableValue: string;
  readonly owner: RuntimeFunctionLike;
  readonly imports: HookImports;
  readonly resolving: ReadonlySet<string>;
}

function hasRenderOwnedConditionalInputs(
  expression: ts.Expression,
  ownership: ConditionalOwnership,
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
      !conditionalIdentifierIsRenderOwned(node.text, ownership)
    ) {
      safe = false;
      return;
    }
    node.forEachChild(walk);
  };
  walk(expression);
  return safe;
}

interface LocalConstDeclaration {
  readonly declaration: ts.VariableDeclaration;
  readonly initializer: ts.Expression;
}

function soleLocalInitializedDeclaration(
  body: ts.Node,
  name: string,
): LocalConstDeclaration | null {
  const declarations: ts.VariableDeclaration[] = [];
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (ts.isVariableDeclaration(node) && bindingContainsName(node.name, name)) {
      declarations.push(node);
    }
  });
  const declaration = declarations.length === 1 ? declarations[0]! : null;
  if (!declaration?.initializer || !ts.isVariableDeclarationList(declaration.parent)) {
    return null;
  }
  return { declaration, initializer: unwrapTransparentExpression(declaration.initializer) };
}

function conditionalIdentifierIsRenderOwned(
  name: string,
  ownership: ConditionalOwnership,
): boolean {
  if (name === ownership.observableValue || name === "undefined") {
    return true;
  }
  if (
    ownership.owner.parameters.some((parameter) => bindingContainsName(parameter.name, name)) &&
    bindingDeclarationCount(ownership.owner, name) === 1
  ) {
    return true;
  }
  if (!ownership.owner.body || ownership.resolving.has(name)) {
    return false;
  }
  const local = soleLocalInitializedDeclaration(ownership.owner.body, name);
  return local !== null && localBindingIsRenderOwned(local, name, ownership);
}

function localBindingIsRenderOwned(
  local: LocalConstDeclaration,
  name: string,
  ownership: ConditionalOwnership,
): boolean {
  const { declaration, initializer } = local;
  if (
    ts.isArrayBindingPattern(declaration.name) &&
    declaration.name.elements[0] &&
    !ts.isOmittedExpression(declaration.name.elements[0]) &&
    bindingContainsName(declaration.name.elements[0].name, name) &&
    ts.isCallExpression(initializer) &&
    isImportedHookCall(
      initializer,
      ownership.imports.useState,
      ownership.imports.reactNamespaces,
      "useState",
    )
  ) {
    return true;
  }
  if (
    ts.isIdentifier(declaration.name) &&
    ts.isCallExpression(initializer) &&
    isUseValueCall(initializer, ownership.imports)
  ) {
    return true;
  }
  if (!ts.isIdentifier(declaration.name) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
    return false;
  }
  return hasRenderOwnedConditionalInputs(initializer, {
    ...ownership,
    resolving: new Set([...ownership.resolving, name]),
  });
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
  const current = outermostTransparentParent(reference);
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
  scan: ObservableReadScan,
): NonTrackingSnapshot | null {
  if (
    call.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "get"
  ) {
    return null;
  }
  const observable = provenObservablePath(call.expression.expression, scan.observableBindings);
  if (!observable) {
    return null;
  }
  const callback = findAncestor(call, isRuntimeFunctionLike);
  if (!callback) {
    return null;
  }
  const source = provenNonTrackingCallbackSource(callback, scan);
  return source ? { observable, source } : null;
}

function isReactSnapshotCallback(callback: HookCallback, imports: HookImports): boolean {
  return (
    isDirectHookCallback(callback, imports, "useEffect") ||
    isDirectHookCallback(callback, imports, "useInsertionEffect") ||
    isDirectHookCallback(callback, imports, "useLayoutEffect") ||
    isDirectHookCallback(callback, imports, "useState") ||
    isDirectHookCallback(callback, imports, "useMount") ||
    isDirectHookCallback(callback, imports, "useUnmount")
  );
}

function eventRootedSnapshotSource(
  callback: HookCallback,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): NonTrackingSnapshot["source"] | null {
  if (isDirectJsxEventCallback(callback)) {
    return "react-or-event";
  }
  if (sourceProvenEffectJsxCallback(callback, scan.childContracts)) {
    return "source-proven-effect";
  }
  return callbackIsEventRooted(callback, owner, "", new Set()) ? "react-or-event" : null;
}

function provenNonTrackingCallbackSource(
  callback: RuntimeFunctionLike,
  scan: ObservableReadScan,
): NonTrackingSnapshot["source"] | null {
  if (
    !ts.isArrowFunction(callback) &&
    !ts.isFunctionDeclaration(callback) &&
    !ts.isFunctionExpression(callback)
  ) {
    return null;
  }
  if (isReactSnapshotCallback(callback, scan.imports)) {
    return "react-or-event";
  }
  if (isDirectObservableOnChangeCallback(callback, scan.observableBindings)) {
    return "observable-listener";
  }
  const owner = findAncestor(callback, isRuntimeFunctionLike);
  if (!owner) {
    return null;
  }
  return eventRootedSnapshotSource(callback, owner, scan);
}

function isDirectObservableOnChangeCallback(
  callback: HookCallback,
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
  callback: HookCallback,
  childContracts: ChildContractResolver | null,
): boolean {
  if (!childContracts || ts.isFunctionDeclaration(callback)) {
    return false;
  }
  const expression = callback.parent;
  if (
    !ts.isJsxExpression(expression) ||
    !expression.expression ||
    unwrapTransparentExpression(expression.expression) !== callback ||
    !ts.isJsxAttribute(expression.parent)
  ) {
    return false;
  }
  const attribute = expression.parent;
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
  callback: HookCallback,
  imports: HookImports,
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
  const namespaces =
    hook === "useMount" || hook === "useUnmount"
      ? imports.legendReactNamespaces
      : imports.reactNamespaces;
  return isImportedHookCall(parent, imports[hook], namespaces, hook);
}

function isDirectJsxEventCallback(callback: HookCallback): boolean {
  const expression = callback.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== callback) {
    return false;
  }
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) && /^on[A-Z]/u.test(attribute.name.getText());
}

function snapshotSourceEvidence(source: NonTrackingSnapshot["source"]): string {
  if (source === "source-proven-effect") {
    return "the source-proven React effect callback runs outside a Legend tracking context";
  }
  if (source === "observable-listener") {
    return "the direct Legend observable onChange listener runs outside an observing context";
  }
  return "the read is owned by a React snapshot or a uniquely event-rooted command, not a Legend tracking context";
}

function nonTrackingSnapshotFinding(
  call: ts.CallExpression,
  snapshot: NonTrackingSnapshot,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(scan.sourceFile),
  );
  const path = snapshot.observable.getText(scan.sourceFile);
  return {
    action: "use-peek-for-snapshot",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${path}.get() reads a proven Legend observable path`,
      snapshotSourceEvidence(snapshot.source),
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
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
  if (
    !isUseValueCall(call, imports) ||
    call.arguments.length === 0 ||
    call.arguments.length > MAX_USE_VALUE_ARGUMENTS
  ) {
    return null;
  }
  const input = call.arguments[0]!;
  const eagerObservable = directObservableReadPath(input, observableBindings);
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

function staticMemberChainRoot(path: ts.Expression): ts.Expression | null {
  let current = path;
  while (ts.isPropertyAccessExpression(current)) {
    if (current.questionDotToken || RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) {
      return null;
    }
    current = unwrapTransparentExpression(current.expression);
  }
  return current;
}

function dynamicallyKeyedObservableReadPath(
  expression: ts.Expression,
  selector: ts.ArrowFunction | ts.FunctionExpression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  const path = directGetReceiver(expression);
  const current = path && staticMemberChainRoot(path);
  if (
    !path ||
    !current ||
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
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(scan.sourceFile),
  );
  const path = input.observable.getText(scan.sourceFile);
  const typeArguments = call.typeArguments?.length
    ? `<${call.typeArguments.map((argument) => argument.getText(scan.sourceFile)).join(", ")}>`
    : "";
  const hook = `${call.expression.getText(scan.sourceFile)}${typeArguments}`;
  const current = `${hook}(${call.arguments.map((argument) => argument.getText(scan.sourceFile)).join(", ")})`;
  const replacement = `${hook}(${[
    path,
    ...call.arguments.slice(1).map((argument) => argument.getText(scan.sourceFile)),
  ].join(", ")})`;
  const eager = input.kind === "eager-read";
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
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Replace \`${current}\` with \`${replacement}\`; the direct observable form ${eager ? "establishes the missing leaf subscription" : "keeps the same subscription with less code"}.`,
    practice: "reactivity",
  };
}

interface NarrowCandidate {
  readonly declaration: ts.VariableDeclaration;
  readonly observable: ts.Expression;
}

interface RawValueReadScan {
  readonly candidate: NarrowCandidate;
  readonly localName: string;
  readonly owner: RuntimeFunctionLike;
  readonly paths: readonly (readonly string[])[];
  readonly optionalReferences: readonly ts.Identifier[];
}

function narrowUseValueFinding(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const call = declaration.initializer;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, scan.imports)
  ) {
    return null;
  }
  const observable = provenObservablePath(call.arguments[0]!, scan.observableBindings);
  if (!observable) {
    return null;
  }
  if (ts.isObjectBindingPattern(declaration.name)) {
    return narrowBindingPatternFinding({ declaration, observable }, declaration.name, scan);
  }
  return ts.isIdentifier(declaration.name)
    ? narrowIdentifierFinding({ declaration, observable }, declaration.name.text, scan)
    : null;
}

function narrowBindingPatternFinding(
  candidate: NarrowCandidate,
  binding: ts.ObjectBindingPattern,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const [element] = binding.elements;
  const property =
    element && !ts.isOmittedExpression(element)
      ? (element.propertyName?.getText(scan.sourceFile) ?? element.name.getText(scan.sourceFile))
      : null;
  if (
    property &&
    consumesEveryKnownField(candidate.observable, [[property]], scan.observableKeys)
  ) {
    return null;
  }
  return narrowObjectBindingFinding(candidate, binding, scan);
}

function rawValueReads(
  candidate: NarrowCandidate,
  localName: string,
  owner: RuntimeFunctionLike,
): RawValueReadScan | null {
  const paths: (readonly string[])[] = [];
  const optionalReferences: ts.Identifier[] = [];
  let unsafe = false;
  visit(owner.body, (node) => {
    if (unsafe || !isValueReferenceTo(node, localName, candidate.declaration.name)) {
      return;
    }
    const path = isDeclarationName(node) ? null : staticRawValuePath(node);
    if (!path) {
      unsafe = true;
      return;
    }
    if (rawValuePathHasOptionalAccess(node)) {
      optionalReferences.push(node);
    }
    paths.push(path);
  });
  return unsafe || paths.length === 0
    ? null
    : { candidate, localName, optionalReferences, owner, paths };
}

function commonReadPathPrefix(paths: readonly (readonly string[])[]): readonly string[] {
  let common = paths[0] ?? [];
  for (const path of paths.slice(1)) {
    common = commonPathPrefix(common, path);
  }
  return common;
}

function narrowIdentifierFinding(
  candidate: NarrowCandidate,
  localName: string,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const owner = findAncestor(candidate.declaration, isRuntimeFunctionLike);
  if (!owner?.body || bindingDeclarationCount(owner, localName) !== 1) {
    return null;
  }
  const reads = rawValueReads(candidate, localName, owner);
  if (
    reads === null ||
    consumesEveryKnownField(candidate.observable, reads.paths, scan.observableKeys)
  ) {
    return null;
  }
  const commonPath = commonReadPathPrefix(reads.paths);
  if (commonPath.length === 0) {
    return reads.optionalReferences.length > 0 ? null : splitLeavesFinding(reads, scan);
  }
  return narrowCommonPathFinding(reads, commonPath, scan);
}

function narrowCommonPathFinding(
  reads: RawValueReadScan,
  commonPath: readonly string[],
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  if (
    reads.optionalReferences.some(
      (reference) => !optionalAccessPreservesSuffix(reference, commonPath.length),
    )
  ) {
    return null;
  }
  return narrowFinding(
    {
      declaration: reads.candidate.declaration,
      destructured: false,
      localName: reads.localName,
      observable: reads.candidate.observable,
      property: commonPath.join("."),
      reads: reads.paths.length,
    },
    scan,
  );
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

interface LeafSubscription {
  readonly name: string;
  readonly path: readonly string[];
}

function distinctLeafPaths(reads: readonly (readonly string[])[]): readonly (readonly string[])[] {
  const distinct: string[][] = [];
  for (const path of reads) {
    if (!distinct.some((existing) => existing.join(".") === path.join("."))) {
      distinct.push([...path]);
    }
  }
  distinct.sort((left, right) => left.length - right.length);
  return distinct.filter(
    (path) =>
      !distinct.some(
        (other) =>
          other.length < path.length && other.every((segment, index) => segment === path[index]),
      ),
  );
}

function hasProposedNameCollision(
  reads: RawValueReadScan,
  proposedNames: ReadonlySet<string>,
): boolean {
  let collision = false;
  visit(reads.owner.body, (node) => {
    if (
      !collision &&
      ts.isIdentifier(node) &&
      node !== reads.candidate.declaration.name &&
      !isNonValueIdentifier(node) &&
      proposedNames.has(node.text)
    ) {
      collision = true;
    }
  });
  return collision;
}

function splitLeavesFinding(
  reads: RawValueReadScan,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const leaves = distinctLeafPaths(reads.paths);
  if (leaves.length < MIN_SPLIT_LEAVES) {
    return null;
  }
  const leafNames: readonly LeafSubscription[] = leaves.map((path) => ({
    name: leafSubscriptionName(path),
    path,
  }));
  const proposedNames = new Set(leafNames.map((leaf) => leaf.name));
  if (proposedNames.size !== leafNames.length || hasProposedNameCollision(reads, proposedNames)) {
    return null;
  }
  return splitLeavesMessage(reads, leafNames, scan);
}

function splitLeavesMessage(
  reads: RawValueReadScan,
  leafNames: readonly LeafSubscription[],
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    reads.candidate.declaration.getStart(scan.sourceFile),
  );
  const parentPath = reads.candidate.observable.getText(scan.sourceFile);
  const declarations = leafNames
    .map((leaf) => `\`const ${leaf.name} = useValue(${parentPath}.${leaf.path.join(".")})\``)
    .join(", ");
  return {
    action: "split-use-value-leaves",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${reads.paths.length} raw-value reads resolve through ${leafNames.length} distinct static leaf paths`,
      "every read is a static property chain and no read escapes as a whole value, call, write, or dynamic access",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Split \`${reads.localName}\` from \`useValue(${parentPath})\` into per-leaf subscriptions: ${declarations}; rewrite the ${reads.paths.length} raw-value reads of \`${reads.localName}.*\` to those leaf values so sibling fields no longer invalidate this component.`,
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

function rawValuePathTerminates(access: ts.PropertyAccessExpression): boolean {
  return RESERVED_OBSERVABLE_MEMBERS.has(access.name.text) || propertyAccessIsExecutable(access);
}

function collectRawValuePath(
  current: ts.Expression,
  path: readonly string[],
): readonly string[] | null {
  const { parent } = current;
  if (ts.isParenthesizedExpression(parent) && parent.expression === current) {
    return collectRawValuePath(parent, path);
  }
  if (
    (ts.isElementAccessExpression(parent) && parent.expression === current) ||
    (ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      propertyAccessIsWritten(parent))
  ) {
    return null;
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== current) {
    return path;
  }
  if (rawValuePathTerminates(parent)) {
    return path;
  }
  return collectRawValuePath(parent, [...path, parent.name.text]);
}

function staticRawValuePath(reference: ts.Identifier): readonly string[] | null {
  const path = collectRawValuePath(reference, []);
  return path && path.length > 0 ? path : null;
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

interface OptionalSuffixState {
  readonly commonLength: number;
  readonly optional: boolean;
  readonly segments: number;
}

function optionalSuffixIsWholeValue(access: ts.Expression): boolean {
  const outer = outermostTransparentParent(access);
  const { parent } = outer;
  return !(
    ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === outer) ||
    (ts.isCallExpression(parent) && parent.expression === outer) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === outer)
  );
}

function optionalSuffixStep(current: ts.Expression, state: OptionalSuffixState): boolean {
  const access = current.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== current) {
    return true;
  }
  if (rawValuePathTerminates(access)) {
    return !state.optional;
  }
  const next: OptionalSuffixState = {
    commonLength: state.commonLength,
    optional: state.optional || Boolean(access.questionDotToken),
    segments: state.segments + 1,
  };
  if (next.segments === next.commonLength && next.optional) {
    return optionalSuffixIsWholeValue(access);
  }
  return optionalSuffixStep(access, next);
}

function optionalAccessPreservesSuffix(reference: ts.Identifier, commonLength: number): boolean {
  return optionalSuffixStep(reference, { commonLength, optional: false, segments: 0 });
}

function commonPathPrefix(left: readonly string[], right: readonly string[]): readonly string[] {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return left.slice(0, length);
}

interface NarrowInstruction {
  readonly declaration: ts.VariableDeclaration;
  readonly observable: ts.Expression;
  readonly property: string;
  readonly localName: string;
  readonly reads: number;
  readonly destructured: boolean;
}

function narrowObjectBindingFinding(
  candidate: NarrowCandidate,
  binding: ts.ObjectBindingPattern,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const { elements } = binding;
  const [element] = elements;
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
    {
      declaration: candidate.declaration,
      destructured: true,
      localName: element.name.text,
      observable: candidate.observable,
      property,
      reads: 1,
    },
    scan,
  );
}

function narrowFinding(
  instruction: NarrowInstruction,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    instruction.declaration.getStart(scan.sourceFile),
  );
  const parentPath = instruction.observable.getText(scan.sourceFile);
  const leafPath = `${parentPath}.${instruction.property}`;
  const message = instruction.destructured
    ? `Replace the single-property destructure with \`const ${instruction.localName} = useValue(${leafPath})\``
    : `Narrow \`${instruction.localName}\` from \`useValue(${parentPath})\` to \`useValue(${leafPath})\`; bind the leaf value directly and replace the \`${instruction.localName}.${instruction.property}\` reads`;
  return {
    action: "narrow-use-value-subscription",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `the value from ${parentPath} is read only through the static \`${instruction.property}\` property`,
      `${leafPath} is a proven Legend observable path and has ${instruction.reads} raw-value read${instruction.reads === 1 ? "" : "s"}`,
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `${message} so sibling observable fields no longer invalidate this component.`,
    practice: "reactivity",
  };
}

function isUseValueCall(call: ts.CallExpression, imports: HookImports): boolean {
  if (!isImportedHookCall(call, imports.useValue, imports.legendReactNamespaces, "useValue")) {
    return false;
  }
  const binding = rootIdentifier(call.expression);
  const owner = findAncestor(call, isRuntimeFunctionLike);
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
