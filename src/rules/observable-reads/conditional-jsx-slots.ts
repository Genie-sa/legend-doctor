import {
  bindingDeclarationCount,
  isAssignmentOperator,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { visit, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingContainsName } from "../state-proofs/binding-lookup.js";
import { hasUnstableSubtreeLifetime } from "../state-proofs/jsx-subtrees.js";
import { isImportedHookCall } from "../../core/imports.js";
import { isUseValueCall } from "./observable-paths.js";
import ts from "typescript";

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

export function stableConditionalJsxSlot(
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
    isImportedHookCall({
      call: initializer,
      localNames: ownership.imports.useState,
      namespaceNames: ownership.imports.reactNamespaces,
      canonicalName: "useState",
    })
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

export function isInsideOwnerReturn(node: ts.Node, owner: RuntimeFunctionLike): boolean {
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
