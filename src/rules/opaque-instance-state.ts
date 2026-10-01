import type { ClassifiedState, StateCandidate } from "../analysis/model.js";
import { identifiersNamed, visit } from "../core/ast.js";
import { lexicalBinding } from "../core/lexical-bindings.js";
import { localDeclarations } from "./callable-state.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../core/analysis-ast.js";

const DOM_INSTANCE_TYPE =
  /^(?:(?:HTML|MathML|SVG)\w*Element|CharacterData|ChildNode|Comment|Document|DocumentFragment|Element|EventTarget|Node|ParentNode|ShadowRoot|Text|Window)$/u;

/**
 * Legend walks the own keys of every stored object without an opaque hint, and a DOM node or ref
 * target React has attached leads through them into the cyclic fiber graph, overflowing the stack.
 */
export function stateMayHoldOpaqueInstance(state: StateCandidate): boolean {
  const type = state.call.typeArguments?.[0];
  return (type !== undefined && typeNamesDomInstance(type)) || setterIsRefTarget(state);
}

export function opaqueInstanceOverride(
  state: StateCandidate,
  action: ClassifiedState["action"],
): ClassifiedState | null {
  return (action === "use-observable" || action === "review-state") &&
    stateMayHoldOpaqueInstance(state)
    ? {
        action: "keep-state",
        confidence: "probable",
        message: `Keep \`${state.valueName}\` as React state; it can hold a DOM node or other ref target, which an observable cannot store: \`set\` walks its own keys into React's cyclic fiber graph until the stack overflows.`,
      }
    : null;
}

/** A global DOM type the file does not shadow with its own declaration. */
function typeNamesDomInstance(type: ts.TypeNode): boolean {
  const { types } = localDeclarations(type.getSourceFile());
  let found = false;
  visit(type, (node) => {
    found ||=
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      DOM_INSTANCE_TYPE.test(node.typeName.text) &&
      !types.has(node.typeName.text);
  });
  return found;
}

function setterIsRefTarget({ owner, setterName }: StateCandidate): boolean {
  let target = false;
  visit(owner.body, (node) => {
    if (target || !setterName || !ts.isJsxAttribute(node) || node.name.getText() !== "ref") {
      return;
    }
    const value =
      node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression;
    const ref = value ? unwrapTransparentExpression(value) : undefined;
    const binding = ref && ts.isIdentifier(ref) ? lexicalBinding(ref) : null;
    const scope = binding?.kind === "function" ? binding.declaration : ref;
    target = identifiersNamed(scope, setterName).some((setter) => storesRefTarget(setter));
  });
  return target;
}

/** Passed on as a value, or called with a bare identifier such as the callback ref's node. */
function storesRefTarget(setter: ts.Identifier): boolean {
  const call = setter.parent;
  const [argument] =
    ts.isCallExpression(call) && call.expression === setter ? call.arguments : [setter];
  return argument !== undefined && ts.isIdentifier(unwrapTransparentExpression(argument));
}
