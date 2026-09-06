import { collectHookImports } from "../../core/imports.js";
import type ts from "typescript";

export const CALLBACK_IDENTITY_HOOKS = new Set([
  "useCallback",
  "useEffect",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
]);

const reactNamespacesBySourceFile = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

export function reactNamespacesFor(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = reactNamespacesBySourceFile.get(sourceFile);
  if (cached) {
    return cached;
  }
  const namespaces = collectHookImports(sourceFile).reactNamespaces;
  reactNamespacesBySourceFile.set(sourceFile, namespaces);
  return namespaces;
}
