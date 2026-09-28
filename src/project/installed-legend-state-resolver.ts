import type { InstalledLegendState } from "../core/types.js";
import path from "node:path";
import { resolveInstalledLegendState } from "./legend-state-package.js";
import ts from "typescript";

const INSTALLED_MANIFEST = path.join("node_modules", "@legendapp", "state", "package.json");

/**
 * Resolves the `@legendapp/state` install each file imports, as Node does from the file's directory, so a
 * workspace package that installs its own copy is gated by that copy even when the root has none. Files with
 * no install above them keep the analysis root's resolution, including its lockfile fallback.
 */
export class InstalledLegendStateResolver {
  private readonly installs = new Map<string, Promise<InstalledLegendState | null>>();
  private readonly owners = new Map<string, string | null>();
  private readonly rootInstall: InstalledLegendState | null;

  public constructor(rootInstall: InstalledLegendState | null) {
    this.rootInstall = rootInstall;
  }

  public resolveForFile(filePath: string): Promise<InstalledLegendState | null> {
    const owner = this.installOwnerOf(path.dirname(path.resolve(filePath)));
    if (owner === null) {
      return Promise.resolve(this.rootInstall);
    }
    const cached = this.installs.get(owner);
    if (cached) {
      return cached;
    }
    const install = resolveInstalledLegendState(owner);
    this.installs.set(owner, install);
    return install;
  }

  private installOwnerOf(directory: string): string | null {
    const cached = this.owners.get(directory);
    if (cached !== undefined) {
      return cached;
    }
    const parent = path.dirname(directory);
    let owner: string | null = null;
    if (ts.sys.fileExists(path.join(directory, INSTALLED_MANIFEST))) {
      owner = directory;
    } else if (parent !== directory) {
      owner = this.installOwnerOf(parent);
    }
    this.owners.set(directory, owner);
    return owner;
  }
}
