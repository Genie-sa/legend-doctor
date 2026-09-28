import type { ObservableReadScan } from "./model.js";
import { pathsOverlap } from "./field-writes.js";
import { staticPropertyPath } from "../../core/analysis-ast.js";
import type ts from "typescript";

/** A production write that changes a node under the subscribed parent but not the narrowed leaf. */
export interface SiblingWrite {
  /** The written observable path, rooted at the parent's local binding. */
  readonly path: string;
  /** `file:line` of the writing line. */
  readonly site: string;
}

/**
 * Narrowing `useValue(parent$)` to `useValue(parent$.leaf)` removes a render only when something
 * under the parent can change while the leaf does not. Every write on the proving line must miss
 * the leaf, so a line that also rewrites the leaf, its ancestors, or a runtime-keyed member proves
 * nothing.
 */
export function independentSiblingWrite(
  parent: ts.Expression,
  leaf: readonly string[],
  scan: ObservableReadScan,
): SiblingWrite | null {
  const [root, ...members] = staticPropertyPath(parent) ?? [];
  if (root === undefined) {
    return null;
  }
  const target = [...members, ...leaf];
  for (const group of scan.observableFields.writes.get(root) ?? []) {
    const sibling = group.paths.find(
      (path) => isBelow(path, members) && !pathsOverlap(path, target),
    );
    if (sibling && group.paths.every((path) => !pathsOverlap(path, target))) {
      return { path: [root, ...sibling].join("."), site: group.site };
    }
  }
  return null;
}

function isBelow(path: readonly string[], members: readonly string[]): boolean {
  return path.length > members.length && members.every((member, index) => path[index] === member);
}
