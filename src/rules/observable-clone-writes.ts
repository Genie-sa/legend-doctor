import ts from "typescript";

import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isEvaluationInert,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../ast.js";
import type { LegendPracticeFinding } from "../types.js";
import { RESERVED_OBSERVABLE_MEMBERS } from "./observable-reads.js";
import { uniqueVariableDeclaration } from "./state-proofs.js";

interface SnapshotBinding {
  declaration: ts.VariableDeclaration;
}

interface NarrowWrite {
  evidence: readonly [string, string];
  message: string;
}

export function findObservableCloneWritePractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  observableBindings: ReadonlySet<string>
): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, node => {
    if (!ts.isCallExpression(node)) return;
    const write = narrowObservableObjectWrite(node, sourceFile, observableBindings) ??
      narrowObservableArrayAppend(node, sourceFile, observableBindings);
    if (!write) return;
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

function narrowObservableObjectWrite(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  observableBindings: ReadonlySet<string>
): NarrowWrite | null {
  if (
    call.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "set"
  ) {
    return null;
  }
  const target = unwrapTransparentExpression(call.expression.expression);
  const root = rootIdentifier(target);
  if (!root || !observableBindings.has(root.text)) return null;

  const value = unwrapTransparentExpression(call.arguments[0]!);
  if (!ts.isObjectLiteralExpression(value) || value.properties.length !== 2) return null;
  const [spread, override] = value.properties;
  if (!spread || !ts.isSpreadAssignment(spread) || !override) return null;

  const snapshot = snapshotTarget(spread.expression, call, sourceFile);
  if (!snapshot || snapshot.target.getText(sourceFile) !== target.getText(sourceFile)) return null;
  if (
    snapshot.binding &&
    !snapshotBindingIsReadOnly(snapshot.binding, spread, call)
  ) {
    return null;
  }

  const targetText = target.getText(sourceFile);
  if (ts.isShorthandPropertyAssignment(override)) {
    if (RESERVED_OBSERVABLE_MEMBERS.has(override.name.text)) return null;
    return objectWrite(
      `${targetText}.${override.name.text}.set(${override.name.text})`,
      targetText
    );
  }
  if (!ts.isPropertyAssignment(override)) return null;
  const argument = override.initializer.getText(sourceFile);
  if (ts.isIdentifier(override.name) || ts.isStringLiteral(override.name)) {
    const property = override.name.text;
    if (RESERVED_OBSERVABLE_MEMBERS.has(property)) return null;
    const child = ts.isIdentifier(override.name)
      ? `.${property}`
      : `[${override.name.getText(sourceFile)}]`;
    return objectWrite(`${targetText}${child}.set(${argument})`, targetText);
  }
  if (ts.isNumericLiteral(override.name)) {
    return objectWrite(
      `${targetText}[${override.name.getText(sourceFile)}].set(${argument})`,
      targetText
    );
  }
  if (!ts.isComputedPropertyName(override.name) || !safeDynamicKey(override.name.expression)) {
    return null;
  }
  const key = override.name.expression.getText(sourceFile);
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
  observableBindings: ReadonlySet<string>
): NarrowWrite | null {
  if (
    call.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "set"
  ) {
    return null;
  }
  const target = unwrapTransparentExpression(call.expression.expression);
  const root = rootIdentifier(target);
  if (
    !root ||
    !observableBindings.has(root.text) ||
    !observableTargetStartsAsArray(target, call, sourceFile)
  ) {
    return null;
  }

  const argument = unwrapTransparentExpression(call.arguments[0]!);
  const appended = ts.isArrowFunction(argument)
    ? updaterAppendValue(argument)
    : snapshotAppendValue(argument, target, call, sourceFile);
  if (!appended || !isEvaluationInert(appended)) return null;

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
    updater.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    updater.parameters.length !== 1 ||
    !ts.isIdentifier(updater.parameters[0]!.name) ||
    ts.isBlock(updater.body)
  ) {
    return null;
  }
  const array = unwrapTransparentExpression(updater.body);
  if (!ts.isArrayLiteralExpression(array) || array.elements.length !== 2) return null;
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
  target: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile
): ts.Expression | null {
  if (!ts.isArrayLiteralExpression(expression) || expression.elements.length !== 2) return null;
  const [spread, appended] = expression.elements;
  if (!spread || !ts.isSpreadElement(spread) || !appended || ts.isSpreadElement(appended)) {
    return null;
  }
  const snapshot = snapshotTarget(spread.expression, write, sourceFile);
  if (!snapshot || snapshot.target.getText(sourceFile) !== target.getText(sourceFile)) return null;
  if (
    snapshot.binding &&
    (!snapshotBindingIsReadOnly(snapshot.binding, spread, write) ||
      (ts.isIdentifier(snapshot.binding.declaration.name) &&
        expressionReferencesName(appended, snapshot.binding.declaration.name.text)))
  ) {
    return null;
  }
  return appended;
}

function observableTargetStartsAsArray(
  target: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile
): boolean {
  const root = rootIdentifier(target);
  if (!root) return false;
  const declaration = lexicalVariableDeclaration(write, root.text) ??
    uniqueVariableDeclaration(sourceFile, root.text);
  if (!declaration?.initializer) return false;
  const factory = unwrapTransparentExpression(declaration.initializer);
  if (!ts.isCallExpression(factory) || factory.arguments.length === 0) return false;
  let initializer: ts.Expression = factory.arguments[0]!;
  const properties = staticPropertyPath(target);
  if (!properties) return false;
  for (const propertyName of properties) {
    const object = unwrapTransparentExpression(initializer);
    if (!ts.isObjectLiteralExpression(object)) return false;
    const property = object.properties.find(candidate =>
      ts.isPropertyAssignment(candidate) && staticPropertyName(candidate.name) === propertyName
    );
    if (!property || !ts.isPropertyAssignment(property)) return false;
    initializer = property.initializer;
  }
  return ts.isArrayLiteralExpression(unwrapTransparentExpression(initializer));
}

function lexicalVariableDeclaration(node: ts.Node, name: string): ts.VariableDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isRuntimeFunctionLike(current) && current.body) {
      const declaration = uniqueVariableDeclaration(current.body, name);
      if (declaration) return declaration;
    }
    current = current.parent;
  }
  return null;
}

function staticPropertyPath(expression: ts.Expression): string[] | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) return [];
  if (!ts.isPropertyAccessExpression(value)) return null;
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
  visit(expression, node => {
    if (ts.isIdentifier(node) && node.text === name) found = true;
  });
  return found;
}

function snapshotTarget(
  expression: ts.Expression,
  write: ts.CallExpression,
  sourceFile: ts.SourceFile
): { binding: SnapshotBinding | null; target: ts.Expression } | null {
  const direct = peekTarget(expression);
  if (direct) return { binding: null, target: direct };
  const value = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(value)) return null;
  const owner = findAncestor(write, isRuntimeFunctionLike);
  if (!owner?.body || bindingDeclarationCount(owner, value.text) !== 1) return null;

  const resolved = uniqueVariableDeclaration(owner.body, value.text);
  if (
    !resolved?.initializer ||
    !ts.isVariableDeclarationList(resolved.parent) ||
    (resolved.parent.flags & ts.NodeFlags.Const) === 0 ||
    resolved.getStart(sourceFile) >= write.getStart(sourceFile)
  ) {
    return null;
  }
  const target = peekTarget(resolved.initializer);
  return target ? { binding: { declaration: resolved }, target } : null;
}

function peekTarget(expression: ts.Expression): ts.Expression | null {
  let value = unwrapTransparentExpression(expression);
  const fallback = ts.isBinaryExpression(value)
    ? unwrapTransparentExpression(value.right)
    : null;
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
  write: ts.CallExpression
): boolean {
  const owner = findAncestor(write, isRuntimeFunctionLike);
  if (!owner?.body || !ts.isIdentifier(binding.declaration.name)) return false;
  let crossesAsyncBoundary = false;
  visit(owner.body, node => {
    if (
      node.getStart() > binding.declaration.end &&
      node.end < write.getStart() &&
      (ts.isAwaitExpression(node) || ts.isYieldExpression(node))
    ) {
      crossesAsyncBoundary = true;
    }
  });
  if (crossesAsyncBoundary) return false;
  const name = binding.declaration.name.text;
  let safe = true;
  visit(owner.body, node => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      node === binding.declaration.name ||
      node.getStart() >= write.end
    ) {
      return;
    }
    if (nodeWithin(node, targetSpread.expression)) return;
    const access = outermostAccess(node);
    const parent = access.parent;
    if (
      (ts.isBinaryExpression(parent) &&
        parent.left === access &&
        isAssignmentOperator(parent.operatorToken.kind)) ||
      ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        parent.operand === access) ||
      (ts.isDeleteExpression(parent) && parent.expression === access) ||
      (access === node && ts.isCallExpression(parent) && parent.arguments.includes(access)) ||
      (access === node && ts.isNewExpression(parent) && parent.arguments?.includes(access) === true) ||
      (ts.isCallExpression(parent) && parent.expression === access) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === access) ||
      (ts.isSpreadElement(parent) && parent.expression === access)
    ) {
      safe = false;
    }
  });
  return safe;
}

function outermostAccess(root: ts.Identifier): ts.Expression {
  let current: ts.Expression = root;
  while (
    (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function safeDynamicKey(expression: ts.Expression): boolean {
  const key = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(key) || ts.isNumericLiteral(key)) return true;
  return ts.isStringLiteral(key) && !RESERVED_OBSERVABLE_MEMBERS.has(key.text);
}
