import {
  isEvaluationInert,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { observableSetTarget, observableTargetStartsAsArray } from "./observable-targets.js";
import { snapshotBindingIsReadOnly, snapshotTarget } from "./snapshot-bindings.js";
import type { ArrayOriginScan } from "./observable-targets.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { RESERVED_OBSERVABLE_MEMBERS } from "../observable-reads/observable-paths.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

const SPREAD_WITH_ONE_MEMBER = 2;

interface NarrowWrite {
  evidence: readonly [string, string];
  message: string;
}

interface SnapshotAppendContext {
  sourceFile: ts.SourceFile;
  target: ts.Expression;
  write: ts.CallExpression;
}

export interface CloneWriteScan extends ArrayOriginScan {
  readonly fileName: string;
  readonly observableBindings: ReadonlySet<string>;
}

export function findObservableCloneWritePractices(scan: CloneWriteScan): LegendPracticeFinding[] {
  const { fileName, observableBindings, sourceFile } = scan;
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const write =
      narrowObservableObjectWrite(node, sourceFile, observableBindings) ??
      narrowObservableArrayAppend(node, scan);
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
  scan: CloneWriteScan,
): NarrowWrite | null {
  const { observableBindings, sourceFile } = scan;
  const target = observableSetTarget(call, observableBindings);
  if (!target || !rootIdentifier(target) || !observableTargetStartsAsArray(target, call, scan)) {
    return null;
  }
  const appended = appendedArrayValue(call, target, sourceFile);
  if (!appended || !isEvaluationInert(appended)) {
    return null;
  }
  const targetText = target.getText(sourceFile);
  const appendedText = appended.getText(sourceFile);
  return {
    evidence: [
      `the clone appends exactly one inert value to the same proven observable array ${targetText}`,
      "the observable path is initialized as an array where it is declared and no sort, filter, slice, prepend, or spread transform is present",
    ],
    message: `Replace this cloned-array write with \`${targetText}.push(${appendedText})\`; append directly so Legend preserves the array and avoids cloning or replacing unaffected entries.`,
  };
}

function appendedArrayValue(
  call: ts.CallExpression,
  target: ts.Expression,
  sourceFile: ts.SourceFile,
): ts.Expression | null {
  const argument = unwrapTransparentExpression(call.arguments[0]!);
  return ts.isArrowFunction(argument)
    ? updaterAppendValue(argument)
    : snapshotAppendValue(argument, { sourceFile, target, write: call });
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

function expressionReferencesName(expression: ts.Expression, name: string): boolean {
  let found = false;
  visit(expression, (node) => {
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
    }
  });
  return found;
}

function safeDynamicKey(expression: ts.Expression): boolean {
  const key = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(key) || ts.isNumericLiteral(key)) {
    return true;
  }
  return ts.isStringLiteral(key) && !RESERVED_OBSERVABLE_MEMBERS.has(key.text);
}
