import type { LegendPracticesRequest } from "./model.js";
import { hasSoleSourceBinding } from "../rules/observable-reads/independent-subscription-bindings.js";

/**
 * Imported shape facts describe one module binding. When a local binding reuses the name, a
 * reference may resolve to either declaration, so neither may borrow the imported shape.
 */
export function withSoleBindingFacts(request: LegendPracticesRequest): LegendPracticesRequest {
  const hasSoleRoot = (path: string): boolean =>
    hasSoleSourceBinding(request.sourceFile, path.split(".")[0]!);
  const solePaths = (paths: ReadonlySet<string> | undefined): ReadonlySet<string> =>
    new Set([...(paths ?? [])].filter((path) => hasSoleRoot(path)));
  return {
    ...request,
    importedObservableArrayPaths: solePaths(request.importedObservableArrayPaths),
    importedObservableKeys: new Map(
      [...request.importedObservableKeys].filter(([name]) => hasSoleRoot(name)),
    ),
    importedObservablePlainSeedPaths: solePaths(request.importedObservablePlainSeedPaths),
    importedObservablePrimitivePaths: solePaths(request.importedObservablePrimitivePaths),
  };
}
