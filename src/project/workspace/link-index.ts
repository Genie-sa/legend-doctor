import type { WorkspaceLink } from "./packages.js";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";

export interface WorkspaceLinkIndex {
  containsLink: (directory: string) => boolean;
  linkedPath: (file: string) => string;
}

/** Answer link containment by walking a path's ancestors, so each probe costs its depth, not the link count. */
export function workspaceLinkIndex(links: readonly WorkspaceLink[]): WorkspaceLinkIndex {
  const firstLinkByKey = new Map<string, number>();
  const linkAncestors = new Set<string>();
  for (const [order, link] of links.entries()) {
    const key = pathIdentityKey(link.from);
    if (!firstLinkByKey.has(key)) {
      firstLinkByKey.set(key, order);
    }
    for (const ancestor of ancestorKeys(key)) {
      linkAncestors.add(ancestor);
    }
  }
  return {
    containsLink: memoized((directory) => linkAncestors.has(pathIdentityKey(directory))),
    linkedPath: memoized((file) => linkedPath(links, firstLinkByKey, file)),
  };
}

function linkedPath(
  links: readonly WorkspaceLink[],
  firstLinkByKey: ReadonlyMap<string, number>,
  file: string,
): string {
  const fileKey = pathIdentityKey(file);
  const orders = ancestorKeys(fileKey).flatMap((ancestor) => firstLinkByKey.get(ancestor) ?? []);
  // Overlapping links resolve to the earliest declared one, not the nearest.
  const link = links[Math.min(...orders)];
  return link ? path.join(link.to, path.relative(pathIdentityKey(link.from), fileKey)) : file;
}

function ancestorKeys(key: string): readonly string[] {
  const parent = path.dirname(key);
  return parent === key ? [key] : [key, ...ancestorKeys(parent)];
}

function memoized<Value extends boolean | string>(
  compute: (file: string) => Value,
): (file: string) => Value {
  const cache = new Map<string, Value>();
  return (file) => {
    const cached = cache.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const value = compute(file);
    cache.set(file, value);
    return value;
  };
}
