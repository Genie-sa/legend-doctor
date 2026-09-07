import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import {
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { EffectClassificationContext } from "./model.js";
import type { HostTagImports } from "../../core/imports.js";
import { findAncestor } from "../../core/ast.js";
import { isHostTag } from "../../core/imports.js";
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
  const initializer = state?.call.arguments[0];
  const usage = state ? context.usageBySetter.get(call.expression.text) : undefined;
  return state &&
    value &&
    initializer &&
    usage &&
    callback.parameters.length === 0 &&
    unwrapTransparentExpression(initializer).getText() ===
      unwrapTransparentExpression(value).getText() &&
    isTransparentDerivedValue(value, dependencies) &&
    usage.effectReads === 0 &&
    usage.deferredReads === 0 &&
    !usage.unstableTransport &&
    usage.transportedOccurrences === 0 &&
    hasOnlyLiveTextConsumers(usage, context.imports)
    ? state
    : null;
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

/** Text can refresh in place; attributes, projected aliases and element gates can own mount inputs. */
function hasOnlyLiveTextConsumers(usage: StateUsage, imports: HostTagImports): boolean {
  return (
    usage.directRenderNodes.length > 0 &&
    usage.directRenderNodes.every((node) => {
      const expression = findAncestor(node, ts.isJsxExpression);
      return (
        expression !== null &&
        !ts.isJsxAttribute(expression.parent) &&
        !containsElement(expression) &&
        !hasCapturingParent(expression, imports)
      );
    })
  );
}

function containsElement(node: ts.Node): boolean {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node) ||
    Boolean(node.forEachChild(containsElement))
  );
}

function hasCapturingParent(node: ts.Node, imports: HostTagImports): boolean {
  return (
    findAncestor(
      node,
      (ancestor): ancestor is ts.JsxElement =>
        ts.isJsxElement(ancestor) && !isHostTag(ancestor.openingElement.tagName.getText(), imports),
    ) !== null
  );
}
