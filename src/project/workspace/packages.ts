import { PackageJsonMissingNameError, getPackages } from "@manypkg/get-packages";
import type { Package } from "@manypkg/get-packages";
import path from "node:path";
import { pathIdentityKey } from "../../core/path-identity.js";
import ts from "typescript";

export async function workspacePackages(root: string): Promise<readonly Package[]> {
  if (!ts.findConfigFile(root, ts.sys.fileExists, "package.json")) {
    return [];
  }
  try {
    const result = await getPackages(root);
    return result.tool.type === "root" ? [] : result.packages;
  } catch (error) {
    // Incomplete manifests cannot establish package identity; keep source proofs unavailable.
    if (error instanceof PackageJsonMissingNameError) {
      return [];
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

export function workspaceLinks(packages: readonly Package[]): readonly WorkspaceLink[] {
  return packages.flatMap((owner) => {
    const dependencies = {
      ...owner.packageJson.devDependencies,
      ...owner.packageJson.dependencies,
    };
    return Object.entries(dependencies).flatMap(([name, version]) => {
      const matches = packages.filter((candidate) => candidate.packageJson.name === name);
      const from = path.join(owner.dir, "node_modules", name);
      return version === "workspace:*" &&
        matches.length === 1 &&
        !hasInstalledPackage(owner.dir, name)
        ? [{ from, to: matches[0]!.dir }]
        : [];
    });
  });
}

function hasInstalledPackage(directory: string, name: string): boolean {
  if (ts.sys.directoryExists(path.join(directory, "node_modules", name))) {
    return true;
  }
  const parent = path.dirname(directory);
  return parent !== directory && hasInstalledPackage(parent, name);
}
