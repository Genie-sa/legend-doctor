import type {
  ChildContractResolver,
  ContextConsumerSource,
} from "../../rules/child-contract/model.js";
import type { StateCandidate, StateCluster } from "../model.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import { isNonValueIdentifier, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { SourceAnalysis } from "../proofs/contracts.js";
import { groupSettableStatesByOwner } from "../companion-writes.js";
import { stateMayHoldCallable } from "../../rules/state-proofs/state-proofs.js";
import ts from "typescript";

const MAX_LISTED_CONSUMER_FILES = 4;

const LISTED_PATH_SEGMENTS = 2;

const USE_MEMO_CALLEE = /(?:^|\.)useMemo$/u;

type ProviderElement = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

interface ContextProvider {
  readonly contextName: string;
  readonly element: ProviderElement;
  /** Context field name to the owner-local binding that fills it. */
  readonly fields: ReadonlyMap<string, string>;
}

interface HeldState {
  readonly fieldName: string;
  readonly setterFieldName: string | null;
  readonly state: StateCandidate;
}

interface ConsumerSurvey {
  readonly files: readonly string[];
  readonly reads: number;
}

interface ProviderScope {
  readonly analysis: SourceAnalysis;
  readonly childContracts: ChildContractResolver;
}

interface ClusterMessageScope {
  readonly sourceFile: ts.SourceFile;
  readonly survey: ConsumerSurvey;
}

/**
 * A provider component that keeps React state only to publish it through a context value re-renders
 * itself and every consumer on each write. When the value object is an owner-level literal, every
 * consumer reaches the context through an indexed reader hook and binds the fields by name, and the
 * provider never reads the state itself, and no other provider site supplies plain values for the same
 * context, the state can become an observable placed in the context value: the object stays referentially stable, consumers subscribe per field with `useValue`, and
 * writers call `set` without subscribing.
 */
export function findContextHeldStateClusters(
  analysis: SourceAnalysis,
): ReadonlyMap<StateCandidate, StateCluster> {
  const result = new Map<StateCandidate, StateCluster>();
  const { childContracts } = analysis;
  if (!childContracts) {
    return result;
  }
  for (const [owner, ownerStates] of groupSettableStatesByOwner(analysis.states)) {
    for (const provider of providersIn(owner)) {
      const cluster = providerCluster(provider, ownerStates, { analysis, childContracts });
      for (const member of cluster?.members ?? []) {
        result.set(member, cluster!);
      }
    }
  }
  return result;
}

function providerCluster(
  provider: ContextProvider,
  ownerStates: readonly StateCandidate[],
  { analysis, childContracts }: ProviderScope,
): StateCluster | null {
  const held = heldStates(provider, ownerStates);
  if (
    held.length === 0 ||
    childContracts.hasPlatformVariant() ||
    childContracts.contextProviderSites(provider.contextName) !== 1 ||
    !held.every((entry) => stateStaysInsideValue(entry, provider))
  ) {
    return null;
  }
  const survey = surveyConsumers(childContracts.contextConsumers(provider.contextName), held);
  if (!survey || survey.reads === 0) {
    return null;
  }
  return contextCluster(provider, held, { sourceFile: analysis.sourceFile, survey });
}

function providersIn(owner: RuntimeFunctionLike): ContextProvider[] {
  const providers: ContextProvider[] = [];
  visit(owner.body, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    const tag = node.tagName;
    if (
      !ts.isPropertyAccessExpression(tag) ||
      tag.name.text !== "Provider" ||
      !ts.isIdentifier(tag.expression) ||
      findAncestor(node, isRuntimeFunctionLike) !== owner
    ) {
      return;
    }
    const literal = providerValueLiteral(node, owner);
    const fields = literal ? objectFields(literal) : null;
    if (fields) {
      providers.push({ contextName: tag.expression.text, element: node, fields });
    }
  });
  return providers;
}

function providerValueLiteral(
  element: ProviderElement,
  owner: RuntimeFunctionLike,
): ts.ObjectLiteralExpression | null {
  const attribute = element.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === "value",
  );
  const expression =
    attribute && ts.isJsxAttribute(attribute) && attribute.initializer
      ? jsxExpressionValue(attribute.initializer)
      : null;
  return expression ? valueObjectLiteral(expression, owner) : null;
}

function jsxExpressionValue(initializer: ts.JsxAttributeValue): ts.Expression | null {
  return ts.isJsxExpression(initializer) ? (initializer.expression ?? null) : null;
}

/** The value literal itself, or the literal behind one owner-level `const`, optionally via `useMemo`. */
function valueObjectLiteral(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): ts.ObjectLiteralExpression | null {
  let current = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(current)) {
    const initializer = ownerConstInitializer(current.text, owner);
    if (!initializer) {
      return null;
    }
    current = unwrapTransparentExpression(initializer);
  }
  const memoBody = memoFactoryBody(current);
  if (memoBody) {
    current = unwrapTransparentExpression(memoBody);
  }
  return ts.isObjectLiteralExpression(current) ? current : null;
}

function memoFactoryBody(expression: ts.Expression): ts.Expression | null {
  if (!ts.isCallExpression(expression) || !USE_MEMO_CALLEE.test(expression.expression.getText())) {
    return null;
  }
  const [factory] = expression.arguments;
  return factory && ts.isArrowFunction(factory) && !ts.isBlock(factory.body) ? factory.body : null;
}

function ownerConstInitializer(name: string, owner: RuntimeFunctionLike): ts.Expression | null {
  let initializer: ts.Expression | null = null;
  let declarations = 0;
  visit(owner.body, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declarations += 1;
      initializer = node.initializer ?? null;
    }
  });
  return declarations === 1 ? initializer : null;
}

/** Field name to the identifier that fills it; an empty string marks a computed field. */
function objectFields(literal: ts.ObjectLiteralExpression): ReadonlyMap<string, string> | null {
  const fields = new Map<string, string>();
  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      fields.set(property.name.text, property.name.text);
    } else if (ts.isPropertyAssignment(property)) {
      const { initializer } = property;
      fields.set(property.name.getText(), ts.isIdentifier(initializer) ? initializer.text : "");
    } else {
      return null;
    }
  }
  return fields;
}

function heldStates(
  provider: ContextProvider,
  ownerStates: readonly StateCandidate[],
): readonly HeldState[] {
  const fieldByLocal = new Map([...provider.fields].map(([field, local]) => [local, field]));
  return ownerStates.flatMap((state) => {
    const fieldName = fieldByLocal.get(state.valueName);
    if (fieldName === undefined || stateMayHoldCallable(state)) {
      return [];
    }
    const setterFieldName = state.setterName ? (fieldByLocal.get(state.setterName) ?? null) : null;
    return [{ fieldName, setterFieldName, state }];
  });
}

/**
 * The provider may only write the state and hand it to the value object; a read anywhere else in
 * the provider would need its own subscription and is left to the per-state proofs.
 */
function stateStaysInsideValue({ state }: HeldState, provider: ContextProvider): boolean {
  let inside = true;
  visit(state.owner.body, (node) => {
    if (
      !inside ||
      !ts.isIdentifier(node) ||
      isNonValueIdentifier(node) ||
      nodeWithin(node, state.call.parent)
    ) {
      return;
    }
    if (node.text === state.valueName) {
      inside = isValueObjectField(node, state.owner) || nodeWithin(node, provider.element);
    } else if (node.text === state.setterName) {
      inside = isDirectCall(node) || isValueObjectField(node, state.owner);
    }
  });
  return inside;
}

function isDirectCall(node: ts.Identifier): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function isValueObjectField(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const { parent } = node;
  const property =
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === node)
      ? parent
      : null;
  if (property && ts.isObjectLiteralExpression(property.parent)) {
    return providerLiterals(owner).has(property.parent);
  }
  return isMemoDependency(node, owner);
}

const providerLiteralCache = new WeakMap<RuntimeFunctionLike, Set<ts.ObjectLiteralExpression>>();

function providerLiterals(owner: RuntimeFunctionLike): ReadonlySet<ts.ObjectLiteralExpression> {
  const cached = providerLiteralCache.get(owner);
  if (cached) {
    return cached;
  }
  const literals = new Set<ts.ObjectLiteralExpression>();
  for (const provider of providersIn(owner)) {
    const literal = providerValueLiteral(provider.element, owner);
    if (literal) {
      literals.add(literal);
    }
  }
  providerLiteralCache.set(owner, literals);
  return literals;
}

/** A `useMemo` dependency entry for the value object counts as part of the value object. */
function isMemoDependency(node: ts.Identifier, owner: RuntimeFunctionLike): boolean {
  const array = node.parent;
  const call = array.parent;
  return (
    ts.isArrayLiteralExpression(array) &&
    ts.isCallExpression(call) &&
    call.arguments[1] === array &&
    USE_MEMO_CALLEE.test(call.expression.getText()) &&
    findAncestor(call, isRuntimeFunctionLike) === owner
  );
}

function surveyConsumers(
  consumers: readonly ContextConsumerSource[],
  held: readonly HeldState[],
): ConsumerSurvey | null {
  if (consumers.length === 0) {
    return null;
  }
  const fieldNames = heldFieldNames(held);
  const counted = consumers.map((consumer) => [consumer.file, fieldReadsIn(consumer, fieldNames)]);
  if (counted.some(([, reads]) => reads === null)) {
    return null;
  }
  return {
    files: counted.filter(([, reads]) => Number(reads) > 0).map(([file]) => String(file)),
    reads: counted.reduce((total, [, reads]) => total + Number(reads), 0),
  };
}

function heldFieldNames(held: readonly HeldState[]): ReadonlySet<string> {
  return new Set(
    held.flatMap((entry) =>
      entry.setterFieldName ? [entry.fieldName, entry.setterFieldName] : [entry.fieldName],
    ),
  );
}

/**
 * Counts how many times a consumer reads the held fields; returns null when the context object
 * itself escapes (a rest binding, a whole-object use, or a hook result that is not bound by name),
 * because such a consumer could not be rewritten to per-field subscriptions.
 */
function fieldReadsIn(
  { hookNames, sourceFile }: ContextConsumerSource,
  fieldNames: ReadonlySet<string>,
): number | null {
  let reads = 0;
  let safe = true;
  visit(sourceFile, (node) => {
    if (
      !safe ||
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !hookNames.has(node.expression.text)
    ) {
      return;
    }
    const counted = readerCallFieldReads(node, fieldNames);
    if (counted === null) {
      safe = false;
    } else {
      reads += counted;
    }
  });
  return safe ? reads : null;
}

function readerCallFieldReads(
  call: ts.CallExpression,
  fieldNames: ReadonlySet<string>,
): number | null {
  const owner = findAncestor(call, isRuntimeFunctionLike);
  const declaration = call.parent;
  if (!owner || !ts.isVariableDeclaration(declaration) || declaration.initializer !== call) {
    return ts.isPropertyAccessExpression(call.parent) && fieldNames.has(call.parent.name.text)
      ? 1
      : null;
  }
  if (ts.isObjectBindingPattern(declaration.name)) {
    return destructuredFieldReads(declaration.name, owner, fieldNames);
  }
  return ts.isIdentifier(declaration.name)
    ? memberFieldReads(declaration.name, owner, fieldNames)
    : null;
}

function destructuredFieldReads(
  pattern: ts.ObjectBindingPattern,
  owner: RuntimeFunctionLike,
  fieldNames: ReadonlySet<string>,
): number | null {
  let reads = 0;
  for (const element of pattern.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      return null;
    }
    const field = (element.propertyName ?? element.name).getText();
    if (fieldNames.has(field)) {
      reads += identifierUses(owner, element.name);
    }
  }
  return reads;
}

function memberFieldReads(
  binding: ts.Identifier,
  owner: RuntimeFunctionLike,
  fieldNames: ReadonlySet<string>,
): number | null {
  let reads = 0;
  let safe = true;
  visit(owner.body, (node) => {
    if (!safe || !isReferenceTo(node, binding)) {
      return;
    }
    const { parent } = node;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      reads += fieldNames.has(parent.name.text) ? 1 : 0;
    } else {
      safe = false;
    }
  });
  return safe ? reads : null;
}

function isReferenceTo(node: ts.Node, binding: ts.Identifier): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    node.text === binding.text &&
    node !== binding &&
    !isNonValueIdentifier(node)
  );
}

function identifierUses(owner: RuntimeFunctionLike, binding: ts.Identifier): number {
  let uses = 0;
  visit(owner.body, (node) => {
    if (isReferenceTo(node, binding)) {
      uses += 1;
    }
  });
  return uses;
}

function contextCluster(
  provider: ContextProvider,
  held: readonly HeldState[],
  { sourceFile, survey }: ClusterMessageScope,
): StateCluster {
  const members = held
    .map((entry) => entry.state)
    .toSorted((left, right) => left.call.getStart() - right.call.getStart());
  const [primary] = members;
  const names = members.map((state) => state.valueName);
  return {
    action: "use-observable",
    id: `state-cluster:context:${primary!.owner.getStart(sourceFile)}:${provider.contextName}:${names.join(",")}`,
    members,
    message: contextMessage(provider.contextName, names, survey),
    primary: primary!,
  };
}

function contextMessage(
  contextName: string,
  names: readonly string[],
  survey: ConsumerSurvey,
): string {
  const quoted = names.map((name) => `\`${name}\``).join(", ");
  const observables = names.map((name) => `\`${name}$\``).join(", ");
  const listed = survey.files
    .slice(0, MAX_LISTED_CONSUMER_FILES)
    .map((file) => shortFileName(file))
    .join(", ");
  const hidden = survey.files.length - MAX_LISTED_CONSUMER_FILES;
  const more = hidden > 0 ? ` and ${hidden} more` : "";
  const plural = survey.files.length === 1 ? "" : "s";
  return `Replace the context-held React state (${quoted}) with observables published through \`${contextName}\`: create ${observables} with \`useObservable\` in the provider, put the observables themselves in the provider value so its identity no longer changes on writes, and turn each setter into the observable's \`set\`. In the ${survey.files.length} consumer file${plural} (${listed}${more}) replace each destructured field with \`useValue\` on that observable at the same statement, so a consumer re-renders only for the fields it reads and writers never subscribe; the provider stops rendering on these writes.`;
}

function shortFileName(file: string): string {
  return file.split("/").slice(-LISTED_PATH_SEGMENTS).join("/");
}
