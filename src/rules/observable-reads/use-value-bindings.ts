import type { ObservableReadScan, UseValueDeclaration } from "./model.js";
import type { SelectorModelBlocker, SelectorSubscription } from "./selector-subscriptions.js";
import { findAncestor, isRuntimeFunctionLike } from "../../core/ast.js";
import { identifiedUseValueDeclaration, provenObservablePath } from "./observable-paths.js";
import { isSelectorFunction, selectorModel } from "./selector-subscriptions.js";
import { outermostTransparentParent } from "../../core/analysis-ast.js";
import ts from "typescript";

export type UseValueBindingBlocker =
  | SelectorModelBlocker
  | "destructured-result"
  | "observable-binding-not-proven"
  | "owner-not-proven"
  | "returned-result"
  | "use-value-options"
  | "wrapped-result";

/** How one `useValue` call binds its value, for inventory reporting. */
export type UseValueBinding =
  | { readonly kind: "observable"; readonly use: UseValueDeclaration }
  | {
      readonly kind: "selector";
      readonly use: UseValueDeclaration;
      readonly selector: SelectorSubscription;
    }
  | { readonly kind: "unproven"; readonly blocker: UseValueBindingBlocker };

export function useValueBinding(
  call: ts.CallExpression,
  scan: ObservableReadScan,
): UseValueBinding {
  const [input] = call.arguments;
  if (!input || call.arguments.length > 1) {
    return { kind: "unproven", blocker: "use-value-options" };
  }
  const declaration = ts.isVariableDeclaration(call.parent) ? call.parent : null;
  const use = declaration && identifiedUseValueDeclaration(declaration, scan);
  if (use) {
    return { kind: "observable", use };
  }
  if (isSelectorFunction(input)) {
    return selectorBinding(call, input, scan);
  }
  return {
    kind: "unproven",
    blocker: provenObservablePath(input, scan.observableBindings)
      ? resultPlacementBlocker(call)
      : "observable-binding-not-proven",
  };
}

function selectorBinding(
  call: ts.CallExpression,
  selector: ts.ArrowFunction | ts.FunctionExpression,
  scan: ObservableReadScan,
): UseValueBinding {
  const model = selectorModel(selector, scan);
  if (model.kind === "unproven") {
    return model;
  }
  const declaration = call.parent;
  const owner = findAncestor(call, isRuntimeFunctionLike);
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !owner?.body
  ) {
    return { kind: "unproven", blocker: resultPlacementBlocker(call) };
  }
  return {
    kind: "selector",
    selector: model.subscription,
    use: { call, declaration, localName: declaration.name.text, observable: selector, owner },
  };
}

function resultPlacementBlocker(call: ts.CallExpression): UseValueBindingBlocker {
  const placement = outermostTransparentParent(call);
  const { parent } = placement;
  if (ts.isVariableDeclaration(parent) && parent.initializer === placement) {
    if (!ts.isIdentifier(parent.name)) {
      return "destructured-result";
    }
    return placement === call ? "owner-not-proven" : "wrapped-result";
  }
  return ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === placement)
    ? "returned-result"
    : "wrapped-result";
}
