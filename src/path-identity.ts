import path from "node:path";

import ts from "typescript";

/** Canonical absolute path used as the stable SourceFile name. */
const canonicalPath = (fileName: string): string => path.normalize(path.resolve(fileName)),
  /** Filesystem-aware lookup key for a canonical file identity. */
  pathIdentityKey = (fileName: string): string => {
    const canonical = canonicalPath(fileName);
    if (ts.sys.useCaseSensitiveFileNames) {
      return canonical;
    }
    return canonical.toLowerCase();
  };

export { canonicalPath, pathIdentityKey };
