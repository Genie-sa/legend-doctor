import { findAncestorUntil, visit } from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import { localCallableByName, localStateReadCallableNames } from "./local-callable-reads.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { isJsxNode } from "../state-proofs/callback-sites.js";
import ts from "typescript";

export function statePublishesReadOnlyGetter(state: StateCandidate): boolean {
  const getterNames = [...localStateReadCallableNames(state)].filter((name) => {
    const callback = localCallableByName(state.owner, name);
    if (!callback?.body) {
      return false;
    }
    return (
      !ts.isBlock(callback.body) ||
      (callback.body.statements.length === 1 && ts.isReturnStatement(callback.body.statements[0]!))
    );
  });
  return getterNames.some((name) => localBindingReachesReturnedJsxValue(state.owner, name));
}

function localBindingReachesReturnedJsxValue(owner: RuntimeFunctionLike, name: string): boolean {
  let published = false;
  visit(owner.body, (node) => {
    if (
      published ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (
      findAncestorUntil(node, ts.isReturnStatement, owner) &&
      !findAncestorUntil(node, isJsxNode, owner)
    ) {
      published = true;
      return;
    }
    if (isContextValueAttribute(findAncestorUntil(node, ts.isJsxAttribute, owner))) {
      published = true;
      return;
    }
    if (aliasReachesContextValue(node, owner)) {
      published = true;
    }
  });
  return published;
}

function aliasReachesContextValue(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return false;
  }
  const valueName = declaration.name.text;
  let published = false;
  visit(owner.body, (reference) => {
    if (
      published ||
      !ts.isIdentifier(reference) ||
      reference.text !== valueName ||
      reference === declaration.name ||
      isDeclarationName(reference) ||
      isNonValueIdentifier(reference)
    ) {
      return;
    }
    if (isContextValueAttribute(findAncestorUntil(reference, ts.isJsxAttribute, owner))) {
      published = true;
    }
  });
  return published;
}

function isContextValueAttribute(attribute: ts.JsxAttribute | null): boolean {
  return (
    attribute?.name.getText() === "value" &&
    jsxTargetName(attribute)?.endsWith(".Provider") === true
  );
}

function jsxTargetName(attribute: ts.JsxAttribute): string | null {
  const opening = attribute.parent;
  if (!ts.isJsxAttributes(opening)) {
    return null;
  }
  const element = opening.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return null;
  }
  return element.tagName.getText();
}
