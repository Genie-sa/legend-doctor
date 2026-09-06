import type { ControlledFilterLeafCut, StateCandidate, StateUsage } from "../model.js";
import { MIN_COLLECTION_RENDER_WORK, MIN_OWNER_RENDER_CUT_ELEMENTS } from "../constants.js";
import {
  bindingReferences,
  collectionBindingIsReadOnly,
  commonContainingRepeatedRender,
  directReturnedJsxSlot,
  isReadOnlyFilteredResultReference,
  renderCollectionWorkOutside,
  repeatedRenderBinding,
} from "./collection-work.js";
import { findAncestorUntil, visit } from "../../core/ast.js";
import {
  isDeclarationName,
  isDirectJsxAttributeExpression,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { jsxElementCount, jsxElementCountIn } from "../../rules/state-proofs/jsx-subtrees.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { ExactStringFilter } from "./string-filter.js";
import type { MaterialityPolicy } from "../constants.js";
import { exactStringFilter } from "./string-filter.js";
import { jsxTargetName } from "../ast-helpers.js";
import ts from "typescript";

function stateIsTransportedFilterTerm(state: StateCandidate, usage: StateUsage): boolean {
  return (
    state.setterName !== null &&
    ts.isStringLiteralLike(unwrapTransparentExpression(state.call.arguments[0] ?? state.call)) &&
    usage.setterReferences === 1 &&
    usage.setterCalls === 0 &&
    usage.setterTransportSites.size === 1 &&
    usage.setterTargets.size === 1 &&
    usage.valueTransportSites.size === 0 &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    !usage.shadowed
  );
}

function readOnlyFilterResultReferences(
  state: StateCandidate,
  filter: ExactStringFilter,
): readonly ts.Identifier[] | null {
  const references = bindingReferences(state.owner, filter.resultName.text, filter.resultName);
  if (
    references.length === 0 ||
    references.some((reference) => !isReadOnlyFilteredResultReference(reference, state.owner))
  ) {
    return null;
  }
  return references;
}

export interface FilterLeafCutScope {
  readonly childContracts: ChildContractResolver | null;
  readonly materiality: MaterialityPolicy;
}

export function controlledFilterLeafCut(
  state: StateCandidate,
  usage: StateUsage,
  { childContracts, materiality }: FilterLeafCutScope,
): ControlledFilterLeafCut | null {
  if (!childContracts || !stateIsTransportedFilterTerm(state, usage)) {
    return null;
  }
  const setterTransport = deferredSetterTransport(state, childContracts);
  const filter = setterTransport ? soleReadOnlyStringFilter(state) : null;
  const resultReferences = filter ? readOnlyFilterResultReferences(state, filter) : null;
  if (!setterTransport || !filter || !resultReferences) {
    return null;
  }
  const slot = repeatedProducerRenderCut(state, { filter, materiality }, [
    setterTransport.reference,
    ...resultReferences,
  ]);
  return slot
    ? {
        line:
          slot.node.getSourceFile().getLineAndCharacterOfPosition(slot.node.getStart()).line + 1,
        producer: slot.producer,
        target: setterTransport.target,
      }
    : null;
}

function deferredSetterTransport(
  state: StateCandidate,
  childContracts: ChildContractResolver,
): SetterTransport | null {
  const setterTransport = directSetterTransport(state);
  if (
    !setterTransport ||
    !childContracts.componentCallbackPropIsDeferred(
      setterTransport.target,
      setterTransport.attribute.name.getText(),
    )
  ) {
    return null;
  }
  return setterTransport;
}

function soleReadOnlyStringFilter(state: StateCandidate): ExactStringFilter | null {
  const reads = stateValueReferences(state);
  const filter = reads.length === 1 ? exactStringFilter(reads[0]!, state.owner) : null;
  return filter && collectionBindingIsReadOnly(filter.sourceName, state.owner) ? filter : null;
}

interface RepeatedProducerSlot {
  readonly node: ts.Node;
  readonly producer: string;
}

interface ProducerCutScope {
  readonly filter: ExactStringFilter;
  readonly materiality: MaterialityPolicy;
}

function repeatedProducerRenderCut(
  state: StateCandidate,
  { filter, materiality }: ProducerCutScope,
  references: readonly ts.Node[],
): RepeatedProducerSlot | null {
  const repeated = commonContainingRepeatedRender(references, state.owner);
  const producer = repeated ? repeatedRenderBinding(repeated, state.owner) : null;
  const producerReferences = producer
    ? bindingReferences(state.owner, producer.text, producer)
    : [];
  const slot =
    producerReferences.length === 1
      ? directReturnedJsxSlot(producerReferences[0]!, state.owner)
      : null;
  const ownerElements = jsxElementCount(state.owner);
  const producerElements = repeated ? jsxElementCountIn(repeated) : ownerElements;
  if (
    !repeated ||
    !producer ||
    !slot ||
    ownerElements < materiality.broadOwnerJsx ||
    ownerElements - producerElements < MIN_OWNER_RENDER_CUT_ELEMENTS ||
    renderCollectionWorkOutside(state.owner, repeated, filter.call) < MIN_COLLECTION_RENDER_WORK
  ) {
    return null;
  }
  return { node: slot, producer: producer.text };
}

interface SetterTransport {
  readonly attribute: ts.JsxAttribute;
  readonly reference: ts.Identifier;
  readonly target: string;
}

export function directSetterTransport(state: StateCandidate): SetterTransport | null {
  if (!state.setterName || !state.owner.body) {
    return null;
  }
  const matches: {
    attribute: ts.JsxAttribute;
    reference: ts.Identifier;
    target: string;
  }[] = [];
  visit(state.owner.body, (node) => {
    if (
      !ts.isIdentifier(node) ||
      node.text !== state.setterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const attribute = findAncestorUntil(node, ts.isJsxAttribute, state.owner);
    const target = attribute ? jsxTargetName(attribute) : null;
    if (attribute && target && isDirectJsxAttributeExpression(attribute, node)) {
      matches.push({ attribute, reference: node, target });
    }
  });
  return matches.length === 1 ? matches[0]! : null;
}

function stateValueReferences(state: StateCandidate): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(state.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === state.valueName &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node) &&
      node.parent !== state.call.parent
    ) {
      references.push(node);
    }
  });
  return references;
}
