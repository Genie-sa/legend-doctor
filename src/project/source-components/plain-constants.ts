import {
  localPlainConstants,
  plainSeedPaths,
} from "../../rules/observable-reads/plain-seed-paths.js";
import type { SourceIndexState } from "./model.js";
import { hasSoleSourceBinding } from "../../rules/observable-reads/independent-subscription-bindings.js";
import { normalizeFile } from "./module-resolution.js";
import { observableDeclarationPathsFor } from "./observable-primitive-paths.js";
import { resolvedFor } from "./symbol-resolution.js";

/**
 * Names in `file` bound to a module `const` of a plain scalar literal, declared locally or imported
 * from the module that declares it. A name any other binding in the file reuses is left out.
 */
export function plainConstantsFor(state: SourceIndexState, file: string): ReadonlySet<string> {
  const sourceFile = state.sourceFiles.get(normalizeFile(file));
  if (!sourceFile) {
    return new Set();
  }
  const imported = [...resolvedFor(state, file, "plain-constant").keys()].filter((name) =>
    hasSoleSourceBinding(sourceFile, name),
  );
  return new Set([...localPlainConstants(sourceFile), ...imported]);
}

export function observablePlainSeedPathsFor(
  state: SourceIndexState,
  file: string,
): ReadonlySet<string> {
  return observableDeclarationPathsFor(state, file, (declaration, declaringFile) =>
    plainSeedPaths(declaration, plainConstantsFor(state, declaringFile)),
  );
}
