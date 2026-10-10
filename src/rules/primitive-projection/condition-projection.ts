import type { LegendPracticeFinding, TextEdit } from "../../core/types.js";
import type {
  MergedProjection,
  ProjectionScan,
  RawSubscription,
  SelectorBinding,
} from "./projection-subscriptions.js";
import {
  capitalized,
  isNameTaken,
  mergedProjection,
  rendersOnSameChange,
  selectorEdits,
} from "./projection-subscriptions.js";
import { isNegation, truthinessSites } from "./truthiness-sites.js";
import { isNullishLiteral, projectionSites } from "./projection-sites.js";
import { rangeHasComment, replaceNode, replaceRange } from "../../core/text-edits.js";
import type { ConditionSite } from "./condition-sites.js";
import type { DomainValues } from "./value-domains.js";
import { conditionSites } from "./condition-sites.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import { observableValueSource } from "./projection-domain.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import { sourceDomainValues } from "./value-domains.js";
import ts from "typescript";
import { untrackedRenderReads } from "../observable-reads/untracked-render-reads.js";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

type ConditionGroup = readonly [ConditionSite, ...ConditionSite[]];

/** Every copy of one condition, the binding its selector initializes, and the `const` it replaces. */
interface SelectedCondition {
  readonly merged: MergedProjection | null;
  readonly name: string;
  readonly sites: ConditionGroup;
}

/** How the domain's values fall into the joint outcomes of the conditions. */
type OutcomeProof =
  | { readonly kind: "finite"; readonly outcomes: number; readonly values: number }
  | { readonly kind: "object" | "unbounded" };

interface ConditionProjection {
  readonly conditions: readonly [SelectedCondition, ...SelectedCondition[]];
  readonly proof: OutcomeProof;
  readonly raw: RawSubscription;
}

type Primitive = bigint | boolean | number | string | null | undefined;

/** An evaluated operand, or `null` when the expression is not a literal comparison. */
type Evaluation = { readonly value: Primitive } | null;

const OUTCOMES_PER_CONDITION = 2;

const OPERATIONS = new Map<ts.SyntaxKind, (left: Primitive, right: Primitive) => Primitive>([
  [ts.SyntaxKind.AmpersandAmpersandToken, (left, right): Primitive => left && right],
  [ts.SyntaxKind.BarBarToken, (left, right): Primitive => left || right],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, (left, right): boolean => left === right],
  [ts.SyntaxKind.EqualsEqualsToken, looselyEqual],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, (left, right): boolean => left !== right],
  [ts.SyntaxKind.ExclamationEqualsToken, (left, right): boolean => !looselyEqual(left, right)],
]);

const KEYWORD_VALUES = new Map<string, Primitive>([
  ["false", false],
  ["null", null],
  ["true", true],
  ["undefined", undefined],
]);

/** A chain of data members from the raw value, named for a fresh binding. */
interface ChainName {
  /** The chain ends in `length` or `size`. */
  readonly counted: boolean;
  readonly path: string;
}

const IDENTIFIER_WORD = /^[A-Za-z][A-Za-z0-9]*$/u;

const MIRRORED_OPERATORS = new Map<ts.SyntaxKind, ts.SyntaxKind>([
  [ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanEqualsToken],
  [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken],
  [ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken],
  [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken],
]);

const COMPARISON_SUFFIXES = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "Matches"],
  [ts.SyntaxKind.EqualsEqualsToken, "Matches"],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "Differs"],
  [ts.SyntaxKind.ExclamationEqualsToken, "Differs"],
  [ts.SyntaxKind.GreaterThanEqualsToken, "Exceeds"],
  [ts.SyntaxKind.GreaterThanToken, "Exceeds"],
  [ts.SyntaxKind.LessThanEqualsToken, "Below"],
  [ts.SyntaxKind.LessThanToken, "Below"],
]);

/** Count tests against `0` or `1`, keyed by operator and literal, that ask for presence or emptiness. */
const COUNT_TESTS = new Map<string, "empty" | "present">([
  [`${ts.SyntaxKind.GreaterThanToken}:0`, "present"],
  [`${ts.SyntaxKind.ExclamationEqualsEqualsToken}:0`, "present"],
  [`${ts.SyntaxKind.ExclamationEqualsToken}:0`, "present"],
  [`${ts.SyntaxKind.GreaterThanEqualsToken}:1`, "present"],
  [`${ts.SyntaxKind.EqualsEqualsEqualsToken}:0`, "empty"],
  [`${ts.SyntaxKind.EqualsEqualsToken}:0`, "empty"],
  [`${ts.SyntaxKind.LessThanEqualsToken}:0`, "empty"],
  [`${ts.SyntaxKind.LessThanToken}:1`, "empty"],
]);

/**
 * A render subscribes to a whole observable value but reads it only through boolean conditions:
 * member and count comparisons, read-only predicates, and `&&`/`||` joins of them. Selecting one
 * boolean per distinct condition renders the owner only when one of them flips. Values the
 * uniform comparison and truthiness projections cover are left to them.
 */
export function conditionProjectionFinding(
  raw: RawSubscription,
  scan: ProjectionScan,
): LegendPracticeFinding | null {
  const { owner } = raw.owner;
  const source =
    projectionSites(owner, raw.declaration.name, scan.imports) ||
    truthinessSites(owner, raw.declaration.name)
      ? null
      : observableValueSource(raw.observable, scan);
  const domain = source ? sourceDomainValues(source) : null;
  const groups = source ? groupedSites(conditionSites(raw, source) ?? []) : [];
  const proof = domain && groups.length > 0 ? outcomeProof(domain, groups) : null;
  if (!proof || rendersOnSameChange(raw, scan) || untrackedRenderReads(owner, scan).length > 0) {
    return null;
  }
  const conditions = namedConditions(raw, groups);
  return conditions ? projectionFinding({ conditions, proof, raw }, scan) : null;
}

function groupedSites(sites: readonly ConditionSite[]): readonly ConditionGroup[] {
  const groups = new Map<string, [ConditionSite, ...ConditionSite[]]>();
  for (const site of sites) {
    const key = site.condition.getText();
    const group = groups.get(key);
    if (group) {
      group.push(site);
    } else {
      groups.set(key, [site]);
    }
  }
  return [...groups.values()];
}

/**
 * Some change of the value leaves every condition's boolean unchanged: an object domain holds
 * distinct values with equal members, an unbounded one outnumbers any finite set of outcomes, and
 * a finite one either evaluates to fewer joint outcomes than values or, when a condition reads
 * more than literals, holds more values than its conditions have outcome combinations.
 */
function outcomeProof(
  domain: DomainValues,
  groups: readonly ConditionGroup[],
): OutcomeProof | null {
  if (domain.objects) {
    return { kind: "object" };
  }
  if (domain.primitives === null) {
    return { kind: "unbounded" };
  }
  const values = [...domain.primitives].map((literal) => literalValue(literal));
  const keys = values.map((value) => outcomeKey(value, groups));
  const outcomes = keys.every((key) => key !== null)
    ? new Set(keys).size
    : OUTCOMES_PER_CONDITION ** groups.length;
  return outcomes < values.length ? { kind: "finite", outcomes, values: values.length } : null;
}

/** Each condition's boolean for one value, or null when a condition does not evaluate. */
function outcomeKey(value: Primitive, groups: readonly ConditionGroup[]): string | null {
  const booleans = groups.map(([site]) => evaluate(site.condition, value, site));
  return booleans.every((evaluation) => evaluation !== null)
    ? booleans.map((evaluation) => (evaluation.value ? "1" : "0")).join("")
    : null;
}

function evaluate(expression: ts.Expression, value: Primitive, site: ConditionSite): Evaluation {
  const node = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(node) && site.references.includes(node)) {
    return { value };
  }
  if (isNegation(node)) {
    const operand = evaluate(node.operand, value, site);
    return operand && { value: !operand.value };
  }
  return ts.isBinaryExpression(node) ? evaluateBinary(node, value, site) : literalOperand(node);
}

function evaluateBinary(
  binary: ts.BinaryExpression,
  value: Primitive,
  site: ConditionSite,
): Evaluation {
  const operation = OPERATIONS.get(binary.operatorToken.kind);
  const left = evaluate(binary.left, value, site);
  const right = evaluate(binary.right, value, site);
  return operation && left && right ? { value: operation(left.value, right.value) } : null;
}

function looselyEqual(left: Primitive, right: Primitive): boolean {
  return ((left ?? null) === null && (right ?? null) === null) || left === right;
}

function literalOperand(expression: ts.Expression): Evaluation {
  if (ts.isStringLiteralLike(expression)) {
    return { value: expression.text };
  }
  if (ts.isNumericLiteral(expression)) {
    return { value: Number(expression.text) };
  }
  const keyword = expression.getText();
  return KEYWORD_VALUES.has(keyword) &&
    (!ts.isIdentifier(expression) || lexicalBinding(expression) === null)
    ? { value: KEYWORD_VALUES.get(keyword) }
    : null;
}

/** The runtime value a `DomainValues` literal key names. */
function literalValue(literal: string): Primitive {
  if (literal.startsWith("string:")) {
    return literal.slice("string:".length);
  }
  if (!literal.startsWith("number:")) {
    return KEYWORD_VALUES.get(literal);
  }
  const digits = literal.slice("number:".length).replaceAll("_", "");
  return digits.endsWith("n") ? BigInt(digits.slice(0, -1)) : Number(digits);
}

/** Null when two conditions would share a name or a fresh name is already used in the file. */
function namedConditions(
  raw: RawSubscription,
  groups: readonly ConditionGroup[],
): ConditionProjection["conditions"] | null {
  const conditions = groups.map((sites) => selectedCondition(raw, sites));
  if (!conditions.every((condition) => condition !== null)) {
    return null;
  }
  const sourceFile = raw.declaration.getSourceFile();
  const names = new Set(conditions.map((condition) => condition.name));
  const [first, ...rest] = conditions;
  return first &&
    names.size === conditions.length &&
    conditions.every(
      (condition) => condition.merged !== null || !isNameTaken(sourceFile, condition.name),
    )
    ? [first, ...rest]
    : null;
}

/** A sole condition that initializes a read owner `const` takes that binding; any other gets a fresh name. */
function selectedCondition(raw: RawSubscription, sites: ConditionGroup): SelectedCondition | null {
  const [site, ...copies] = sites;
  const merged =
    copies.length === 0 && !site.coerced ? mergedProjection(site.condition, raw) : null;
  if (merged) {
    return ownerLevelReferences(raw.owner.owner, merged.declaration.name).length > 0
      ? { merged, name: merged.declaration.name.text, sites }
      : null;
  }
  return { merged, name: freshName(site, raw.declaration.name.text), sites };
}

/**
 * `hasItems`/`isItemsEmpty` for a count tested against zero, `isStatusIdle` for a match with a
 * word literal, `userRoleDiffers`, `countExceeds`, `selectedIncludes` for a predicate, `hasUser`
 * for a truthiness test, and `userCondition` for a joined condition.
 */
function freshName(site: ConditionSite, rawName: string): string {
  const node = unwrapTransparentExpression(site.condition);
  const fallback = `${rawName}Condition`;
  if (site.coerced) {
    const chain = chainName(node, site);
    return chain ? `has${capitalized(chain.path)}` : fallback;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const chain = chainName(node.expression.expression, site);
    return chain ? `${chain.path}${capitalized(node.expression.name.text)}` : fallback;
  }
  return ts.isBinaryExpression(node) ? (comparisonName(node, site) ?? fallback) : fallback;
}

/** Names the comparison with its one raw-derived side on the left, mirroring relations. */
function comparisonName(comparison: ts.BinaryExpression, site: ConditionSite): string | null {
  const left = chainName(comparison.left, site);
  const right = chainName(comparison.right, site);
  const operator = comparison.operatorToken.kind;
  if (left && !right) {
    return orientedName(left, unwrapTransparentExpression(comparison.right), operator);
  }
  return right && !left
    ? orientedName(
        right,
        unwrapTransparentExpression(comparison.left),
        MIRRORED_OPERATORS.get(operator) ?? operator,
      )
    : null;
}

function orientedName(
  { counted, path }: ChainName,
  operand: ts.Expression,
  operator: ts.SyntaxKind,
): string | null {
  const subject = capitalized(path);
  const count = counted ? COUNT_TESTS.get(`${operator}:${operand.getText()}`) : undefined;
  if (count) {
    return count === "present" ? `has${subject}` : `is${subject}Empty`;
  }
  const suffix = COMPARISON_SUFFIXES.get(operator);
  if (suffix && suffix !== "Exceeds" && suffix !== "Below" && isNullishLiteral(operand)) {
    return suffix === "Differs" ? `has${subject}` : `missing${subject}`;
  }
  if (
    suffix === "Matches" &&
    ts.isStringLiteralLike(operand) &&
    IDENTIFIER_WORD.test(operand.text)
  ) {
    return `is${subject}${capitalized(operand.text)}`;
  }
  return suffix ? `${path}${suffix}` : null;
}

/** `user.role` as `userRole`; a trailing `length` or `size` marks the chain as counted. */
function chainName(expression: ts.Expression, site: ConditionSite): ChainName | null {
  const node = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(node)) {
    return site.references.includes(node) ? { counted: false, path: node.text } : null;
  }
  const receiver = ts.isPropertyAccessExpression(node) ? chainName(node.expression, site) : null;
  if (!receiver || receiver.counted || !ts.isPropertyAccessExpression(node)) {
    return null;
  }
  const member = node.name.text;
  return member === "length" || member === "size"
    ? { counted: true, path: receiver.path }
    : { counted: false, path: `${receiver.path}${capitalized(member)}` };
}

/**
 * One read inlines `path$.get()` where the raw value was read; several bind it once in a block, so
 * the condition's source is kept verbatim.
 */
function selectedSource(site: ConditionSite, raw: RawSubscription, scan: ProjectionScan): string {
  const { sourceFile } = scan;
  const read = `${raw.observable.getText(sourceFile)}.get()`;
  const [reference, ...others] = site.references;
  const start = site.condition.getStart(sourceFile);
  const text = site.condition.getText(sourceFile);
  const condition =
    others.length === 0
      ? `${text.slice(0, reference.getStart(sourceFile) - start)}${read}${text.slice(reference.getEnd() - start)}`
      : text;
  const node = unwrapTransparentExpression(site.condition);
  const coercible =
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isParenthesizedExpression(site.condition)
      ? condition
      : `(${condition})`;
  const value = site.coerced ? `!!${coercible}` : condition;
  return others.length === 0
    ? value
    : `{ const ${raw.declaration.name.text} = ${read}; return ${value}; }`;
}

function selectorBinding(
  condition: SelectedCondition,
  raw: RawSubscription,
  scan: ProjectionScan,
): SelectorBinding {
  return { name: condition.name, selected: selectedSource(condition.sites[0], raw, scan) };
}

/** Each copy becomes its binding, or the merged `const` is deleted; null when that drops a comment. */
function projectionEdits(
  { conditions, raw }: ConditionProjection,
  scan: ProjectionScan,
): readonly TextEdit[] | null {
  const [first, ...rest] = conditions;
  const bindings = [
    selectorBinding(first, raw, scan),
    ...rest.map((condition) => selectorBinding(condition, raw, scan)),
  ] as const;
  const siteEdits = conditions.map(({ merged, name, sites }) => {
    if (!merged) {
      return sites.map((site) => replaceNode(scan, site.condition, name));
    }
    const removed = { end: merged.statement.getEnd(), pos: merged.statement.getFullStart() };
    return rangeHasComment(scan.sourceFile, removed) ? null : [replaceRange(scan, removed, "")];
  });
  return siteEdits.every((edits) => edits !== null)
    ? [...selectorEdits(raw, bindings, scan), ...siteEdits.flat()]
    : null;
}

function projectionFinding(
  projection: ConditionProjection,
  scan: ProjectionScan,
): LegendPracticeFinding {
  const { raw } = projection;
  const position = scan.sourceFile.getLineAndCharacterOfPosition(raw.declaration.getStart());
  const edits = projectionEdits(projection, scan);
  const several = projection.conditions.length > 1;
  const finding: LegendPracticeFinding = {
    action: "select-primitive-projection",
    confidence: "certain",
    disposition: "change",
    evidence: projectionEvidence(projection, scan),
    location: { column: position.character + 1, file: scan.fileName, line: position.line + 1 },
    message: `${projectionInstruction(projection, scan)} ${raw.owner.name} then renders only when ${several ? "one of those booleans" : "that boolean"} flips, not on every ${raw.observable.getText(scan.sourceFile)} change; the selector${several ? "s" : ""} still run${several ? "" : "s"} on each change.`,
    practice: "reactivity",
  };
  return edits ? { ...finding, edits } : finding;
}

function projectionInstruction(
  { conditions, raw }: ConditionProjection,
  scan: ProjectionScan,
): string {
  const { sourceFile } = scan;
  const callee = raw.call.expression.getText(sourceFile);
  const selectors = conditions.map((condition) => {
    const { name, selected } = selectorBinding(condition, raw, scan);
    return `\`const ${name} = ${callee}(() => ${selected})\``;
  });
  const replacements = conditions.map(({ merged, name, sites }) => {
    if (merged) {
      return `delete \`const ${merged.declaration.getText(sourceFile)}\``;
    }
    const text = sites[0].condition.getText(sourceFile);
    return `replace ${sites.length === 1 ? `\`${text}\`` : `the ${sites.length} \`${text}\` conditions`} with \`${name}\``;
  });
  return `Replace \`const ${raw.declaration.getText(sourceFile)}\` with ${selectors.join(" and ")} and ${replacements.join(" and ")}.`;
}

function projectionEvidence(
  { conditions, proof, raw }: ConditionProjection,
  scan: ProjectionScan,
): readonly string[] {
  const name = raw.declaration.name.text;
  const observable = raw.observable.getText(scan.sourceFile);
  const count = conditions.length;
  return [
    `every read of \`${name}\` sits inside ${count === 1 ? "one boolean condition" : `${count} boolean conditions`} whose other operands are fixed for the render, so ${raw.owner.name}'s render depends on ${observable} only through ${count === 1 ? "that boolean" : "those booleans"}`,
    "each condition reads only declared data members, `length` or `size`, and read-only built-in predicates with pure callbacks, so the selector computes the boolean the render computed and throws only where the render would",
    outcomeEvidence(proof, observable),
    `no other subscription, observer read, dependency-free effect, ref or peek() render read, or subscribing parent renders ${raw.owner.name} on the same ${observable} change`,
  ];
}

function outcomeEvidence(proof: OutcomeProof, observable: string): string {
  if (proof.kind === "finite") {
    return `${observable}'s ${proof.values} values fall into ${proof.outcomes} joint outcomes of the conditions, so some changes leave every boolean unchanged`;
  }
  return proof.kind === "object"
    ? `${observable} holds objects, so a new value can leave every condition unchanged`
    : `${observable} holds unboundedly many values, which finitely many booleans cannot tell apart`;
}
