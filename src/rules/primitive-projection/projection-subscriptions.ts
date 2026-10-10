import { hasEveryRenderEffect, ownerTracksRelatedPath } from "./subscription-overlap.js";
import { isUseValueCall, provenObservablePath } from "../observable-reads/observable-paths.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { DomainFacts } from "./projection-domain.js";
import type { OwnerHookScan } from "./owner-hooks.js";
import type { RenderOwner } from "../observable-tracking/render-owners.js";
import type { TextEdit } from "../../core/types.js";
import { callsUnprovenHook } from "./owner-hooks.js";
import { isSynchronous } from "../observable-reads/untracked-render-reads.js";
import { renderOwnerOf } from "../observable-tracking/render-owners.js";
import { replaceNode } from "../../core/text-edits.js";
import { staticPropertyPath } from "../../core/analysis-ast.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export interface ProjectionScan extends DomainFacts, OwnerHookScan {
  readonly childContracts: ChildContractResolver | null;
  readonly fileName: string;
  readonly observableBindings: ReadonlySet<string>;
}

export type NamedDeclaration = ts.VariableDeclaration & { readonly name: ts.Identifier };

/** `const raw = useValue(path$)` directly in the body of a synchronous component or hook. */
export interface RawSubscription {
  readonly call: ts.CallExpression;
  readonly declaration: NamedDeclaration;
  readonly observable: ts.Expression;
  readonly owner: RenderOwner;
  /** The observable's static property path. */
  readonly path: readonly string[];
  readonly statement: ts.VariableStatement;
}

/** The binding an inline selector initializes, and the expression it selects. */
export interface SelectorBinding {
  readonly name: string;
  readonly selected: string;
}

/** The `const` a sole projection initializes; it becomes the selector's binding. */
export interface MergedProjection {
  readonly declaration: NamedDeclaration;
  readonly statement: ts.VariableStatement;
}

export function rawSubscription(
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
  const path = observable ? staticPropertyPath(observable) : null;
  const owner = renderOwnerOf(declaration, scan.imports);
  return observable &&
    path &&
    owner?.hops === 0 &&
    statement.parent === owner.owner.body &&
    isSynchronous(owner.owner)
    ? { call, declaration, observable, owner, path, statement }
    : null;
}

/**
 * Something other than the projected value renders the owner on the same observable change, so
 * selecting the projection removes no render: an `observer` wrapper, an overlapping subscription,
 * a dependency-free effect, a hook out of view, or a parent that subscribes to the same path.
 */
export function rendersOnSameChange(raw: RawSubscription, scan: ProjectionScan): boolean {
  return (
    raw.owner.tracked ||
    ownerTracksRelatedPath(raw, scan.imports) ||
    hasEveryRenderEffect(raw.owner, scan.imports) ||
    callsUnprovenHook(raw.owner.owner, scan) ||
    parentRendersOnSameChange(raw, scan)
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

/** `const selected = <projection>;` in the owner body becomes the selector. */
export function mergedProjection(
  projection: ts.Expression,
  raw: RawSubscription,
): MergedProjection | null {
  const outer = outermostParenthesized(projection);
  const declaration = outer.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !isNamedDeclaration(declaration) ||
    declaration.type ||
    declaration.initializer !== outer
  ) {
    return null;
  }
  const statement = soleConstStatement(declaration);
  return statement !== null && statement.parent === raw.owner.owner.body
    ? { declaration, statement }
    : null;
}

/**
 * Renames the raw binding and swaps the subscribed path for the inline selector, leaving the
 * callee alone so a legacy hook rename by `replace-legacy-use-value` composes with these edits.
 */
export function selectorEdits(
  raw: RawSubscription,
  { name, selected }: SelectorBinding,
  scan: ProjectionScan,
): readonly TextEdit[] {
  return [
    replaceNode(scan, raw.declaration.name, name),
    replaceNode(scan, raw.call.arguments[0]!, `() => ${selected}`),
  ];
}

/** Whether any identifier in the file already spells `name`. */
export function isNameTaken(sourceFile: ts.SourceFile, name: string): boolean {
  let taken = false;
  visit(sourceFile, (node) => {
    taken ||= ts.isIdentifier(node) && node.text === name;
  });
  return taken;
}

export function capitalized(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
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

function outermostParenthesized(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}
