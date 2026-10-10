import type { ObservableReadScan, UseValueDeclaration } from "./model.js";
import {
  RESERVED_OBSERVABLE_MEMBERS,
  identifiedUseValueDeclaration,
  isValueReferenceTo,
} from "./observable-paths.js";
import {
  bindingDeclarationCount,
  outermostTransparentParent,
  rootIdentifier,
  staticPropertyPath,
} from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import {
  hasEveryRenderEffect,
  ownerTracksRelatedPath,
} from "../primitive-projection/subscription-overlap.js";
import { isConstDeclaration, propertyAccessIsWritten } from "../../core/binding-references.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { RenderOwner } from "../observable-tracking/render-owners.js";
import type { SiblingWrite } from "./sibling-writes.js";
import { entryWrite } from "./sibling-writes.js";
import { isRenderStableOperand } from "../primitive-projection/projection-sites.js";
import { renderOwnerOf } from "../observable-tracking/render-owners.js";
import ts from "typescript";
import { untrackedRenderReads } from "./untracked-render-reads.js";

/** A `const` subscription statement directly in the body of the component or hook it renders. */
interface KeyedSubscription {
  readonly body: ts.Block;
  readonly owner: RenderOwner;
  readonly statement: ts.VariableStatement;
  readonly use: UseValueDeclaration;
}

/** Every read of the subscribed value indexes it with one key. */
interface KeyedReads {
  readonly key: ts.Expression;
  readonly reads: number;
}

interface KeyedNarrowing extends KeyedReads, KeyedSubscription {
  /** The statement the narrowed subscription follows: its own, or the later `const` holding the key. */
  readonly anchor: ts.Statement;
  readonly entry: SiblingWrite;
}

/**
 * `const all = useValue(map$)` read only as `all[key]` renders on every entry's change; subscribing
 * to `map$[key]` renders only when that entry changes and returns the same raw entry.
 */
export function keyedNarrowFinding(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const subscription = keyedSubscription(declaration, scan);
  const reads = subscription ? keyedReads(subscription.use) : null;
  const anchor =
    subscription && reads && !isReservedLiteralKey(reads.key)
      ? keyAnchor(reads.key, subscription)
      : null;
  const entry = subscription && anchor ? entryWrite(subscription.use.observable, scan) : null;
  return subscription && reads && anchor && entry && !rendersOnSameChange(subscription, scan)
    ? keyedFinding({ ...subscription, ...reads, anchor, entry }, scan)
    : null;
}

function keyedSubscription(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): KeyedSubscription | null {
  const use = identifiedUseValueDeclaration(declaration, scan);
  const owner = use ? renderOwnerOf(declaration, scan.imports) : null;
  const statement = declaration.parent.parent;
  const body = owner?.owner.body;
  return use &&
    owner?.hops === 0 &&
    owner.owner === use.owner &&
    body &&
    ts.isBlock(body) &&
    statement.parent === body &&
    ts.isVariableStatement(statement) &&
    isConstDeclaration(declaration) &&
    bindingDeclarationCount(use.owner, use.localName) === 1
    ? { body, owner, statement, use }
    : null;
}

function keyedReads(use: UseValueDeclaration): KeyedReads | null {
  const accesses: ts.ElementAccessExpression[] = [];
  let unsafe = false;
  visit(use.owner.body, (node) => {
    if (unsafe || !isValueReferenceTo(node, use.localName, use.declaration.name)) {
      return;
    }
    const access = node.parent;
    if (
      ts.isElementAccessExpression(access) &&
      access.expression === node &&
      !escapesEntry(access)
    ) {
      accesses.push(access);
    } else {
      unsafe = true;
    }
  });
  const [first] = accesses;
  const key = first?.argumentExpression.getText();
  return !unsafe && first && accesses.every((access) => access.argumentExpression.getText() === key)
    ? { key: first.argumentExpression, reads: accesses.length }
    : null;
}

/**
 * Writing the entry or a member below it mutates the subscribed snapshot, and calling the entry
 * binds `this` to the whole value; neither survives binding the entry alone.
 */
function escapesEntry(access: ts.ElementAccessExpression): boolean {
  const outer = outermostTransparentParent(access);
  const { parent } = outer;
  return (
    (ts.isCallExpression(parent) && parent.expression === outer) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === outer) ||
    accessChainIsWritten(access)
  );
}

function accessChainIsWritten(
  access: ts.ElementAccessExpression | ts.PropertyAccessExpression,
): boolean {
  const outer = outermostTransparentParent(access);
  const { parent } = outer;
  return (
    propertyAccessIsWritten(access) ||
    ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === outer &&
      accessChainIsWritten(parent))
  );
}

/** A literal key that names an observable method selects the method, not an entry. */
function isReservedLiteralKey(key: ts.Expression): boolean {
  return ts.isStringLiteralLike(key) && RESERVED_OBSERVABLE_MEMBERS.has(key.text);
}

/**
 * The key must be fixed for the render where the narrowed subscription runs: at the subscription
 * itself, or right after the later owner `const` that declares it. Moving the hook down past the
 * statements in between keeps it unconditional and in the same order on every render only when
 * none of them returns or throws, and keeps the key independent of the value only when none of
 * them reads it.
 */
function keyAnchor(key: ts.Expression, subscription: KeyedSubscription): ts.Statement | null {
  const { body, owner, statement } = subscription;
  if (isRenderStableOperand(key, owner.owner, statement)) {
    return statement;
  }
  const { statements } = body;
  const start = statements.indexOf(statement);
  const fixedBefore = statements.findIndex(
    (candidate, index) => index > start && isRenderStableOperand(key, owner.owner, candidate),
  );
  const passed = statements.slice(start + 1, fixedBefore);
  return fixedBefore > start + 1 && hookMovesPast(passed, subscription)
    ? statements[fixedBefore - 1]!
    : null;
}

function hookMovesPast(
  statements: readonly ts.Statement[],
  subscription: KeyedSubscription,
): boolean {
  return statements.every((statement) => !blocksHookMove(statement, subscription));
}

function blocksHookMove(statement: ts.Statement, { owner, use }: KeyedSubscription): boolean {
  let blocked = false;
  visit(statement, (node) => {
    blocked ||=
      isValueReferenceTo(node, use.localName, use.declaration.name) ||
      ((ts.isReturnStatement(node) || ts.isThrowStatement(node)) &&
        findAncestor(node, isRuntimeFunctionLike) === owner.owner);
  });
  return blocked;
}

/**
 * Something else renders the owner on the same change: an overlapping subscription or observer
 * read, an effect that runs after every commit, a ref or `peek()` read whose freshness the dropped
 * renders kept, a subscribing parent, or a custom hook that subscribes to the map.
 */
function rendersOnSameChange({ owner, use }: KeyedSubscription, scan: ObservableReadScan): boolean {
  const path = staticPropertyPath(use.observable);
  const contracts = scan.childContracts;
  return (
    !path ||
    ownerTracksRelatedPath({ call: use.call, owner, path }, scan.imports) ||
    hasEveryRenderEffect(owner, scan.imports) ||
    untrackedRenderReads(owner.owner, scan).length > 0 ||
    (contracts !== null &&
      ((owner.kind === "component" &&
        contracts.componentParentRerender(owner.owner, [use.observable]) !== "absent") ||
        contracts.customHookSubscribes(owner.owner, use.observable)))
  );
}

function keyedFinding(narrowing: KeyedNarrowing, scan: ObservableReadScan): LegendPracticeFinding {
  const { anchor, entry, owner, reads, statement, use } = narrowing;
  const { sourceFile } = scan;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    use.declaration.getStart(sourceFile),
  );
  const parent = use.observable.getText(sourceFile);
  const key = narrowing.key.getText(sourceFile);
  const read = `${use.localName}[${key}]`;
  const keyName = rootIdentifier(narrowing.key)?.text ?? key;
  const placement = anchor === statement ? "" : `, declared after \`${keyName}\``;
  return {
    action: "narrow-use-value-subscription",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `every read of \`${use.localName}\` is \`${read}\` (${reads} raw-value read${reads === 1 ? "" : "s"}), so ${owner.name} depends on ${parent} only through that entry`,
      anchor === statement
        ? `\`${key}\` is fixed for the render (a literal, parameter, earlier const, or module constant), so the narrowed subscription reads the entry the render read`
        : `\`${keyName}\` is a later owner const, and no statement between the subscription and it reads \`${use.localName}\`, returns, or throws, so the narrowed subscription can follow it and read the entry the render read`,
      `\`${entry.path}\` is written at ${entry.site} without replacing \`${parent}\`, so a write to any other key rerenders ${owner.name} today`,
      `no other subscription, observer read, dependency-free effect, ref or peek() render read, or subscribing parent renders ${owner.name} on the same ${parent} change`,
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Narrow \`${use.localName}\` from \`${use.call.getText(sourceFile)}\` to \`${use.call.expression.getText(sourceFile)}(${parent}[${key}])\`${placement}; bind the entry directly and replace the \`${read}\` reads so writes to other keys no longer render ${owner.name}.`,
    practice: "reactivity",
  };
}
