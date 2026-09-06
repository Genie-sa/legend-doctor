import { mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

export const run = promisify(execFile);

export const CLI_PATH = path.join(import.meta.dirname, "..", "..", "src", "cli.js");

export async function writeFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-cli-"));
  await writeFile(
    path.join(root, "store.ts"),
    `
      import { observable } from "@legendapp/state";
      export const player$ = observable({ index: -1, isPlaying: false });
      export function play(index: number) {
        player$.index.set(index);
        player$.isPlaying.set(true);
      }
    `,
    "utf8",
  );
  await writeFile(
    path.join(root, "screen.tsx"),
    `
      import { useState } from "react";
      export function Counter() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(count + 1)}>{count}</button>;
      }
    `,
    "utf8",
  );
  return root;
}

interface CliFailure {
  code: number;
  stderr: string;
  stdout: string;
}

export async function runExpectingFailure(args: readonly string[]): Promise<CliFailure> {
  try {
    await run(process.execPath, [CLI_PATH, ...args]);
  } catch (error) {
    // SAFETY: execFile rejects with an Error carrying the child's exit code and captured streams;
    // Every property of the asserted shape is optional and read through a `??` fallback below.
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    return { code: failure.code ?? 0, stderr: failure.stderr ?? "", stdout: failure.stdout ?? "" };
  }
  throw new Error(`expected CLI failure for: ${args.join(" ")}`);
}

export interface FailurePayload {
  message: string;
  next?: string[];
  reason: string;
  schemaVersion: number;
  status: "error";
}

/** Runs the CLI expecting a failure and parses the JSON payload it always writes to stdout. */
export async function failurePayload(
  args: readonly string[],
): Promise<{ code: number; payload: FailurePayload; stderr: string }> {
  const failure = await runExpectingFailure(args);
  // SAFETY: the CLI writes every failure as a JSON payload on stdout.
  const payload = JSON.parse(failure.stdout) as FailurePayload;
  return { code: failure.code, payload, stderr: failure.stderr };
}
