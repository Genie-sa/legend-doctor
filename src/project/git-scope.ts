import { GitScopeError } from "./git-scope-error.js";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathIdentityKey } from "../core/path-identity.js";
import { promisify } from "node:util";

export { GitScopeError } from "./git-scope-error.js";

const run = promisify(execFile);

/** 64 MiB, enough for the path list of any repository git can diff in one call. */
const GIT_OUTPUT_LIMIT = 67_108_864;

export type ScanScopeMode = "changed" | "since" | "staged";

export type ScanScope =
  | { readonly mode: "changed" | "staged" }
  | { readonly mode: "since"; readonly ref: string };

class GitCommands {
  private readonly cwd: string;

  public constructor(cwd: string) {
    this.cwd = cwd;
  }

  public async assertWorkTree(): Promise<void> {
    await this.stdout(["rev-parse", "--is-inside-work-tree"]);
  }

  public async hasHead(): Promise<boolean> {
    try {
      await this.stdout(["rev-parse", "--verify", "--quiet", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  public async mergeBase(ref: string): Promise<string> {
    try {
      const output = await this.stdout(["merge-base", ref, "HEAD"]);
      return output.trim();
    } catch (error) {
      throw new GitScopeError(
        `--since needs a ref that shares history with HEAD; git could not resolve '${ref}': ${gitFailure(error).detail}`,
      );
    }
  }

  public async pathList(args: readonly string[]): Promise<string[]> {
    const output = await this.stdout([...args, "-z"]);
    return output.split("\0").filter((entry) => entry.length > 0);
  }

  private async stdout(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await run("git", args, {
        cwd: this.cwd,
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
      });
      return stdout;
    } catch (error) {
      throw this.describe(gitFailure(error), args);
    }
  }

  private describe(failure: GitFailure, args: readonly string[]): Error {
    if (failure.kind === "git-missing") {
      return new GitScopeError("scope flags need git on PATH; git was not found");
    }
    if (failure.kind === "git-exited" && args[1] === "--is-inside-work-tree") {
      return new GitScopeError(
        `scope flags need a git work tree; '${this.cwd}' is not inside one: ${failure.detail}`,
      );
    }
    return failure.cause instanceof Error ? failure.cause : new Error(failure.detail);
  }
}

/**
 * Resolves the files a scope flag selects under `root`, as path identity keys of absolute paths.
 * `changed` and `since` include uncommitted and untracked work; `staged` reads the index.
 * Deleted paths are dropped because there is nothing left to analyze. Git output stays relative
 * to `root` rather than the repository top level, which git reports as a realpath that would not
 * match a symlinked scan root.
 */
export async function resolveScopedFiles(
  root: string,
  scope: ScanScope,
): Promise<ReadonlySet<string>> {
  const git = new GitCommands(root);
  await git.assertWorkTree();
  const relativePaths = await scopedPaths(git, scope);
  return new Set(relativePaths.map((relative) => pathIdentityKey(path.join(root, relative))));
}

async function scopedPaths(git: GitCommands, scope: ScanScope): Promise<string[]> {
  const hasHead = await git.hasHead();
  if (!hasHead) {
    return scope.mode === "staged"
      ? git.pathList(["ls-files", "--cached"])
      : git.pathList(["ls-files", "--cached", "--others", "--exclude-standard"]);
  }
  if (scope.mode === "staged") {
    return git.pathList(["diff", "--name-only", "--relative", "--diff-filter=d", "--cached"]);
  }
  const base = scope.mode === "since" ? await git.mergeBase(scope.ref) : "HEAD";
  const [tracked, untracked] = await Promise.all([
    git.pathList(["diff", "--name-only", "--relative", "--diff-filter=d", base]),
    git.pathList(["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...tracked, ...untracked];
}

interface GitFailure {
  readonly cause: unknown;
  readonly detail: string;
  readonly kind: "git-exited" | "git-missing" | "unexpected";
}

interface ProcessFailure extends Error {
  readonly code?: number | string;
  readonly stderr?: string;
}

function isProcessFailure(cause: unknown): cause is ProcessFailure {
  return cause instanceof Error && Object.hasOwn(cause, "code");
}

/** Parses a rejected child-process promise at the boundary into a named failure. */
function gitFailure(cause: unknown): GitFailure {
  if (!isProcessFailure(cause)) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { cause, detail, kind: "unexpected" };
  }
  const detail = cause.stderr?.trim().split("\n")[0] || cause.message;
  if (cause.code === "ENOENT") {
    return { cause, detail, kind: "git-missing" };
  }
  return { cause, detail, kind: Number.isInteger(cause.code) ? "git-exited" : "unexpected" };
}
