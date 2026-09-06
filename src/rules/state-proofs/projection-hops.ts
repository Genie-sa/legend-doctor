import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nodeWithin, visit } from "../../core/ast.js";
import { EMPTY_BINDINGS } from "./jsx-subtrees.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isSafeProjectionExpression } from "../deferred-reveal/safe-projections.js";
import { sourceHasRuntimeBinding } from "./binding-lookup.js";
import ts from "typescript";

/** A projection trail that stops on its own is only trusted once it has settled for two hops. */
const MIN_SETTLED_PROJECTION_HOPS = 2;

const PURE_MATH_PROJECTION_CALLS: ReadonlySet<string> = new Set(["Math.max", "Math.min"]);

export function oneHopRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
  isAllowedProjection: typeof isSafeProjectionExpression = isSafeProjectionExpression,
): readonly ts.Identifier[] | null {
  if (renderNodes.length === 0 || renderNodes.some((node) => !ts.isIdentifier(node))) {
    return null;
  }
  const declaration = soleVariableDeclaration(renderNodes, owner);
  if (!declaration) {
    // SAFETY: The entry guard proves every render node is an Identifier.
    return renderNodes as readonly ts.Identifier[];
  }
  const projection = constProjectionDeclaration(declaration, owner, renderNodes);
  if (
    !projection ||
    !renderNodes.every((node) =>
      isAllowedProjection({ expression: projection.initializer, reference: node }),
    )
  ) {
    return null;
  }
  const references = bindingReferences(owner, projection.name);
  return references.length > 0 ? references : null;
}

export function boundedRenderProjectionReferences(
  owner: RuntimeFunctionLike,
  renderNodes: readonly ts.Node[],
  maxHops = 3,
): readonly ts.Identifier[] | null {
  if (renderNodes.length === 0 || renderNodes.some((node) => !ts.isIdentifier(node))) {
    return null;
  }
  // SAFETY: The entry guard proves every render node is an Identifier.
  return followProjectionHops(renderNodes as readonly ts.Identifier[], owner, maxHops);
}

/**
 * Walks up to `maxHops` single-declaration projection hops. The trail settles when a hop has no
 * enclosing declaration left; running out of hops instead requires the references to be free.
 */
function followProjectionHops(
  renderNodes: readonly ts.Identifier[],
  owner: RuntimeFunctionLike,
  maxHops: number,
): readonly ts.Identifier[] | null {
  let references = renderNodes;
  for (let hops = 0; hops < maxHops; hops += 1) {
    const declaration = soleVariableDeclaration(references, owner);
    if (!declaration) {
      return hops >= MIN_SETTLED_PROJECTION_HOPS ? references : null;
    }
    const next = nextProjectionHop(declaration, owner, references);
    if (!next) {
      return null;
    }
    references = next;
  }
  return references.some((node) => findAncestorUntil(node, ts.isVariableDeclaration, owner))
    ? null
    : references;
}

/** The references to the declared binding, or null when this hop is not a safe pure projection. */
function nextProjectionHop(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
  references: readonly ts.Identifier[],
): ts.Identifier[] | null {
  const projection = constProjectionDeclaration(declaration, owner, references);
  if (
    !projection ||
    !references.every((node) =>
      isSafeProjectionExpression({
        expression: projection.initializer,
        reference: node,
        allowedIdentifierCalls: EMPTY_BINDINGS,
        allowedPropertyCalls: sourceHasRuntimeBinding(owner.getSourceFile(), "Math")
          ? EMPTY_BINDINGS
          : PURE_MATH_PROJECTION_CALLS,
      }),
    )
  ) {
    return null;
  }
  const next = bindingReferences(owner, projection.name);
  return next.length > 0 ? next : null;
}

/** The one variable declaration that encloses every node, or null when they disagree. */
function soleVariableDeclaration(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): ts.VariableDeclaration | null {
  const declarations = new Set(
    nodes.map((node) => findAncestorUntil(node, ts.isVariableDeclaration, owner)),
  );
  if (declarations.size !== 1) {
    return null;
  }
  const [declaration] = declarations;
  return declaration ?? null;
}

/** A uniquely bound `const x = <initializer>` whose initializer contains every reference. */
function constProjectionDeclaration(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
  references: readonly ts.Node[],
): { readonly initializer: ts.Expression; readonly name: ts.Identifier } | null {
  const { initializer, name } = declaration;
  if (
    !initializer ||
    !ts.isIdentifier(name) ||
    !references.every((node) => nodeWithin(node, initializer)) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    bindingDeclarationCount(owner, name.text) !== 1
  ) {
    return null;
  }
  return { initializer, name };
}

/** Every value reference to the binding inside the owner, excluding its own declaration name. */
function bindingReferences(owner: RuntimeFunctionLike, name: ts.Identifier): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name.text &&
      node !== name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}
