import ts from "typescript";

import {
  bindingDeclarationCount,
  containsElementAccess,
  isAssignmentOperator,
  isDeclarationName,
  isNonValueIdentifier,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, type RuntimeFunctionLike, visit } from "../ast.js";
import { isImportedHookCall, type HookImports } from "../imports.js";
import type { LegendPracticeFinding } from "../types.js";
import {
  callbackIsEventRooted,
  hasUnstableSubtreeLifetime,
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "./state-proofs.js";

const MIN_LEAF_OWNER_ELEMENTS = 12;
const MAX_LEAF_OWNER_SHARE = 0.4;

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
  observableKeys: ReadonlyMap<string, ReadonlySet<string>> = new Map()
): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, node => {
    if (ts.isCallExpression(node)) {
      const directInput = directUseValueInput(node, imports, observableBindings);
      if (directInput) findings.push(directUseValueFinding(node, directInput, sourceFile, fileName));
      const snapshotReceiver = nonTrackingSnapshotObservable(node, imports, observableBindings);
      if (snapshotReceiver) {
        findings.push(nonTrackingSnapshotFinding(node, snapshotReceiver, sourceFile, fileName));
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const finding = moveUseValueDownFinding(
        node,
        imports,
        observableBindings,
        sourceFile,
        fileName
      ) ?? narrowUseValueFinding(
        node,
        imports,
        observableBindings,
        observableKeys,
        sourceFile,
        fileName
      );
      if (finding) findings.push(finding);
    }
  });
  return findings;
}

function moveUseValueDownFinding(
  declaration: ts.VariableDeclaration,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
  fileName: string
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
  const owner = findAncestor(declaration, isRuntimeFunctionLike);
  const localName = declaration.name.text;
  if (
    !owner?.body ||
    bindingDeclarationCount(owner, localName) !== 1 ||
    jsxElementCount(owner) < MIN_LEAF_OWNER_ELEMENTS
  ) {
    return null;
  }

  const references: ts.Identifier[] = [];
  let unsafe = false;
  visit(owner.body, node => {
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
  if (unsafe || references.length === 0) return null;

  const leaf = lowestCommonJsxSubtree(references, owner);
  if (!leaf || hasUnstableSubtreeLifetime(leaf, owner)) return null;
  const ownerElements = jsxElementCount(owner);
  const leafElements = jsxElementCountIn(leaf);
  if (leafElements / ownerElements > MAX_LEAF_OWNER_SHARE) return null;

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(sourceFile)
  );
  const leafLine = sourceFile.getLineAndCharacterOfPosition(leaf.getStart(sourceFile)).line + 1;
  const leafLabel = ts.isJsxFragment(leaf)
    ? "fragment"
    : `<${ts.isJsxElement(leaf) ? leaf.openingElement.tagName.getText(sourceFile) : leaf.tagName.getText(sourceFile)}>`;
  const observable = call.arguments[0]!.getText(sourceFile);
  return {
    action: "move-use-value-down",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${references.length} render read${references.length === 1 ? "" : "s"} of ${localName} occur only inside the stable ${leafLabel} leaf at line ${leafLine}`,
      `that leaf contains ${leafElements} of the owner's ${ownerElements} JSX elements and is not conditional, keyed, repeated, or split across returns`,
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Move \`useValue(${observable})\` for \`${localName}\` into a stable wrapper around the ${leafLabel} leaf at line ${leafLine}; keep observable ownership where it is and pass the leaf's other inputs as ordinary props so updates rerender ${leafElements} JSX element${leafElements === 1 ? "" : "s"} instead of the ${ownerElements}-element owner.`,
    practice: "reactivity",
  };
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
    (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  );
}

function nonTrackingSnapshotObservable(
  call: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>
): ts.Expression | null {
  if (
    call.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "get"
  ) {
    return null;
  }
  const observable = provenObservablePath(call.expression.expression, observableBindings);
  if (!observable) return null;
  const callback = findAncestor(call, isRuntimeFunctionLike);
  return callback && isProvenNonTrackingCallback(callback, imports) ? observable : null;
}

function isProvenNonTrackingCallback(
  callback: RuntimeFunctionLike,
  imports: HookImports
): boolean {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionDeclaration(callback) && !ts.isFunctionExpression(callback)) {
    return false;
  }
  if (isDirectReactCallback(callback, imports, "useEffect")) return true;
  if (isDirectReactCallback(callback, imports, "useState")) return true;

  const owner = findAncestor(callback, isRuntimeFunctionLike);
  if (!owner) return false;
  if (isDirectJsxEventCallback(callback)) return true;
  return callbackIsEventRooted(callback, owner, "", new Set());
}

function isDirectReactCallback(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  imports: HookImports,
  hook: "useEffect" | "useState"
): boolean {
  const parent = callback.parent;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== callback) return false;
  return isImportedHookCall(
    parent,
    hook === "useEffect" ? imports.useEffect : imports.useState,
    imports.reactNamespaces,
    hook
  );
}

function isDirectJsxEventCallback(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression
): boolean {
  const expression = callback.parent;
  if (!ts.isJsxExpression(expression) || expression.expression !== callback) return false;
  const attribute = expression.parent;
  return ts.isJsxAttribute(attribute) && /^on[A-Z]/.test(attribute.name.getText());
}

function nonTrackingSnapshotFinding(
  call: ts.CallExpression,
  observable: ts.Expression,
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  const path = observable.getText(sourceFile);
  return {
    action: "use-peek-for-snapshot",
    confidence: "probable",
    disposition: "change",
    evidence: [
      `${path}.get() reads a proven Legend observable path`,
      "the read is owned by a React snapshot or a uniquely event-rooted command, not a Legend tracking context",
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
  observableBindings: ReadonlySet<string>
): DirectUseValueInput | null {
  if (!isUseValueCall(call, imports) || call.arguments.length < 1 || call.arguments.length > 2) {
    return null;
  }
  const input = call.arguments[0]!;
  const eagerObservable = directObservableReadPath(input, observableBindings);
  if (eagerObservable) return { kind: "eager-read", observable: eagerObservable };
  const selectorObservable = directObservableSelectorPath(input, observableBindings);
  return selectorObservable ? { kind: "selector", observable: selectorObservable } : null;
}

export function directObservableSelectorPath(
  selector: ts.Expression,
  observableBindings: ReadonlySet<string>
): ts.Expression | null {
  if (
    (!ts.isArrowFunction(selector) && !ts.isFunctionExpression(selector)) ||
    selector.parameters.length > 0 ||
    ts.isBlock(selector.body)
  ) {
    return null;
  }
  return directObservableReadPath(selector.body, observableBindings);
}

function directObservableReadPath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>
): ts.Expression | null {
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
  return provenObservablePath(read.expression.expression, observableBindings);
}

function directUseValueFinding(
  call: ts.CallExpression,
  input: DirectUseValueInput,
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  const path = input.observable.getText(sourceFile);
  const typeArguments = call.typeArguments?.length
    ? `<${call.typeArguments.map(argument => argument.getText(sourceFile)).join(", ")}>`
    : "";
  const hook = `${call.expression.getText(sourceFile)}${typeArguments}`;
  const current = `${hook}(${call.arguments.map(argument => argument.getText(sourceFile)).join(", ")})`;
  const replacement = `${hook}(${[
    path,
    ...call.arguments.slice(1).map(argument => argument.getText(sourceFile)),
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
  fileName: string
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
  if (!observable) return null;

  if (ts.isObjectBindingPattern(declaration.name)) {
    const element = declaration.name.elements[0];
    const property = element && !ts.isOmittedExpression(element)
      ? element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile)
      : null;
    if (property && consumesEveryKnownField(observable, [[property]], observableKeys)) return null;
    return narrowObjectBindingFinding(declaration, declaration.name, observable, sourceFile, fileName);
  }
  if (!ts.isIdentifier(declaration.name)) return null;
  const localName = declaration.name.text;
  const owner = findAncestor(declaration, isRuntimeFunctionLike);
  if (
    !owner?.body ||
    bindingDeclarationCount(owner, localName) !== 1
  ) {
    return null;
  }

  const paths: (readonly string[])[] = [];
  let unsafe = false;
  visit(owner.body, node => {
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
    paths.push(path);
  });
  if (unsafe || paths.length === 0) return null;
  if (consumesEveryKnownField(observable, paths, observableKeys)) return null;
  const commonPath = paths.slice(1).reduce(commonPathPrefix, paths[0]!);
  if (commonPath.length > 0) {
    return narrowFinding(
      declaration,
      observable,
      commonPath.join("."),
      localName,
      paths.length,
      false,
      sourceFile,
      fileName
    );
  }
  return splitLeavesFinding(
    declaration,
    localName,
    observable,
    paths,
    owner,
    sourceFile,
    fileName
  );
}

function consumesEveryKnownField(
  observable: ts.Expression,
  paths: readonly (readonly string[])[],
  observableKeys: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  if (!ts.isIdentifier(observable) || paths.some(path => path.length !== 1)) return false;
  const knownKeys = observableKeys.get(observable.text);
  if (!knownKeys || knownKeys.size === 0) return false;
  const consumed = new Set(paths.map(path => path[0]!));
  return consumed.size === knownKeys.size && [...knownKeys].every(key => consumed.has(key));
}

function splitLeavesFinding(
  declaration: ts.VariableDeclaration,
  localName: string,
  observable: ts.Expression,
  reads: readonly (readonly string[])[],
  owner: RuntimeFunctionLike,
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding | null {
  if (!owner.body) return null;
  const distinct: string[][] = [];
  for (const path of reads) {
    if (!distinct.some(existing => existing.join(".") === path.join("."))) {
      distinct.push([...path]);
    }
  }
  distinct.sort((left, right) => left.length - right.length);
  const leaves = distinct.filter(path =>
    !distinct.some(other =>
      other.length < path.length &&
      other.every((segment, index) => segment === path[index])
    )
  );
  if (leaves.length < 2) return null;

  const parentPath = observable.getText(sourceFile);
  const leafNames = leaves.map(path => ({
    name: leafSubscriptionName(path),
    path
  }));
  const proposedNames = new Set(leafNames.map(leaf => leaf.name));
  if (proposedNames.size !== leafNames.length) return null;
  let collision = false;
  visit(owner.body, node => {
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
  if (collision) return null;

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(sourceFile)
  );
  const declarations = leafNames
    .map(leaf => `\`const ${leaf.name} = useValue(${parentPath}.${leaf.path.join(".")})\``)
    .join(", ");
  return {
    action: "split-use-value-leaves",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${reads.length} raw-value reads resolve through ${leafNames.length} distinct static leaf paths`,
      "every read is a static property chain and no read escapes as a whole value, call, write, or dynamic access"
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Split \`${localName}\` from \`useValue(${parentPath})\` into per-leaf subscriptions: ${declarations}; rewrite the ${reads.length} raw-value reads of \`${localName}.*\` to those leaf values so sibling fields no longer invalidate this component.`,
    practice: "reactivity"
  };
}

function leafSubscriptionName(path: readonly string[]): string {
  return path
    .map((segment, index) =>
      index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1)
    )
    .join("");
}

function staticRawValuePath(reference: ts.Identifier): readonly string[] | null {
  const path: string[] = [];
  let current: ts.Expression = reference;
  while (true) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === current) return null;
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== current) break;
    if (parent.questionDotToken || propertyAccessIsWritten(parent)) return null;
    if (RESERVED_OBSERVABLE_MEMBERS.has(parent.name.text) || propertyAccessIsExecutable(parent)) {
      return path.length > 0 ? path : null;
    }
    path.push(parent.name.text);
    current = parent;
  }
  return path.length > 0 ? path : null;
}

function commonPathPrefix(left: readonly string[], right: readonly string[]): readonly string[] {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return left.slice(0, length);
}

function narrowObjectBindingFinding(
  declaration: ts.VariableDeclaration,
  binding: ts.ObjectBindingPattern,
  observable: ts.Expression,
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding | null {
  const elements = binding.elements;
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
  if (RESERVED_OBSERVABLE_MEMBERS.has(property)) return null;
  return narrowFinding(
    declaration,
    observable,
    property,
    element.name.text,
    1,
    true,
    sourceFile,
    fileName
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
  fileName: string
): LegendPracticeFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
  const parentPath = observable.getText(sourceFile);
  const leafPath = `${parentPath}.${property}`;
  const instruction = destructured
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
  if (
    !isImportedHookCall(
      call,
      imports.useValue,
      imports.legendReactNamespaces,
      "useValue"
    )
  ) {
    return false;
  }
  const binding = rootIdentifier(call.expression);
  const owner = findAncestor(call, isRuntimeFunctionLike);
  return !binding || !owner || bindingDeclarationCount(owner, binding.text) === 0;
}

function provenObservablePath(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>
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
    if (current.questionDotToken || RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)) return null;
    current = current.expression;
  }
  const root = rootIdentifier(path);
  return root && observableBindings.has(root.text) ? path : null;
}

function propertyAccessIsExecutable(access: ts.PropertyAccessExpression): boolean {
  const parent = access.parent;
  return (
    (ts.isCallExpression(parent) && parent.expression === access) ||
    (ts.isNewExpression(parent) && parent.expression === access) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === access)
  );
}

function propertyAccessIsWritten(access: ts.PropertyAccessExpression): boolean {
  const parent = access.parent;
  return (
    (ts.isBinaryExpression(parent) && parent.left === access && isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operand === access &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === access) ||
    (ts.isDeleteExpression(parent) && parent.expression === access)
  );
}
