import { URL, fileURLToPath } from "node:url";
import type { ScanBudget } from "../performance-budgets.js";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";

const BENCHMARK_ENTRY = fileURLToPath(new URL("../benchmark.js", import.meta.url));

const OUT_OF_MEMORY = /heap out of memory/u;

const MILLISECONDS_PER_SECOND = 1000;

/** The fields of an `evals/benchmark.ts` sample the budget report prints. */
export interface ScanSample {
  readonly files: number;
  readonly hooks: number;
  readonly maxRssMiB: number;
}

export type ScanOutcome =
  | { readonly passed: true; readonly sample: ScanSample; readonly seconds: number }
  | { readonly passed: false; readonly reason: string; readonly seconds: number };

interface ChildExit {
  readonly exitCode: number | null;
  /** Only the deadline kills the child from this process; an external SIGKILL leaves this false. */
  readonly killedAtDeadline: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function runChild(args: readonly string[], timeoutMs: number): Promise<ChildExit> {
  const child = spawn(process.execPath, args, {
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "close"),
  ]);
  return {
    exitCode: child.exitCode,
    killedAtDeadline: child.killed,
    signal: child.signalCode,
    stderr,
    stdout,
  };
}

function sampleField(fields: ReadonlyMap<string, unknown>, name: keyof ScanSample): number {
  const value = fields.get(name);
  if (!Number.isFinite(value)) {
    throw new TypeError(`Benchmark sample has no numeric ${name}`);
  }
  return Number(value);
}

export function parseScanSample(stdout: string): ScanSample {
  const parsed: unknown = JSON.parse(stdout);
  const fields = new Map(parsed instanceof Object ? Object.entries(parsed) : []);
  return {
    files: sampleField(fields, "files"),
    hooks: sampleField(fields, "hooks"),
    maxRssMiB: sampleField(fields, "maxRssMiB"),
  };
}

function lastLine(output: string): string {
  return output.trimEnd().split("\n").at(-1) ?? "";
}

function failureReason(exit: ChildExit, budget: ScanBudget): string | null {
  if (exit.killedAtDeadline) {
    return `exceeded the ${budget.timeLimitSeconds}s time limit`;
  }
  if (OUT_OF_MEMORY.test(exit.stderr)) {
    return `ran out of memory at the ${budget.heapLimitMiB} MiB heap limit`;
  }
  if (exit.exitCode !== 0) {
    return `exited with ${exit.signal ?? `code ${exit.exitCode}`}: ${lastLine(exit.stderr)}`;
  }
  return null;
}

/**
 * Scans `root` in a fresh Node process capped at the budget's heap and killed at its time limit,
 * so an out-of-memory crash or a runaway scan fails its repository instead of the whole runner.
 */
export async function measureScan(root: string, budget: ScanBudget): Promise<ScanOutcome> {
  const start = performance.now();
  const exit = await runChild(
    [`--max-old-space-size=${budget.heapLimitMiB}`, BENCHMARK_ENTRY, root],
    budget.timeLimitSeconds * MILLISECONDS_PER_SECOND,
  );
  const seconds = (performance.now() - start) / MILLISECONDS_PER_SECOND;
  const reason = failureReason(exit, budget);
  return reason === null
    ? { passed: true, sample: parseScanSample(exit.stdout), seconds }
    : { passed: false, reason, seconds };
}

export function scanOutcomeLine(
  repository: string,
  budget: ScanBudget,
  outcome: ScanOutcome,
): string {
  const timing = `${outcome.seconds.toFixed(1)}s (limit ${budget.timeLimitSeconds}s)`;
  if (!outcome.passed) {
    return `${repository}: failed after ${timing}: ${outcome.reason}`;
  }
  const { files, hooks, maxRssMiB } = outcome.sample;
  return `${repository}: ${timing}, peak RSS ${Math.round(maxRssMiB)} MiB, ${files} files, ${hooks} hooks`;
}
