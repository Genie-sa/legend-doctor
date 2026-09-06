import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  isPureExpression,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import {
  isSafeJsxProjectionReference,
  jsxElementCount,
  jsxElementCountIn,
} from "../state-proofs/jsx-subtrees.js";
import type { ObjectDraftProofs } from "./object-draft.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { hasIndependentRenderCutWitness } from "../state-proofs/render-cut-witness.js";
import { isRenderGateReference } from "../deferred-reveal/render-gates.js";
import ts from "typescript";

const MINIMUM_INDEPENDENT_SINKS = 2;

const MINIMUM_LEAF_JSX_ELEMENTS = 4;

const LEAF_JSX_ELEMENT_FRACTION = 0.4;

const MAXIMUM_PROJECTION_HOPS = 4;

export function independentDraftSinks(
  state: StateCandidate,
  directRenderNodes: readonly ts.Node[],
  properties: ReadonlySet<string>,
): readonly ts.Node[] | null {
  const sinks: ts.Node[] = [];
  for (const node of directRenderNodes) {
    const resolved = ts.isIdentifier(node) ? projectionSinks(state, node, properties) : null;
    if (!resolved || !collectLeafSinks(state, resolved, sinks)) {
      return null;
    }
  }
  return sinks;
}

function collectLeafSinks(
  state: StateCandidate,
  references: readonly ts.Identifier[],
  sinks: ts.Node[],
): boolean {
  const maximumLeafSize = Math.max(
    MINIMUM_LEAF_JSX_ELEMENTS,
    Math.floor(jsxElementCount(state.owner) * LEAF_JSX_ELEMENT_FRACTION),
  );
  for (const reference of references) {
    const subtree = nearestJsxElement(reference, state.owner);
    if (!subtree || jsxElementCountIn(subtree) > maximumLeafSize) {
      return false;
    }
    if (!sinks.includes(subtree)) {
      sinks.push(subtree);
    }
  }
  return true;
}

export function hasIndependentSinkWitness(
  proofs: ObjectDraftProofs,
  sinks: readonly ts.Node[] | null,
  owner: RuntimeFunctionLike,
): boolean {
  const returned = uniqueReturnedExpression(owner);
  return (
    sinks !== null &&
    returned !== null &&
    sinks.length >= MINIMUM_INDEPENDENT_SINKS &&
    hasIndependentRenderCutWitness({
      returned,
      excluded: sinks,
      localComponents: proofs.localComponents,
      sourceComponents: proofs.sourceComponents,
    })
  );
}

function projectionSinks(
  state: StateCandidate,
  initial: ts.Identifier,
  stringProperties: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  let references: readonly ts.Identifier[] = [initial];
  for (let hop = 0; hop < MAXIMUM_PROJECTION_HOPS; hop += 1) {
    if (references.every((reference) => nearestJsxElement(reference, state.owner))) {
      return references.every(
        (reference) =>
          !isRenderGateReference(reference, state.owner) &&
          isSafeJsxProjectionReference(reference, state.owner),
      )
        ? references
        : null;
    }
    const next = projectionHopReferences(state, references, stringProperties);
    if (!next) {
      return null;
    }
    references = next;
  }
  return null;
}

function projectionHopReferences(
  state: StateCandidate,
  references: readonly ts.Identifier[],
  stringProperties: ReadonlySet<string>,
): readonly ts.Identifier[] | null {
  const declarations = new Set(
    references.map((reference) =>
      findAncestorUntil(reference, ts.isVariableDeclaration, state.owner),
    ),
  );
  const declaration = declarations.size === 1 ? [...declarations][0] : null;
  if (
    !declaration?.initializer ||
    !ts.isIdentifier(declaration.name) ||
    !references.every((reference) => nodeWithin(reference, declaration.initializer!)) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(state.owner, declaration.name.text) !== 1 ||
    !isPureExpression(declaration.initializer, (call) =>
      safeStringTrim(call, state.valueName, stringProperties),
    )
  ) {
    return null;
  }
  const next = bindingReferences(state.owner, declaration.name);
  return next.length === 0 ? null : next;
}

function safeStringTrim(
  call: ts.CallExpression,
  stateName: string,
  stringProperties: ReadonlySet<string>,
): boolean {
  const callee = call.expression;
  const receiver = ts.isPropertyAccessExpression(callee)
    ? unwrapTransparentExpression(callee.expression)
    : null;
  return (
    call.arguments.length === 0 &&
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "trim" &&
    receiver !== null &&
    ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(unwrapTransparentExpression(receiver.expression)) &&
    receiver.expression.getText() === stateName &&
    stringProperties.has(receiver.name.text)
  );
}

function bindingReferences(owner: RuntimeFunctionLike, binding: ts.Identifier): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      node.text === binding.text &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function nearestJsxElement(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  return findAncestorUntil(
    node,
    (candidate): candidate is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate),
    owner,
  );
}

function uniqueReturnedExpression(owner: RuntimeFunctionLike): ts.Expression | null {
  if (!owner.body) {
    return null;
  }
  if (!ts.isBlock(owner.body)) {
    return owner.body;
  }
  const returns: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
    }
  });
  return returns.length === 1 ? returns[0]! : null;
}
