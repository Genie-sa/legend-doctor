import type { ObservableReadScan, UseValueDeclaration } from "./model.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { MoveDownTarget } from "./subscription-leaf-targets.js";
import type { SourceLocation } from "../../core/types.js";
import type { SubscriptionCut } from "../../core/subscriptions.js";
import type { SubscriptionFlow } from "./subscription-flow.js";
import { createHash } from "node:crypto";
import { isValueReferenceTo } from "./observable-paths.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";

export function subscriptionLocation(node: ts.Node, scan: ObservableReadScan): SourceLocation {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { file: scan.fileName, line: line + 1, column: character + 1 };
}

export function subscriptionOwner(use: UseValueDeclaration): string {
  const { owner } = use;
  if (!ts.isArrowFunction(owner) && owner.name) {
    return owner.name.getText();
  }
  return ts.isVariableDeclaration(owner.parent) ? owner.parent.name.getText() : "anonymous";
}

export function subscriptionCut(
  flow: SubscriptionFlow,
  targets: readonly MoveDownTarget[],
  scan: ObservableReadScan,
): SubscriptionCut {
  const { use } = flow;
  return {
    owner: subscriptionOwner(use),
    ownerLocation: subscriptionLocation(use.owner, scan),
    fingerprint: createHash("sha256").update(use.owner.getText()).digest("hex"),
    binding: use.localName,
    observable: use.observable.getText(),
    derivations: flow.derivations.map((item) => ({
      name: item.declaration.name.getText(),
      kind: item.kind,
      location: subscriptionLocation(item.declaration, scan),
    })),
    parentInputs: parentInputs(flow, targets),
    ownerJsxElements: targets[0]!.ownerElements,
    boundaries: targets.map((target) => ({
      location: subscriptionLocation(target.node, scan),
      start: target.node.getStart(),
      end: target.node.end,
      jsxElements: target.leafElements,
      kind: target.leaf ? "new-child" : "conditional-child",
      label: boundaryLabel(target.node),
    })),
  };
}

function boundaryLabel(node: ts.Node): string {
  if (ts.isJsxElement(node)) {
    return node.openingElement.tagName.getText();
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return node.tagName.getText();
  }
  return "conditional slot";
}

function parentInputs(flow: SubscriptionFlow, targets: readonly MoveDownTarget[]): string[] {
  const inputs = new Set<string>();
  for (const target of targets) {
    visit(target.node, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText();
        if (uniqueVariableDeclaration(flow.use.owner, tag)) {
          inputs.add(tag);
        }
      }
      if (
        !ts.isJsxExpression(node) ||
        !node.expression ||
        findAncestor(node, isRuntimeFunctionLike) !== flow.use.owner
      ) {
        return;
      }
      let dependent = false;
      visit(node.expression, (reference) => {
        for (const name of flow.names) {
          if (isValueReferenceTo(reference, name, flow.use.declaration.name)) {
            dependent = true;
          }
        }
      });
      if (!dependent) {
        inputs.add(node.expression.getText());
      }
    });
  }
  return [...inputs].toSorted();
}
