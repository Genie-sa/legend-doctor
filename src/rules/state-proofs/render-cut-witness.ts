import { nodeWithin, visit, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import ts from "typescript";

/** Two independent elements are the smallest render cut worth reporting on its own. */
const MIN_INDEPENDENT_JSX_ELEMENTS = 2;

export interface RenderCutWitnessQuery {
  readonly excluded: readonly ts.Node[];
  readonly localComponents: ReadonlySet<string>;
  readonly returned: ts.Expression;
  readonly sourceComponents: ReadonlySet<string>;
}

export function hasIndependentRenderCutWitness({
  excluded,
  localComponents,
  returned,
  sourceComponents,
}: RenderCutWitnessQuery): boolean {
  let hasIndependentComponent = false;
  let independentElements = 0;
  visitSkippingNestedRuntimeFunctions(returned, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return;
    }
    const subtree: ts.Node = ts.isJsxOpeningElement(node) ? node.parent : node;
    if (
      !isIndependentOfAll(subtree, excluded) ||
      hasIndependentJsxAncestor(subtree, returned, excluded)
    ) {
      return;
    }
    independentElements += 1;
    hasIndependentComponent ||= containsComponentBoundary(
      subtree,
      localComponents,
      sourceComponents,
    );
  });
  return hasIndependentComponent || independentElements >= MIN_INDEPENDENT_JSX_ELEMENTS;
}

/** The candidate neither is, nor contains, nor sits inside any already-excluded subtree. */
function isIndependentOfAll(candidate: ts.Node, excluded: readonly ts.Node[]): boolean {
  return excluded.every(
    (subtree) =>
      candidate !== subtree && !nodeWithin(candidate, subtree) && !nodeWithin(subtree, candidate),
  );
}

/** A nearer independent JSX ancestor already counts this subtree, so it must not count again. */
function hasIndependentJsxAncestor(
  subtree: ts.Node,
  returned: ts.Node,
  excluded: readonly ts.Node[],
): boolean {
  for (
    let current: ts.Node | undefined = subtree.parent;
    current && current !== returned;
    current = current.parent
  ) {
    if (
      (ts.isJsxElement(current) ||
        ts.isJsxFragment(current) ||
        ts.isJsxSelfClosingElement(current)) &&
      isIndependentOfAll(current, excluded)
    ) {
      return true;
    }
  }
  return false;
}

function containsComponentBoundary(
  subtree: ts.Node,
  localComponents: ReadonlySet<string>,
  sourceComponents: ReadonlySet<string>,
): boolean {
  let found = false;
  visit(subtree, (descendant) => {
    if (found || (!ts.isJsxOpeningElement(descendant) && !ts.isJsxSelfClosingElement(descendant))) {
      return;
    }
    const name = descendant.tagName.getText();
    found =
      isComponentBoundaryName(name) || localComponents.has(name) || sourceComponents.has(name);
  });
  return found;
}

function isComponentBoundaryName(name: string): boolean {
  const member = name.slice(name.lastIndexOf(".") + 1);
  return member !== "Fragment" && (name.includes(".") || /^[A-Z]/u.test(name));
}
