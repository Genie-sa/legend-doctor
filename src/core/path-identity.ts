import path from "node:path";

import ts from "typescript";

const MEMOIZED_IDENTITY_KEY_LIMIT = 131_072;
const identityKeys = new Map<string, string>();

/** Canonical absolute path used as the stable SourceFile name. */
const canonicalPath = (fileName: string): string => path.resolve(fileName);
/**
 * Filesystem-aware lookup key for a canonical file identity. The key of an absolute path depends
 * on nothing else, so it is memoized across scans; the bound keeps a long-lived process from
 * accumulating paths.
 */
const pathIdentityKey = (fileName: string): string => {
  const memoized = identityKeys.get(fileName);
  if (memoized !== undefined) {
    return memoized;
  }
  const canonical = canonicalPath(fileName);
  const key = ts.sys.useCaseSensitiveFileNames ? canonical : canonical.toLowerCase();
  if (path.isAbsolute(fileName)) {
    if (identityKeys.size >= MEMOIZED_IDENTITY_KEY_LIMIT) {
      identityKeys.clear();
    }
    identityKeys.set(fileName, key);
  }
  return key;
};

export { canonicalPath, pathIdentityKey };
