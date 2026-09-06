import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { EffectClassificationContext } from "./model.js";
import { soleDirectSetterCall } from "./callback-shape.js";
import ts from "typescript";

export function findPureDerivedSetter(
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
