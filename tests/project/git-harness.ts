import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const COMPONENT = "export function C() { return <div />; }\n";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.name=legend-doctor", "-c", "user.email=doctor@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
  return stdout;
}

export async function gitFixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await git(root, "init", "-q", "-b", "main");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "committed.tsx"), COMPONENT, "utf8");
  await writeFile(path.join(root, "src", "edited.tsx"), COMPONENT, "utf8");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "init");
  return root;
}
