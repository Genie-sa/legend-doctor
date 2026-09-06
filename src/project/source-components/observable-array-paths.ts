import type { ResolvedSymbol, SourceIndexState } from "./model.js";
import { ROOT_PATH } from "../../core/observable-initial-value.js";
import { normalizeFile } from "./module-resolution.js";
import { observableContainerIsStable } from "./observable-containers.js";
import { resolvedFor } from "./symbol-resolution.js";

/**
 * Dotted paths, in the importing file's local names, of observables that start as array literals
 * where they are declared: module-level observables, their nested members, and the members of
 * stable observable containers, whether declared locally or imported.
 */
export function observableArrayPathsFor(
  state: SourceIndexState,
  file: string,
): ReadonlySet<string> {
  const paths = new Set<string>();
  const normalized = normalizeFile(file);
  for (const [name, arrayPaths] of state.records.get(normalized)?.observableArrayPaths ?? []) {
    addArrayPaths(paths, name, arrayPaths);
  }
  addImportedObservableArrayPaths(state, paths, normalized);
  for (const entry of resolvedFor(state, normalized, "observable-container")) {
    addContainerArrayPaths(state, paths, entry);
  }
  return paths;
}

function addImportedObservableArrayPaths(
  state: SourceIndexState,
  paths: Set<string>,
  importer: string,
): void {
  for (const [localName, symbol] of resolvedFor(state, importer, "observable")) {
    const arrayPaths = state.records.get(symbol.file)?.observableArrayPaths.get(symbol.localName);
    if (arrayPaths) {
      addArrayPaths(paths, localName, arrayPaths);
    }
  }
}

function addContainerArrayPaths(
  state: SourceIndexState,
  paths: Set<string>,
  [localName, symbol]: readonly [string, ResolvedSymbol],
): void {
  if (!observableContainerIsStable(state, symbol)) {
    return;
  }
  const prefix = `${symbol.localName}.`;
  for (const [name, arrayPaths] of state.records.get(symbol.file)?.observableArrayPaths ?? []) {
    if (name.startsWith(prefix)) {
      addArrayPaths(paths, `${localName}.${name.slice(prefix.length)}`, arrayPaths);
    }
  }
}

function addArrayPaths(paths: Set<string>, name: string, arrayPaths: ReadonlySet<string>): void {
  for (const path of arrayPaths) {
    paths.add(path === ROOT_PATH ? name : `${name}.${path}`);
  }
}
