import type { LegendPracticeAction, LegendPracticeFinding, TextEdit } from "../../core/types.js";
import type {
  MergedProjection,
  ProjectionScan,
  RawSubscription,
} from "./projection-subscriptions.js";
import {
  capitalized,
  isNameTaken,
  mergedProjection,
  rawSubscription,
  rendersOnSameChange,
  selectorEdits,
} from "./projection-subscriptions.js";
import { isNullishLiteral, isRenderStableOperand, projectionSites } from "./projection-sites.js";
import { rangeHasComment, replaceNode, replaceRange } from "../../core/text-edits.js";
import type { ProjectionSites } from "./projection-sites.js";
import type { ValueDomain } from "./value-domains.js";
import { broadDomain } from "./value-domains.js";
import { conditionProjectionFinding } from "./condition-projection.js";
import { observableDomainValues } from "./projection-domain.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import { rendersStaleUntrackedRead } from "./stale-render-reads.js";
import { truthinessProjectionFinding } from "./truthiness-projection.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

interface Projection extends ProjectionSites {
  readonly domain: ValueDomain;
  readonly merged: MergedProjection | null;
  readonly name: string;
  readonly raw: RawSubscription;
}

/**
 * Practices that rewrite or remove a `useValue` subscription. Each edits the declaration a
 * projection would, so both cannot apply; the projection can follow on the rewritten binding at
 * the next scan.
 */
const SUBSCRIPTION_REWRITES: ReadonlySet<LegendPracticeAction> = new Set([
  "move-use-value-down",
  "move-use-value-into-child",
  "narrow-use-value-subscription",
  "peek-unrendered-use-value",
  "split-use-value-leaves",
]);

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
    const finding = projection
      ? projectionFinding(projection, scan)
      : raw && (truthinessProjectionFinding(raw, scan) ?? conditionProjectionFinding(raw, scan));
    if (finding) {
      findings.push(finding);
    }
  });
  return findings;
}

function confinedProjection(raw: RawSubscription, scan: ProjectionScan): Projection | null {
  const sites = projectionSites(raw.owner.owner, raw.declaration.name, scan.imports);
  const domain = broadDomain(observableDomainValues(raw.observable, scan));
  if (
    !sites ||
    !domain ||
    !isRenderStableOperand(sites.operand, raw.owner.owner, raw.statement) ||
    (LOOSE_OPERATORS.has(sites.operator) && !isNullishLiteral(sites.operand)) ||
    rendersOnSameChange(raw, scan)
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
  const merged =
    candidate.sites.length === 1 ? mergedProjection(candidate.sites[0].comparison, raw) : null;
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

/**
 * `hasItem`/`missingItem` against null or undefined, otherwise `activeMatches`/`activeDiffers`;
 * null when the file already uses that name.
 */
function freshProjectionName(raw: RawSubscription, sites: ProjectionSites): string | null {
  const negated = NEGATED_OPERATORS.has(sites.operator);
  const base = raw.declaration.name.text;
  const name = isNullishLiteral(sites.operand)
    ? `${negated ? "has" : "missing"}${capitalized(base)}`
    : `${base}${negated ? "Differs" : "Matches"}`;
  return isNameTaken(raw.declaration.getSourceFile(), name) ? null : name;
}

function comparisonSource(projection: Projection, scan: ProjectionScan): string {
  const [site] = projection.sites;
  const read = `${projection.raw.observable.getText(scan.sourceFile)}.get()`;
  const operand = projection.operand.getText(scan.sourceFile);
  const operator = site.comparison.operatorToken.getText(scan.sourceFile);
  return site.rawOnLeft ? `${read} ${operator} ${operand}` : `${operand} ${operator} ${read}`;
}

function selectorSource(projection: Projection, scan: ProjectionScan): string {
  return `${projection.raw.call.expression.getText(scan.sourceFile)}(() => ${comparisonSource(projection, scan)})`;
}

function projectionEdits(projection: Projection, scan: ProjectionScan): readonly TextEdit[] | null {
  const hook = selectorEdits(
    projection.raw,
    [{ name: projection.name, selected: comparisonSource(projection, scan) }],
    scan,
  );
  if (!projection.merged) {
    return [
      ...hook,
      ...projection.sites.map((site) => replaceNode(scan, site.comparison, projection.name)),
      ...projection.dependencies.map((entry) => replaceNode(scan, entry, projection.name)),
    ];
  }
  const { statement } = projection.merged;
  const removed = { end: statement.getEnd(), pos: statement.getFullStart() };
  return rangeHasComment(scan.sourceFile, removed)
    ? null
    : [...hook, replaceRange(scan, removed, "")];
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
  const dependencies =
    projection.dependencies.length > 0
      ? `, and list \`${projection.name}\` in place of \`${projection.raw.declaration.name.text}\` in the guarded effect's dependencies`
      : "";
  return `Replace \`const ${raw}\` with \`${selector}\` and replace ${count === 1 ? `\`${comparison}\`` : `the ${count} \`${comparison}\` comparisons`} with \`${projection.name}\`${dependencies}.`;
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

/** Drops each projection of a subscription that another practice already rewrites. */
export function withoutSupersededProjections(
  findings: readonly LegendPracticeFinding[],
): LegendPracticeFinding[] {
  const rewritten = new Set(
    findings
      .filter((finding) => SUBSCRIPTION_REWRITES.has(finding.action))
      .map((finding) => locationKey(finding)),
  );
  return findings.filter(
    (finding) =>
      finding.action !== "select-primitive-projection" || !rewritten.has(locationKey(finding)),
  );
}

function locationKey({ location }: LegendPracticeFinding): string {
  return `${location.file}:${location.line}:${location.column}`;
}
