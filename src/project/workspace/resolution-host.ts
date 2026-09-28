import type { WorkspaceLink } from "./packages.js";
import type ts from "typescript";
import { workspaceLinkIndex } from "./link-index.js";

/** Present declared workspace links to TypeScript without creating node_modules or bypassing exports. */
export function workspaceResolutionHost(
  base: ts.ModuleResolutionHost,
  links: readonly WorkspaceLink[],
): ts.ModuleResolutionHost {
  const { containsLink, linkedPath: target } = workspaceLinkIndex(links);
  return {
    ...base,
    directoryExists: (directory) =>
      (base.directoryExists?.(target(directory)) ?? false) || containsLink(directory),
    fileExists: (file) => base.fileExists(target(file)),
    readFile: (file) => base.readFile(target(file)),
    realpath: (file) => {
      const linked = target(file);
      return linked === file ? (base.realpath?.(file) ?? file) : linked;
    },
  };
}
