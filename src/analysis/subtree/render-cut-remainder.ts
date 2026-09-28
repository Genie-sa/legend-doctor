import type { HookImports, HostTagImports } from "../../core/imports.js";
import type { StateCandidate, StateUsage } from "../model.js";
import { collectHookImports, isHostTag, isImportedHookCall } from "../../core/imports.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import {
  lowestCommonJsxSubtree,
  nearestRepeatedRenderCall,
} from "../../rules/state-proofs/jsx-subtrees.js";
import { COMPACT_OWNER_JSX_ELEMENTS } from "../constants.js";
import type { ChildContractResolver } from "../../rules/child-contract/model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { extractedRenderRoots } from "./extracted-render-work.js";
import { isBuiltinReadMethodName } from "../../rules/state-proofs/builtin-read-calls.js";
import { runsOutsideRender } from "../../rules/observable-reads/render-exclusion.js";
import ts from "typescript";

const MAX_DERIVATION_HOPS = 3;

export interface RenderRemainderQuery {
  readonly childContracts: ChildContractResolver | null;
  readonly imports: HookImports;
  readonly leafRoots: readonly ts.Node[];
  readonly owner: RuntimeFunctionLike;
  readonly pureProjectionImports: ReadonlySet<string>;
}

/**
 * Whether the owner render a leaf cut skips is provably trivial: fewer elements remain than even a
 * compact owner renders, each is a host element or a resolved hook-free host-only component, none
 * repeats, and the remainder calls nothing but read-only projections and core hooks. A repeated
 * leaf is never trivial, since its cut spares every row the owner would re-render. Work in commit
 * callbacks, event handlers, deferred schedulers, and `useMemo` factories does not re-run on the
 * update. A leaf re-renders its own roots and every owner-local render helper they call; a wrapped
 * element keeps its children and other props as stable snapshots, so they are skipped.
 */
export function hasTrivialRenderRemainder(query: RenderRemainderQuery): boolean {
  const { leafRoots, owner } = query;
  const reached = extractedRenderRoots(leafRoots, owner);
  if (reached.some((root) => nearestRepeatedRenderCall(root, owner))) {
    return false;
  }
  let remainingElements = 0;
  let trivial = true;
  visit(owner.body, (node) => {
    if (
      !trivial ||
      !isEvaluatedByOwnerRender(node, owner, query.imports) ||
      reached.some((root) => isReachedBy(node, root))
    ) {
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      remainingElements += 1;
      trivial = isTrivialElement(node, query);
    } else if (ts.isCallExpression(node)) {
      trivial = isTrivialRenderCall(node, query);
    }
  });
  return trivial && remainingElements < COMPACT_OWNER_JSX_ELEMENTS;
}

/** A wrapped element re-renders with the attribute the leaf computes; its other props stay snapshots. */
function isReachedBy(node: ts.Node, root: ts.Node): boolean {
  const tag = ts.isJsxElement(node) ? node.openingElement : node;
  return (
    nodeWithin(tag, root) ||
    ((ts.isJsxAttribute(root) || ts.isJsxSpreadAttribute(root)) && root.parent.parent === tag)
  );
}

function isEvaluatedByOwnerRender(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  return !runsOutsideRender(node, owner, imports) && !isInsideMemoFactory(node, owner, imports);
}

function isInsideMemoFactory(
  node: ts.Node,
  owner: RuntimeFunctionLike,
  imports: HookImports,
): boolean {
  for (
    let callback = nearestNestedFunction(node, owner);
    callback;
    callback = nearestNestedFunction(callback, owner)
  ) {
    const call = callback.parent;
    if (
      ts.isCallExpression(call) &&
      call.arguments[0] === callback &&
      isImportedHookCall({
        call,
        canonicalName: "useMemo",
        localNames: imports.useMemo,
        namespaceNames: imports.reactNamespaces,
      })
    ) {
      return true;
    }
  }
  return false;
}

function isTrivialElement(
  element: ts.JsxElement | ts.JsxSelfClosingElement,
  { childContracts, imports, owner }: RenderRemainderQuery,
): boolean {
  if (nearestRepeatedRenderCall(element, owner)) {
    return false;
  }
  const tag = (ts.isJsxElement(element) ? element.openingElement : element).tagName.getText();
  if (isHostTag(tag, imports)) {
    return true;
  }
  const source = /^[A-Z]\w*$/u.test(tag) ? childContracts?.resolveComponent(tag) : null;
  return source !== null && source !== undefined && rendersOnlyHostElements(source.body);
}

/** A child is trivial when it calls only built-in reads and renders each host element once. */
function rendersOnlyHostElements(body: ts.ConciseBody): boolean {
  const imports: HostTagImports = collectHookImports(body.getSourceFile());
  let hostOnly = true;
  visit(body, (node) => {
    if (ts.isCallExpression(node)) {
      hostOnly &&=
        ts.isPropertyAccessExpression(node.expression) &&
        isBuiltinReadMethodName(node.expression.name.text);
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      hostOnly &&=
        isHostTag(node.tagName.getText(), imports) && !nearestRepeatedRenderCall(node, body);
    }
  });
  return hostOnly;
}

function isTrivialRenderCall(
  call: ts.CallExpression,
  { imports, pureProjectionImports }: RenderRemainderQuery,
): boolean {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return isBuiltinReadMethodName(callee.name.text);
  }
  if (!ts.isIdentifier(callee)) {
    return false;
  }
  return (
    pureProjectionImports.has(callee.text) ||
    imports.useState.has(callee.text) ||
    imports.useRef.has(callee.text) ||
    imports.useMemo.has(callee.text) ||
    imports.useCallback.has(callee.text) ||
    imports.useEffect.has(callee.text)
  );
}

/**
 * The smallest JSX regions any leaf subscriber must re-render for this state: the attribute that
 * reads or carries the value, with the element it configures, or the child expression that
 * renders it.
 * A render-phase derivation is followed to the JSX that reads its bindings. Returns null when a
 * render read feeds anything else, such as a hook argument, a guard, or a returned expression.
 */
export function minimalLeafRoots(
  state: StateCandidate,
  usage: StateUsage,
  imports: HookImports,
): readonly ts.Node[] | null {
  const roots: ts.Node[] = [];
  for (const read of usage.directRenderNodes) {
    const readRoots = renderReadRoots(read, state.owner, { hops: 0, imports });
    if (!readRoots) {
      return null;
    }
    roots.push(...readRoots);
  }
  return [...roots, ...valueTransportRoots(state, usage)];
}

function valueTransportRoots(state: StateCandidate, usage: StateUsage): ts.Node[] {
  return [...usage.transportNodes.values()]
    .flat()
    .filter(
      (attribute): attribute is ts.JsxAttribute =>
        ts.isJsxAttribute(attribute) && carriesBinding(attribute, state.valueName),
    );
}

/**
 * A moved state needs one component that owns every read and every JSX-bound write, so its leaf
 * is the lowest JSX subtree that contains them all.
 */
export function movedStateLeafRoot(
  state: StateCandidate,
  usage: StateUsage,
  readRoots: readonly ts.Node[],
): ts.Node | null {
  const writeSites = [...usage.transportNodes.values()]
    .flat()
    .filter((node) => ts.isJsxAttribute(node));
  const handlerSites = usage.setterCallNodes.flatMap((call) => {
    const attribute = findAncestorUntil(call, ts.isJsxAttribute, state.owner);
    return attribute ? [attribute] : [];
  });
  const sites = [...readRoots, ...writeSites, ...handlerSites];
  return sites.length > 0 ? lowestCommonJsxSubtree(sites, state.owner) : null;
}

interface DerivationScope {
  readonly hops: number;
  readonly imports: HookImports;
}

function renderReadRoots(
  read: ts.Node,
  owner: RuntimeFunctionLike,
  scope: DerivationScope,
): readonly ts.Node[] | null {
  const site = findAncestorUntil(
    read,
    (node): node is ts.JsxAttribute | ts.JsxExpression | ts.JsxSpreadAttribute =>
      ts.isJsxAttribute(node) || ts.isJsxSpreadAttribute(node) || isJsxChildExpression(node),
    owner,
  );
  return site ? [site] : derivationRoots(read, owner, scope);
}

function derivationRoots(
  read: ts.Node,
  owner: RuntimeFunctionLike,
  scope: DerivationScope,
): readonly ts.Node[] | null {
  const name = derivedBindingName(read, owner, scope.hops);
  if (!name) {
    return null;
  }
  const roots: ts.Node[] = [];
  for (const reference of ownerReferences(owner, name)) {
    const referenceRoots = runsOutsideRender(reference, owner, scope.imports)
      ? []
      : renderReadRoots(reference, owner, { ...scope, hops: scope.hops + 1 });
    if (!referenceRoots) {
      return null;
    }
    roots.push(...referenceRoots);
  }
  return roots;
}

function derivedBindingName(
  read: ts.Node,
  owner: RuntimeFunctionLike,
  hops: number,
): ts.Identifier | null {
  const declaration = findAncestorUntil(read, ts.isVariableDeclaration, owner);
  const statement = declaration?.parent.parent;
  return hops < MAX_DERIVATION_HOPS &&
    declaration &&
    ts.isIdentifier(declaration.name) &&
    statement &&
    ts.isVariableStatement(statement) &&
    statement.parent === owner.body
    ? declaration.name
    : null;
}

function ownerReferences(
  owner: RuntimeFunctionLike,
  name: ts.Identifier,
): readonly ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node !== name &&
      node.text === name.text &&
      !isNonValueIdentifier(node) &&
      !isDeclarationName(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

function isJsxChildExpression(node: ts.Node): node is ts.JsxExpression {
  return (
    ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
  );
}

function carriesBinding(attribute: ts.JsxAttribute, name: string): boolean {
  let found = false;
  visit(attribute.initializer, (node) => {
    found ||= ts.isIdentifier(node) && node.text === name && !isNonValueIdentifier(node);
  });
  return found;
}
