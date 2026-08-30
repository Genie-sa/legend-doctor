import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isEvaluationInert,
  rootIdentifier,
  staticPathHasBinding,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../ast.js";
import type { LegendPracticeFinding } from "../types.js";
import { RESERVED_OBSERVABLE_MEMBERS } from "./observable-reads.js";
import type { RuntimeFunctionLike } from "../ast.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "./state-proofs.js";

const SPREAD_WITH_ONE_MEMBER = 2;

interface SnapshotBinding {
  declaration: ts.VariableDeclaration;
}

interface NarrowWrite {
  evidence: readonly [string, string];
  message: string;
}

interface SnapshotAppendContext {
  sourceFile: ts.SourceFile;
  target: ts.Expression;
  write: ts.CallExpression;
}

interface SnapshotReadContext {
  owner: RuntimeFunctionLike;
  targetSpread: ts.SpreadAssignment | ts.SpreadElement;
  write: ts.CallExpression;
}

export function findObservableCloneWritePractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  observableBindings: ReadonlySet<string>,
): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const write =
      narrowObservableObjectWrite(node, sourceFile, observableBindings) ??
      narrowObservableArrayAppend(node, sourceFile, observableBindings);
    if (!write) {
      return;
    }
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      action: "narrow-observable-write",
      confidence: "probable",
      disposition: "change",
      evidence: write.evidence,
      location: { column: character + 1, file: fileName, line: line + 1 },
      message: write.message,
      practice: "reactivity",
    });
  });
  return findings;
}

function observableSetTarget(
  call: ts.CallExpression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  if (
    call.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "set"
  ) {
    return null;
  }
  const target = unwrapTransparentExpression(call.expression.expression);
  return staticPathHasBinding(target, observableBindings) ? target : null;
}

function narrowObservableObjectWrite(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  observableBindings: ReadonlySet<string>,
): NarrowWrite | null {
  const target = observableSetTarget(call, observableBindings);
  if (!target) {
    return null;
  }
  const override = clonedOverrideProperty(call, target, sourceFile);
  if (!override) {
    return null;
  }
  return narrowedChildWrite(override, target.getText(sourceFile), sourceFile);
}

function clonedOverrideProperty(
  call: ts.CallExpression,
  target: ts.Expression,
  sourceFile: ts.SourceFile,
): ts.ObjectLiteralElementLike | null {
  const value = unwrapTransparentExpression(call.arguments[0]!);
  if (!ts.isObjectLiteralExpression(value) || value.properties.length !== SPREAD_WITH_ONE_MEMBER) {
    return null;
  }
  const [spread, override] = value.properties;
  if (!spread || !ts.isSpreadAssignment(spread) || !override) {
    return null;
  }
  const snapshot = snapshotTarget(spread.expression, call, sourceFile);
  if (
    !snapshot ||
    snapshot.target.getText(sourceFile) !== target.getText(sourceFile) ||
    (snapshot.binding !== null && !snapshotBindingIsReadOnly(snapshot.binding, spread, call))
  ) {
    return null;
  }
  return override;
}

function narrowedChildWrite(
  override: ts.ObjectLiteralElementLike,
  targetText: string,
  sourceFile: ts.SourceFile,
): NarrowWrite | null {
  if (ts.isShorthandPropertyAssignment(override)) {
    return RESERVED_OBSERVABLE_MEMBERS.has(override.name.text)
      ? null
      : objectWrite(`${targetText}.${override.name.text}.set(${override.name.text})`, targetText);
  }
  if (!ts.isPropertyAssignment(override)) {
    return null;
  }
  return (
    namedChildWrite(override, targetText, sourceFile) ??
    computedChildWrite(override, targetText, sourceFile)
  );
}

function namedChildWrite(
  override: ts.PropertyAssignment,
  targetText: string,
  sourceFile: ts.SourceFile,
): NarrowWrite | null {
  const { name } = override;
  if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
    return null;
  }
  if (RESERVED_OBSERVABLE_MEMBERS.has(name.text)) {
    return null;
  }
  const child = ts.isIdentifier(name) ? `.${name.text}` : `[${name.getText(sourceFile)}]`;
  const argument = override.initializer.getText(sourceFile);
  return objectWrite(`${targetText}${child}.set(${argument})`, targetText);
}

function computedChildWrite(
  override: ts.PropertyAssignment,
  targetText: string,
  sourceFile: ts.SourceFile,
): NarrowWrite | null {
  const { name } = override;
  const argument = override.initializer.getText(sourceFile);
  if (ts.isNumericLiteral(name)) {
    return objectWrite(`${targetText}[${name.getText(sourceFile)}].set(${argument})`, targetText);
  }
  if (!ts.isComputedPropertyName(name) || !safeDynamicKey(name.expression)) {
    return null;
  }
  const key = name.expression.getText(sourceFile);
  return objectWrite(`${targetText}[${key}].set(${argument})`, targetText);
}

function objectWrite(replacement: string, target: string): NarrowWrite {
  return {
    evidence: [
      `the object clone starts from a non-tracking snapshot of ${target}`,
      "the clone changes exactly one proven child and the snapshot binding is not mutated or escaped",
    ],
    message: `Replace this whole-object clone write with \`${replacement}\`; update the observable child directly so Legend does not clone or replace unaffected sibling fields.`,
  };
}

function narrowObservableArrayAppend(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  observableBindings: ReadonlySet<string>,
): NarrowWrite | null {
  const target = observableSetTarget(call, observableBindings);
  if (
    !target ||
    !rootIdentifier(target) ||
    !observableTargetStartsAsArray(target, call, sourceFile)
  ) {
    return null;
  }
  const argument = unwrapTransparentExpression(call.arguments[0]!);
  const appended = ts.isArrowFunction(argument)
    ? updaterAppendValue(argument)
    : snapshotAppendValue(argument, { sourceFile, target, write: call });
  if (!appended || !isEvaluationInert(appended)) {
    return null;
  }
  const targetText = target.getText(sourceFile);
  const appendedText = appended.getText(sourceFile);
  return {
    evidence: [
      `the clone appends exactly one inert value to the same proven observable array ${targetText}`,
      "the observable path is locally initialized as an array and no sort, filter, slice, prepend, or spread transform is present",
    ],
    message: `Replace this cloned-array write with \`${targetText}.push(${appendedText})\`; append directly so Legend preserves the array and avoids cloning or replacing unaffected entries.`,
  };
}

function updaterAppendValue(updater: ts.ArrowFunction): ts.Expression | null {
  if (
    updater.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name) ||
    ts.isBlock(updater.body)
  ) {
    return null;
  }
  const array = unwrapTransparentExpression(updater.body);
  if (!ts.isArrayLiteralExpression(array) || array.elements.length !== SPREAD_WITH_ONE_MEMBER) {
    return null;
  }
  const [snapshot, appended] = array.elements;
  const parameter = updater.parameters[0]!.name;
  if (
    !snapshot ||
    !ts.isSpreadElement(snapshot) ||
    !ts.isIdentifier(snapshot.expression) ||
    snapshot.expression.text !== parameter.text ||
    !appended ||
    ts.isSpreadElement(appended) ||
    expressionReferencesName(appended, parameter.text)
  ) {
    return null;
  }
  return appended;
}

function snapshotAppendValue(
  expression: ts.Expression,
  context: SnapshotAppendContext,
): ts.Expression | null {
  const { sourceFile, target, write } = context;
  if (
    !ts.isArrayLiteralExpression(expression) ||
    expression.elements.length !== SPREAD_WITH_ONE_MEMBER
  ) {
    return null;
  }
  const [spread, appended] = expression.elements;
  if (!spread || !ts.isSpreadElement(spread) || !appended || ts.isSpreadElement(appended)) {
    return null;
  }
  const snapshot = snapshotTarget(spread.expression, write, sourceFile);
  if (
    !snapshot ||
    snapshot.target.getText(sourceFile) !== target.getText(sourceFile) ||
    (snapshot.binding !== null &&
      (!snapshotBindingIsReadOnly(snapshot.binding, spread, write) ||
        (ts.isIdentifier(snapshot.binding.declaration.name) &&
          expressionReferencesName(appended, snapshot.binding.declaration.name.text))))
  ) {
    return null;
  }
  return appended;
}

function observableTargetStartsAsArray(
  target: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const root = rootIdentifier(target);
  const properties = staticPropertyPath(target);
  if (!root || !properties) {
    return false;
  }
  const declaration =
    lexicalVariableDeclaration(write, root.text) ??
    uniqueVariableDeclaration(sourceFile, root.text);
  const factory = declaration?.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  if (!factory || !ts.isCallExpression(factory) || factory.arguments.length === 0) {
    return false;
  }
  const initializer = resolveObjectPath(factory.arguments[0]!, properties);
  return (
    initializer !== null && ts.isArrayLiteralExpression(unwrapTransparentExpression(initializer))
  );
}

function resolveObjectPath(
  root: ts.Expression,
  properties: readonly string[],
): ts.Expression | null {
  let initializer = root;
  for (const propertyName of properties) {
    const object = unwrapTransparentExpression(initializer);
    if (!ts.isObjectLiteralExpression(object)) {
      return null;
    }
    const property = object.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) && staticPropertyName(candidate.name) === propertyName,
    );
    if (!property || !ts.isPropertyAssignment(property)) {
      return null;
    }
    ({ initializer } = property);
  }
  return initializer;
}

function lexicalVariableDeclaration(node: ts.Node, name: string): ts.VariableDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isRuntimeFunctionLike(current) && current.body) {
      const declaration = uniqueVariableDeclaration(current.body, name);
      if (declaration) {
        return declaration;
      }
    }
    current = current.parent;
  }
  return null;
}

function staticPropertyPath(expression: ts.Expression): string[] | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    return [];
  }
  if (!ts.isPropertyAccessExpression(value)) {
    return null;
  }
  const parent = staticPropertyPath(value.expression);
  return parent ? [...parent, value.name.text] : null;
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function expressionReferencesName(expression: ts.Expression, name: string): boolean {
  let found = false;
  visit(expression, (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
    }
  });
  return found;
}

function snapshotTarget(
  expression: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { binding: SnapshotBinding | null; target: ts.Expression } | null {
  const direct = peekTarget(expression);
  if (direct) {
    return { binding: null, target: direct };
  }
  const resolved = resolvedSnapshotBinding(expression, write, sourceFile);
  if (!resolved) {
    return null;
  }
  const target = peekTarget(resolved.initializer);
  return target ? { binding: { declaration: resolved.declaration }, target } : null;
}

function resolvedSnapshotBinding(
  expression: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { declaration: ts.VariableDeclaration; initializer: ts.Expression } | null {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(value)) {
    return null;
  }
  const owner = findAncestor(write, isRuntimeFunctionLike);
  if (!owner?.body || bindingDeclarationCount(owner, value.text) !== 1) {
    return null;
  }
  const resolved = uniqueVariableDeclaration(owner.body, value.text);
  if (
    !resolved?.initializer ||
    !ts.isVariableDeclarationList(resolved.parent) ||
    (resolved.parent.flags & ts.NodeFlags.Const) === 0 ||
    resolved.getStart(sourceFile) >= write.getStart(sourceFile)
  ) {
    return null;
  }
  return { declaration: resolved, initializer: resolved.initializer };
}

function peekTarget(expression: ts.Expression): ts.Expression | null {
  let value = unwrapTransparentExpression(expression);
  const fallback = ts.isBinaryExpression(value) ? unwrapTransparentExpression(value.right) : null;
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    fallback &&
    ts.isObjectLiteralExpression(fallback) &&
    fallback.properties.length === 0
  ) {
    value = unwrapTransparentExpression(value.left);
  }
  if (
    !ts.isCallExpression(value) ||
    value.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== "peek"
  ) {
    return null;
  }
  return unwrapTransparentExpression(value.expression.expression);
}

function snapshotBindingIsReadOnly(
  binding: SnapshotBinding,
  targetSpread: ts.SpreadAssignment | ts.SpreadElement,
  write: ts.CallExpression,
): boolean {
  const owner = findAncestor(write, isRuntimeFunctionLike);
  if (!owner?.body || !ts.isIdentifier(binding.declaration.name)) {
    return false;
  }
  if (crossesAsyncBoundary(owner.body, binding.declaration.end, write.getStart())) {
    return false;
  }
  const declared = binding.declaration.name;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !ts.isIdentifier(node) || node.text !== declared.text || node === declared) {
      return;
    }
    if (!referenceIsReadOnly(node, { owner, targetSpread, write })) {
      safe = false;
    }
  });
  return safe;
}

function crossesAsyncBoundary(body: ts.Node, start: number, end: number): boolean {
  let crosses = false;
  visit(body, (node) => {
    if (
      node.getStart() > start &&
      node.end < end &&
      (ts.isAwaitExpression(node) || ts.isYieldExpression(node))
    ) {
      crosses = true;
    }
  });
  return crosses;
}

function referenceIsReadOnly(node: ts.Identifier, context: SnapshotReadContext): boolean {
  const { owner, targetSpread, write } = context;
  if (nodeWithin(node, targetSpread.expression)) {
    return true;
  }
  if (
    node.getStart() >= write.end ||
    findAncestor(node, isRuntimeFunctionLike) !== owner ||
    referenceMayRepeatAfterWrite(node, write, owner)
  ) {
    return false;
  }
  const access = outermostAccess(node);
  if (access === node && !isControlConditionReference(node, owner)) {
    return false;
  }
  return !isMutatingAccess(access);
}

function isMutatingAccess(access: ts.Expression): boolean {
  const { parent } = access;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === access &&
      isAssignmentOperator(parent.operatorToken.kind)) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
      parent.operand === access) ||
    (ts.isDeleteExpression(parent) && parent.expression === access) ||
    (ts.isCallExpression(parent) && parent.expression === access) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === access) ||
    (ts.isSpreadElement(parent) && parent.expression === access)
  );
}

function isControlConditionReference(node: ts.Node, owner: ts.Node): boolean {
  let current = node;
  while (current.parent && current.parent !== owner) {
    const { parent } = current;
    if (
      (ts.isIfStatement(parent) && parent.expression === current) ||
      (ts.isConditionalExpression(parent) && parent.condition === current)
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function referenceMayRepeatAfterWrite(node: ts.Node, write: ts.Node, owner: ts.Node): boolean {
  let current = node;
  while (current.parent && current.parent !== owner) {
    const { parent } = current;
    const repeatedCondition =
      ((ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
        parent.expression === current) ||
      (ts.isForStatement(parent) &&
        (parent.condition === current || parent.incrementor === current));
    if (repeatedCondition && nodeWithin(write, parent.statement)) {
      return true;
    }
    current = parent;
  }
  return false;
}

function outermostAccess(root: ts.Identifier): ts.Expression {
  let current: ts.Expression = root;
  while (
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function safeDynamicKey(expression: ts.Expression): boolean {
  const key = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(key) || ts.isNumericLiteral(key)) {
    return true;
  }
  return ts.isStringLiteral(key) && !RESERVED_OBSERVABLE_MEMBERS.has(key.text);
}
