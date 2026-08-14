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
import { findAncestor, isRuntimeFunctionLike, visit } from "../ast.js";
import type { HookImports } from "../imports.js";
import type { LegendPracticeFinding } from "../types.js";

const RESERVED_OBSERVABLE_MEMBERS = new Set([
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
  observableBindings: ReadonlySet<string>
): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, node => {
    if (ts.isCallExpression(node)) {
      const receiver = directUseValueObservable(node, imports, observableBindings);
      if (receiver) findings.push(directUseValueFinding(node, receiver, sourceFile, fileName));
    }
    if (ts.isVariableDeclaration(node)) {
      const finding = narrowUseValueFinding(node, imports, observableBindings, sourceFile, fileName);
      if (finding) findings.push(finding);
    }
  });
  return findings;
}

function directUseValueObservable(
  call: ts.CallExpression,
  imports: HookImports,
  observableBindings: ReadonlySet<string>
): ts.Expression | null {
  if (!isUseValueCall(call, imports)) return null;
  const selector = call.arguments[0]!;
  if (
    (!ts.isArrowFunction(selector) && !ts.isFunctionExpression(selector)) ||
    selector.parameters.length > 0 ||
    ts.isBlock(selector.body)
  ) {
    return null;
  }
  const read = unwrapTransparentExpression(selector.body);
  if (
    !ts.isCallExpression(read) ||
    read.arguments.length > 0 ||
    !ts.isPropertyAccessExpression(read.expression) ||
    read.expression.name.text !== "get"
  ) {
    return null;
  }
  return provenObservablePath(read.expression.expression, observableBindings);
}

function directUseValueFinding(
  call: ts.CallExpression,
  receiver: ts.Expression,
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  const path = receiver.getText(sourceFile);
  return {
    action: "pass-observable-to-use-value",
    confidence: "certain",
    disposition: "change",
    evidence: [
      "useValue selector only returns one zero-argument get() call",
      `${path} is a proven Legend observable path`,
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Replace \`useValue(() => ${path}.get())\` with \`useValue(${path})\`; the direct observable form keeps the same subscription with less code.`,
    practice: "reactivity",
  };
}

function narrowUseValueFinding(
  declaration: ts.VariableDeclaration,
  imports: HookImports,
  observableBindings: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding | null {
  const call = declaration.initializer;
  if (!call || !ts.isCallExpression(call) || !isUseValueCall(call, imports)) return null;
  const observable = provenObservablePath(call.arguments[0]!, observableBindings);
  if (!observable) return null;

  if (ts.isObjectBindingPattern(declaration.name)) {
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

  let property: string | null = null;
  let reads = 0;
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
    const access = node.parent;
    if (
      !ts.isPropertyAccessExpression(access) ||
      access.expression !== node ||
      access.questionDotToken ||
      propertyAccessIsExecutableOrWritten(access)
    ) {
      unsafe = true;
      return;
    }
    if (RESERVED_OBSERVABLE_MEMBERS.has(access.name.text)) {
      unsafe = true;
      return;
    }
    property ??= access.name.text;
    if (property !== access.name.text) {
      unsafe = true;
      return;
    }
    reads += 1;
  });
  if (unsafe || reads === 0 || !property) return null;
  return narrowFinding(
    declaration,
    observable,
    property,
    localName,
    reads,
    sourceFile,
    fileName
  );
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
  sourceFile: ts.SourceFile,
  fileName: string
): LegendPracticeFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
  const parentPath = observable.getText(sourceFile);
  const leafPath = `${parentPath}.${property}`;
  return {
    action: "narrow-use-value-subscription",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `the value from ${parentPath} is read only through the static \`${property}\` property`,
      `${leafPath} is a proven Legend observable path and has ${reads} raw-value read${reads === 1 ? "" : "s"}`,
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: `Narrow \`${localName}\` from \`useValue(${parentPath})\` to \`useValue(${leafPath})\`; bind the leaf value directly and replace the \`${localName}.${property}\` reads so sibling observable fields no longer invalidate this component.`,
    practice: "reactivity",
  };
}

function isUseValueCall(call: ts.CallExpression, imports: HookImports): boolean {
  return call.arguments.length === 1 &&
    ts.isIdentifier(call.expression) &&
    imports.useValue.has(call.expression.text);
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
  const root = rootIdentifier(path);
  return root && observableBindings.has(root.text) ? path : null;
}

function propertyAccessIsExecutableOrWritten(access: ts.PropertyAccessExpression): boolean {
  const parent = access.parent;
  return (
    (ts.isCallExpression(parent) && parent.expression === access) ||
    (ts.isNewExpression(parent) && parent.expression === access) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === access) ||
    (ts.isBinaryExpression(parent) && parent.left === access && isAssignmentOperator(parent.operatorToken.kind)) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operand === access &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    (ts.isPostfixUnaryExpression(parent) && parent.operand === access) ||
    (ts.isDeleteExpression(parent) && parent.expression === access)
  );
}
