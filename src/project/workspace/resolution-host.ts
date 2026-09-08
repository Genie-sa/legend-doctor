import type { WorkspaceLink } from "./packages.js";
import { isWithin } from "./packages.js";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";
import type ts from "typescript";

/** Present declared workspace links to TypeScript without creating node_modules or bypassing exports. */
export function workspaceResolutionHost(
  base: ts.ModuleResolutionHost,
  links: readonly WorkspaceLink[],
): ts.ModuleResolutionHost {
  const target = (file: string): string => linkedPath(links, file);
  return {
    ...base,
    directoryExists: (directory) =>
      (base.directoryExists?.(target(directory)) ?? false) ||
      links.some((link) => isWithin(directory, link.from)),
    fileExists: (file) => base.fileExists(target(file)),
    readFile: (file) => base.readFile(target(file)),
    realpath: (file) => {
      const linked = target(file);
      return linked === file ? (base.realpath?.(file) ?? file) : linked;
    },
  };
}

function linkedPath(links: readonly WorkspaceLink[], file: string): string {
  const link = links.find((candidate) => isWithin(candidate.from, file));
  return link
    ? path.join(link.to, path.relative(pathIdentityKey(link.from), pathIdentityKey(file)))
    : file;
}
