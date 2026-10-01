import { PackageJsonMissingNameError, getPackages } from "@manypkg/get-packages";
import type { Package } from "@manypkg/get-packages";
import type { WorkspaceLinkPolicy } from "./link-policy.js";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";
import { satisfies } from "semver";
import ts from "typescript";
import { workspaceLinkPolicy } from "./link-policy.js";

const WORKSPACE_PROTOCOL = /^workspace:(?<range>.*)$/u;
const ANY_WORKSPACE_VERSION = new Set(["*", "^", "~"]);

export interface Workspace {
  readonly linkPolicy: WorkspaceLinkPolicy;
  readonly packages: readonly Package[];
}

export async function loadWorkspace(root: string): Promise<Workspace | null> {
  if (!ts.findConfigFile(root, ts.sys.fileExists, "package.json")) {
    return null;
  }
  try {
    const { packages, rootDir, tool } = await getPackages(root);
    return tool.type === "root" || packages.length === 0
      ? null
      : { linkPolicy: await workspaceLinkPolicy(tool.type, rootDir), packages };
  } catch (error) {
    // Incomplete manifests cannot establish package identity; keep source proofs unavailable.
    if (error instanceof PackageJsonMissingNameError) {
      return null;
    }
    throw error;
  }
}

export function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(pathIdentityKey(directory), pathIdentityKey(file));
  return relative === "" || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..");
}

export interface WorkspaceLink {
  from: string;
  to: string;
}

/** Links the declared dependencies that the workspace's package manager installs from a sibling package. */
export function workspaceLinks(workspace: Workspace): readonly WorkspaceLink[] {
  const { linkPolicy, packages } = workspace;
  return packages.flatMap((owner) => {
    const dependencies = {
      ...owner.packageJson.devDependencies,
      ...owner.packageJson.dependencies,
    };
    return Object.entries(dependencies).flatMap(([name, specifier]) => {
      const matches = packages.filter((candidate) => candidate.packageJson.name === name);
      const from = path.join(owner.dir, "node_modules", name);
      return matches.length === 1 &&
        linksToSibling(linkPolicy, specifier, matches[0]!) &&
        !hasInstalledPackage(owner.dir, name)
        ? [{ from, to: matches[0]!.dir }]
        : [];
    });
  });
}

/** Whether the package manager installs `specifier` as a link to the sibling package. */
export function linksToSibling(
  policy: WorkspaceLinkPolicy,
  specifier: string,
  sibling: Package,
): boolean {
  const protocolRange = WORKSPACE_PROTOCOL.exec(specifier)?.groups?.["range"];
  if (protocolRange === undefined) {
    return policy.semverRanges && versionSatisfies(sibling, specifier);
  }
  return (
    policy.workspaceProtocol &&
    (ANY_WORKSPACE_VERSION.has(protocolRange) || versionSatisfies(sibling, protocolRange))
  );
}

/** Package managers compare the sibling's own version with loose semver, so prereleases match only when named. */
function versionSatisfies(sibling: Package, range: string): boolean {
  const version: string | undefined = sibling.packageJson.version;
  return version !== undefined && range.trim() !== "" && satisfies(version, range, { loose: true });
}

function hasInstalledPackage(directory: string, name: string): boolean {
  if (ts.sys.directoryExists(path.join(directory, "node_modules", name))) {
    return true;
  }
  const parent = path.dirname(directory);
  return parent !== directory && hasInstalledPackage(parent, name);
}
