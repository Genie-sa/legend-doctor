import { collectBindingNames, rootIdentifier } from "../../core/analysis-ast.js";
import {
  nearestNestedFunction,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { RenderReach } from "./render-reach.js";
import type { RenderTrigger } from "./render-triggers.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingDeclaration } from "./identity-model.js";
import { bindingKey } from "./render-reach.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

/** What the element renders from besides its fresh allocations. */
export interface ElementInputs {
  /** An owner prop reaches the element, so a parent callback can change it in the same render. */
  readonly readsProps: boolean;
  readonly readTriggers: readonly RenderTrigger[];
}

export function readsOwnerProps(reach: RenderReach, owner: RuntimeFunctionLike): boolean {
  return owner.parameters.some((parameter) => {
    const names = new Set<string>();
    collectBindingNames(parameter.name, names);
    return [...names].some((name) => reach.bindings.has(bindingKey(parameter, name)));
  });
}

/**
 * Whether some write of the trigger renders the owner while every input of the element keeps its
 * value: a setter call whose handler writes no such input, or the setter handed to another element.
 */
export function triggerChangesAlone(
  trigger: RenderTrigger,
  inputs: ElementInputs,
  owner: RuntimeFunctionLike,
): boolean {
  if (inputs.readTriggers.length === 0 && !inputs.readsProps) {
    return true;
  }
  const { setter } = trigger;
  return (
    setter !== null &&
    ownerLevelReferences(owner, setter).some((reference) => writesAlone(reference, inputs, owner))
  );
}

function writesAlone(
  reference: ts.Identifier,
  inputs: ElementInputs,
  owner: RuntimeFunctionLike,
): boolean {
  const { parent } = reference;
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    return !passesInputSetter(parent.parent.parent, inputs.readTriggers);
  }
  if (!ts.isCallExpression(parent) || parent.expression !== reference) {
    return false;
  }
  const handler = nearestNestedFunction(parent, owner) ?? owner;
  return !writesInput(handler, inputs, owner);
}

function passesInputSetter(
  attributes: ts.JsxAttributes,
  triggers: readonly RenderTrigger[],
): boolean {
  let passes = false;
  visit(attributes, (node) => {
    passes ||= ts.isIdentifier(node) && writesTrigger(node, triggers);
  });
  return passes;
}

function writesInput(
  handler: RuntimeFunctionLike,
  inputs: ElementInputs,
  owner: RuntimeFunctionLike,
): boolean {
  let writes = false;
  visitSkippingNestedRuntimeFunctions(handler.body ?? handler, (node) => {
    const callee = ts.isCallExpression(node) ? rootIdentifier(node.expression) : null;
    writes ||=
      callee !== null &&
      (writesTrigger(callee, inputs.readTriggers) ||
        (inputs.readsProps && derivesFromOwnerProps(callee, owner, new Set())));
  });
  return writes;
}

function writesTrigger(identifier: ts.Identifier, triggers: readonly RenderTrigger[]): boolean {
  const declaration = bindingDeclaration(lexicalBinding(identifier));
  return triggers.some(
    (trigger) => trigger.declaration === declaration && trigger.setter?.text === identifier.text,
  );
}

/** A prop callback, read from the owner's parameters directly or through `const` destructuring. */
function derivesFromOwnerProps(
  identifier: ts.Identifier,
  owner: RuntimeFunctionLike,
  visited: Set<ts.Node>,
): boolean {
  const declaration = bindingDeclaration(lexicalBinding(identifier));
  if (!declaration || visited.has(declaration)) {
    return false;
  }
  visited.add(declaration);
  if (ts.isParameter(declaration)) {
    return declaration.parent === owner;
  }
  const source =
    ts.isVariableDeclaration(declaration) && declaration.initializer
      ? rootIdentifier(declaration.initializer)
      : null;
  return source !== null && derivesFromOwnerProps(source, owner, visited);
}
