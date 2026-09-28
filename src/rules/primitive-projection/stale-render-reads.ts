import type { HookImports } from "../../core/imports.js";
import type { ProjectionSites } from "./projection-sites.js";
import type { RenderFunction } from "../observable-tracking/render-owners.js";
import type { ValueDomain } from "./value-domains.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";
import { untrackedRenderReads } from "../observable-reads/untracked-render-reads.js";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

export interface StaleReadQuery {
  readonly domain: ValueDomain;
  readonly imports: HookImports;
  /** The `const` the sole comparison initializes; testing it tests the comparison. */
  readonly match: ts.Identifier | null;
  readonly observableBindings: ReadonlySet<string>;
  readonly owner: RenderFunction;
  readonly sites: ProjectionSites;
}

const NEGATED_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * The projection drops the renders in which the raw value changes but the comparison does not. A
 * changed primitive cannot equal the operand both before and after, so dropped renders all take
 * the unequal side: a ref, `peek()`, or untracked `get()` read confined to the equal side never
 * runs in one, and any other such read could keep a value those renders used to refresh.
 */
export function rendersStaleUntrackedRead(query: StaleReadQuery): boolean {
  return untrackedRenderReads(query.owner, query).some(
    (read) => query.domain !== "primitive" || !confinedToEqualSide(read, query),
  );
}

function confinedToEqualSide(read: ts.Node, query: StaleReadQuery): boolean {
  const equalWhenTruthy = !NEGATED_OPERATORS.has(query.sites.operator);
  for (let child = read; child.parent && child !== query.owner.body; child = child.parent) {
    const test = equalSideTest(child.parent, child, equalWhenTruthy);
    if (test && testsComparison(test, query)) {
      return true;
    }
  }
  return false;
}

/** The condition whose equal-side outcome `child` requires to run under `parent`. */
function equalSideTest(
  parent: ts.Node,
  child: ts.Node,
  equalWhenTruthy: boolean,
): ts.Expression | null {
  if (ts.isIfStatement(parent)) {
    const branch = equalWhenTruthy ? parent.thenStatement : parent.elseStatement;
    return branch === child ? parent.expression : null;
  }
  if (ts.isConditionalExpression(parent)) {
    const branch = equalWhenTruthy ? parent.whenTrue : parent.whenFalse;
    return branch === child ? parent.condition : null;
  }
  const guard = equalWhenTruthy ? ts.SyntaxKind.AmpersandAmpersandToken : ts.SyntaxKind.BarBarToken;
  return ts.isBinaryExpression(parent) &&
    parent.right === child &&
    parent.operatorToken.kind === guard
    ? parent.left
    : null;
}

function testsComparison(test: ts.Expression, query: StaleReadQuery): boolean {
  const condition = unwrapTransparentExpression(test);
  if (query.sites.sites.some((site) => site.comparison === condition)) {
    return true;
  }
  return (
    query.match !== null &&
    ts.isIdentifier(condition) &&
    ownerLevelReferences(query.owner, query.match).includes(condition)
  );
}
