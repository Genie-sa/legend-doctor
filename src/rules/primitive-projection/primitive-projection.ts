import type { LegendPracticeFinding, TextEdit } from "../../core/types.js";
import { hasEveryRenderEffect, ownerTracksRelatedPath } from "./subscription-overlap.js";
import { isRenderStableOperand, projectionSites } from "./projection-sites.js";
import { isUseValueCall, provenObservablePath } from "../observable-reads/observable-paths.js";
import { rangeHasComment, replaceNode, replaceRange } from "../../core/text-edits.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { DomainFacts } from "./projection-domain.js";
import type { OwnerHookScan } from "./owner-hooks.js";
import type { ProjectionSites } from "./projection-sites.js";
import type { RenderOwner } from "../observable-tracking/render-owners.js";
import type { ValueDomain } from "./value-domains.js";
import { callsUnprovenHook } from "./owner-hooks.js";
import { isSynchronous } from "../observable-reads/untracked-render-reads.js";
import { observableValueDomain } from "./projection-domain.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import { renderOwnerOf } from "../observable-tracking/render-owners.js";
import { rendersStaleUntrackedRead } from "./stale-render-reads.js";
import { staticPropertyPath } from "../../core/analysis-ast.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export interface ProjectionScan extends DomainFacts, OwnerHookScan {
  readonly childContracts: ChildContractResolver | null;
  readonly fileName: string;
  readonly observableBindings: ReadonlySet<string>;
}

type NamedDeclaration = ts.VariableDeclaration & { readonly name: ts.Identifier };

interface RawSubscription {
  readonly call: ts.CallExpression;
  readonly declaration: NamedDeclaration;
  readonly observable: ts.Expression;
  readonly owner: RenderOwner;
  readonly statement: ts.VariableStatement;
}

/** The `const` a sole comparison initializes; it becomes the selector's binding. */
interface MergedComparison {
  readonly declaration: NamedDeclaration;
  readonly statement: ts.VariableStatement;
}

interface Projection extends ProjectionSites {
  readonly domain: ValueDomain;
  readonly merged: MergedComparison | null;
  readonly name: string;
  readonly raw: RawSubscription;
}

const LOOSE_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const NEGATED_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * A render subscribes to a whole observable value only to compare it with one render-stable
 * operand. Selecting the comparison instead renders the owner only when its boolean flips, which a
 * domain of three or more values (or objects) proves can differ from renders on every change.
 */
export function findPrimitiveProjections(scan: ProjectionScan): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    const raw = ts.isVariableDeclaration(node) ? rawSubscription(node, scan) : null;
    const projection = raw ? confinedProjection(raw, scan) : null;
    if (projection) {
      findings.push(projectionFinding(projection, scan));
    }
  });
  return findings;
}

function rawSubscription(
  declaration: ts.VariableDeclaration,
  scan: ProjectionScan,
): RawSubscription | null {
  const call = declaration.initializer;
  const statement = soleConstStatement(declaration);
  if (
    !isNamedDeclaration(declaration) ||
    declaration.type ||
    !call ||
    !ts.isCallExpression(call) ||
    call.typeArguments ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, scan.imports) ||
    !statement
  ) {
    return null;
  }
  const observable = provenObservablePath(call.arguments[0]!, scan.observableBindings);
  const owner = renderOwnerOf(declaration, scan.imports);
  return observable &&
    owner?.hops === 0 &&
    statement.parent === owner.owner.body &&
    isSynchronous(owner.owner)
    ? { call, declaration, observable, owner, statement }
    : null;
}

function isNamedDeclaration(declaration: ts.VariableDeclaration): declaration is NamedDeclaration {
  return ts.isIdentifier(declaration.name);
}

/** The `const` statement that declares only this binding. */
function soleConstStatement(declaration: ts.VariableDeclaration): ts.VariableStatement | null {
  const list = declaration.parent;
  const statement = list.parent;
  return ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0 &&
    list.declarations.length === 1 &&
    ts.isVariableStatement(statement)
    ? statement
    : null;
}

function confinedProjection(raw: RawSubscription, scan: ProjectionScan): Projection | null {
  const sites = projectionSites(raw.owner.owner, raw.declaration.name);
  const path = staticPropertyPath(raw.observable);
  const domain = observableValueDomain(raw.observable, scan);
  if (
    !sites ||
    !path ||
    !domain ||
    raw.owner.tracked ||
    !isRenderStableOperand(sites.operand, raw.owner.owner, raw.statement) ||
    (LOOSE_OPERATORS.has(sites.operator) && !isNullishLiteral(sites.operand)) ||
    ownerTracksRelatedPath({ call: raw.call, owner: raw.owner, path }, scan.imports) ||
    hasEveryRenderEffect(raw.owner, scan.imports) ||
    callsUnprovenHook(raw.owner.owner, scan) ||
    parentRendersOnSameChange(raw, scan)
  ) {
    return null;
  }
  return namedProjection({ ...sites, domain, raw }, scan);
}

function namedProjection(
  candidate: Omit<Projection, "merged" | "name">,
  scan: ProjectionScan,
): Projection | null {
  const { raw } = candidate;
  const merged = mergedProjection(candidate, raw);
  const match = merged?.declaration.name ?? null;
  if (
    (match !== null && ownerLevelReferences(raw.owner.owner, match).length === 0) ||
    rendersStaleUntrackedRead({
      domain: candidate.domain,
      imports: scan.imports,
      match,
      observableBindings: scan.observableBindings,
      owner: raw.owner.owner,
      sites: candidate,
    })
  ) {
    return null;
  }
  const name = match?.text ?? freshProjectionName(raw, candidate);
  return name === null ? null : { ...candidate, merged, name };
}

function isNullishLiteral(operand: ts.Expression): boolean {
  return (
    operand.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(operand) && operand.text === "undefined")
  );
}

/** When every component that renders the owner subscribes to the same path, no render is removed. */
function parentRendersOnSameChange(raw: RawSubscription, scan: ProjectionScan): boolean {
  return (
    raw.owner.kind === "component" &&
    scan.childContracts !== null &&
    scan.childContracts.componentParentRerender(raw.owner.owner, [raw.observable]) !== "absent"
  );
}

/** `const selected = raw === id;` in the owner body becomes the selector. */
function mergedProjection(sites: ProjectionSites, raw: RawSubscription): MergedComparison | null {
  const [site, ...others] = sites.sites;
  const comparison = outermostParenthesized(site.comparison);
  const declaration = comparison.parent;
  if (
    others.length > 0 ||
    !ts.isVariableDeclaration(declaration) ||
    !isNamedDeclaration(declaration) ||
    declaration.type ||
    declaration.initializer !== comparison
  ) {
    return null;
  }
  const statement = soleConstStatement(declaration);
  return statement !== null && statement.parent === raw.owner.owner.body
    ? { declaration, statement }
    : null;
}

function outermostParenthesized(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}

/**
 * `hasItem`/`missingItem` against null or undefined, otherwise `activeMatches`/`activeDiffers`;
 * null when the file already uses that name.
 */
function freshProjectionName(raw: RawSubscription, sites: ProjectionSites): string | null {
  const negated = NEGATED_OPERATORS.has(sites.operator);
  const base = raw.declaration.name.text;
  const capitalized = `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  const name = isNullishLiteral(sites.operand)
    ? `${negated ? "has" : "missing"}${capitalized}`
    : `${base}${negated ? "Differs" : "Matches"}`;
  let taken = false;
  visit(raw.declaration.getSourceFile(), (node) => {
    taken ||= ts.isIdentifier(node) && node.text === name;
  });
  return taken ? null : name;
}

function selectorSource(projection: Projection, scan: ProjectionScan): string {
  const [site] = projection.sites;
  const read = `${projection.raw.observable.getText(scan.sourceFile)}.get()`;
  const operand = projection.operand.getText(scan.sourceFile);
  const operator = site.comparison.operatorToken.getText(scan.sourceFile);
  const comparison = site.rawOnLeft
    ? `${read} ${operator} ${operand}`
    : `${operand} ${operator} ${read}`;
  return `${projection.raw.call.expression.getText(scan.sourceFile)}(() => ${comparison})`;
}

function projectionEdits(projection: Projection, scan: ProjectionScan): readonly TextEdit[] | null {
  const hook = replaceNode(
    scan,
    projection.raw.declaration,
    `${projection.name} = ${selectorSource(projection, scan)}`,
  );
  if (!projection.merged) {
    return [
      hook,
      ...projection.sites.map((site) => replaceNode(scan, site.comparison, projection.name)),
    ];
  }
  const { statement } = projection.merged;
  const removed = { end: statement.getEnd(), pos: statement.getFullStart() };
  return rangeHasComment(scan.sourceFile, removed) ? null : [hook, replaceRange(scan, removed, "")];
}

function projectionFinding(projection: Projection, scan: ProjectionScan): LegendPracticeFinding {
  const { raw } = projection;
  const position = scan.sourceFile.getLineAndCharacterOfPosition(raw.declaration.getStart());
  const selector = `const ${projection.name} = ${selectorSource(projection, scan)}`;
  const edits = projectionEdits(projection, scan);
  const finding: LegendPracticeFinding = {
    action: "select-primitive-projection",
    confidence: "certain",
    disposition: "change",
    evidence: projectionEvidence(projection, scan),
    location: { column: position.character + 1, file: scan.fileName, line: position.line + 1 },
    message: `${projectionInstruction(projection, selector, scan)} ${raw.owner.name} then renders only when the comparison flips, not on every ${raw.observable.getText(scan.sourceFile)} change; the selector still runs on each change.`,
    practice: "reactivity",
  };
  return edits ? { ...finding, edits } : finding;
}

function projectionInstruction(
  projection: Projection,
  selector: string,
  scan: ProjectionScan,
): string {
  const raw = projection.raw.declaration.getText(scan.sourceFile);
  if (projection.merged) {
    return `Replace \`const ${raw}\` with \`${selector}\` and delete \`const ${projection.merged.declaration.getText(scan.sourceFile)}\`.`;
  }
  const comparison = projection.sites[0].comparison.getText(scan.sourceFile);
  const count = projection.sites.length;
  return `Replace \`const ${raw}\` with \`${selector}\` and replace ${count === 1 ? `\`${comparison}\`` : `the ${count} \`${comparison}\` comparisons`} with \`${projection.name}\`.`;
}

function projectionEvidence(projection: Projection, scan: ProjectionScan): readonly string[] {
  const { raw } = projection;
  const observable = raw.observable.getText(scan.sourceFile);
  const operand = projection.operand.getText(scan.sourceFile);
  return [
    `every read of \`${raw.declaration.name.text}\` compares it with \`${operand}\`, so ${raw.owner.name}'s render depends on ${observable} only through that boolean`,
    `\`${operand}\` is fixed for the render (a literal, parameter, earlier const, or module constant), so the inline selector compares the value the render compared`,
    `${observable} holds ${projection.domain === "object" ? "objects" : "three or more primitive values"}, so distinct values can leave the comparison unchanged`,
    `no other subscription, observer read, dependency-free effect, or subscribing parent renders ${raw.owner.name} on the same ${observable} change`,
  ];
}
