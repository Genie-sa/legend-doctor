import path from "node:path";

import ts from "typescript";

/** Canonical absolute path used as the stable SourceFile name. */
export function canonicalPath(fileName: string): string {
  return path.normalize(path.resolve(fileName));
}

/** Filesystem-aware lookup key for a canonical file identity. */
export function pathIdentityKey(fileName: string): string {
  const canonical = canonicalPath(fileName);
  return ts.sys.useCaseSensitiveFileNames ? canonical : canonical.toLowerCase();
}
