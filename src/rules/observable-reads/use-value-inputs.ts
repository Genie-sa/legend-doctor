import {
  RESERVED_OBSERVABLE_MEMBERS,
  directGetReceiver,
  directObservableReadPath,
  isUseValueCall,
  provenObservablePath,
} from "./observable-paths.js";
import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableReadScan } from "./model.js";
import ts from "typescript";

interface DirectUseValueInput {
  kind: "eager-read" | "selector";
  observable: ts.Expression;
}

export function directUseValueInput(
  call: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
): DirectUseValueInput | null {
  // Direct inputs forward options to get(); eager and callback reads do not inherit them.
  if (!isUseValueCall(call, imports) || call.arguments.length !== 1) {
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
    selector.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
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

export function directUseValueFinding(
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
    disposition: eager ? "change" : "style",
    evidence: [
      eager
        ? "the observable is read with get() before useValue receives its input"
        : "useValue selector only returns one zero-argument get() call",
      `${path} is a proven Legend observable path`,
      ...(eager
        ? [
            "direct input establishes useValue tracking outside observer, or reuses enclosing observer tracking without an empty selector subscription",
          ]
        : [
            "the selected observable value is retained without hook options; no render or lifecycle saving is proven",
            "inside observer, direct inputs use observer subscription ownership instead of a separate selector hook",
          ]),
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Replace \`${current}\` with \`${replacement}\`; the direct observable form ${eager ? "provides reactive input directly, reusing observer tracking when present" : "reads the same observable with less code"}.`,
    practice: "reactivity",
  };
}
