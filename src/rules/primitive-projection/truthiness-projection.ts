import type { LegendPracticeFinding, TextEdit } from "../../core/types.js";
import type {
  MergedProjection,
  ProjectionScan,
  RawSubscription,
} from "./projection-subscriptions.js";
import {
  capitalized,
  isNameTaken,
  mergedProjection,
  rendersOnSameChange,
  selectorEdits,
} from "./projection-subscriptions.js";
import { rangeHasComment, replaceNode, replaceRange } from "../../core/text-edits.js";
import type { TruthinessSite } from "./truthiness-sites.js";
import { observableDomainValues } from "./projection-domain.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import { truthinessDomain } from "./value-domains.js";
import { truthinessSites } from "./truthiness-sites.js";
import ts from "typescript";
import { untrackedRenderReads } from "../observable-reads/untracked-render-reads.js";

interface TruthinessProjection {
  readonly merged: MergedProjection | null;
  readonly name: string;
  readonly raw: RawSubscription;
  readonly sites: readonly [TruthinessSite, ...TruthinessSite[]];
}

/**
 * A render subscribes to a whole observable value only to test its truthiness. Selecting
 * `!!path$.get()` renders the owner only when that boolean flips, which a domain with two distinct
 * truthy values proves can differ from rendering on every change.
 */
export function truthinessProjectionFinding(
  raw: RawSubscription,
  scan: ProjectionScan,
): LegendPracticeFinding | null {
  const sites = truthinessSites(raw.owner.owner, raw.declaration.name);
  const domain = sites ? truthinessDomain(observableDomainValues(raw.observable, scan)) : null;
  if (
    !sites ||
    !domain?.keepsTruthinessAcrossChanges ||
    (domain.rendersFalsyValue && sites.some((site) => site.use === "falsy-render")) ||
    rendersOnSameChange(raw, scan) ||
    untrackedRenderReads(raw.owner.owner, scan).length > 0
  ) {
    return null;
  }
  const projection = namedProjection(raw, sites);
  return projection ? projectionFinding(projection, scan) : null;
}

/** `const shown = !!raw;` becomes the selector's binding; otherwise `hasRaw`, unless the file uses it. */
function namedProjection(
  raw: RawSubscription,
  sites: TruthinessProjection["sites"],
): TruthinessProjection | null {
  const [site, ...others] = sites;
  const merged =
    others.length === 0 && !ts.isIdentifier(site.replaced)
      ? mergedProjection(site.replaced, raw)
      : null;
  if (merged && ownerLevelReferences(raw.owner.owner, merged.declaration.name).length === 0) {
    return null;
  }
  const name = merged?.declaration.name.text ?? `has${capitalized(raw.declaration.name.text)}`;
  return merged || !isNameTaken(raw.declaration.getSourceFile(), name)
    ? { merged, name, raw, sites }
    : null;
}

function truthinessSource(projection: TruthinessProjection, scan: ProjectionScan): string {
  return `!!${projection.raw.observable.getText(scan.sourceFile)}.get()`;
}

function selectorSource(projection: TruthinessProjection, scan: ProjectionScan): string {
  return `${projection.raw.call.expression.getText(scan.sourceFile)}(() => ${truthinessSource(projection, scan)})`;
}

function projectionEdits(
  projection: TruthinessProjection,
  scan: ProjectionScan,
): readonly TextEdit[] | null {
  const hook = selectorEdits(
    projection.raw,
    { name: projection.name, selected: truthinessSource(projection, scan) },
    scan,
  );
  if (!projection.merged) {
    return [
      ...hook,
      ...projection.sites.map((site) => replaceNode(scan, site.replaced, projection.name)),
    ];
  }
  const { statement } = projection.merged;
  const removed = { end: statement.getEnd(), pos: statement.getFullStart() };
  return rangeHasComment(scan.sourceFile, removed)
    ? null
    : [...hook, replaceRange(scan, removed, "")];
}

function projectionFinding(
  projection: TruthinessProjection,
  scan: ProjectionScan,
): LegendPracticeFinding {
  const { raw } = projection;
  const position = scan.sourceFile.getLineAndCharacterOfPosition(raw.declaration.getStart());
  const edits = projectionEdits(projection, scan);
  const finding: LegendPracticeFinding = {
    action: "select-primitive-projection",
    confidence: "certain",
    disposition: "change",
    evidence: projectionEvidence(projection, scan),
    location: { column: position.character + 1, file: scan.fileName, line: position.line + 1 },
    message: `${projectionInstruction(projection, scan)} ${raw.owner.name} then renders only when ${raw.observable.getText(scan.sourceFile)} turns truthy or falsy, not on every change; the selector still runs on each change.`,
    practice: "reactivity",
  };
  return edits ? { ...finding, edits } : finding;
}

function projectionInstruction(projection: TruthinessProjection, scan: ProjectionScan): string {
  const raw = projection.raw.declaration.getText(scan.sourceFile);
  const selector = `const ${projection.name} = ${selectorSource(projection, scan)}`;
  if (projection.merged) {
    return `Replace \`const ${raw}\` with \`${selector}\` and delete \`const ${projection.merged.declaration.getText(scan.sourceFile)}\`.`;
  }
  const [site] = projection.sites;
  const reads =
    projection.sites.length === 1
      ? `\`${site.replaced.getText(scan.sourceFile)}\``
      : `the ${projection.sites.length} truthiness reads of \`${projection.raw.declaration.name.text}\``;
  return `Replace \`const ${raw}\` with \`${selector}\` and replace ${reads} with \`${projection.name}\`.`;
}

function projectionEvidence(
  projection: TruthinessProjection,
  scan: ProjectionScan,
): readonly string[] {
  const { raw } = projection;
  const name = raw.declaration.name.text;
  const observable = raw.observable.getText(scan.sourceFile);
  const rendersFalsy = projection.sites.some((site) => site.use === "falsy-render");
  return [
    `every read of \`${name}\` keeps only its truthiness (\`!\`, \`Boolean()\`, a condition, or a \`&&\`/\`||\` operand), so ${raw.owner.name}'s render depends on ${observable} only through that boolean`,
    ...(rendersFalsy
      ? [
          `\`${name}\` is never \`0\`, \`NaN\`, or \`""\`, so where JSX renders a falsy \`${name}\` it renders nothing, as \`false\` does`,
        ]
      : []),
    `${observable} holds objects or more than one truthy value, so a change can leave its truthiness unchanged`,
    `no other subscription, observer read, dependency-free effect, ref or peek() render read, or subscribing parent renders ${raw.owner.name} on the same ${observable} change`,
  ];
}
