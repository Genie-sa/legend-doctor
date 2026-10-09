import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { parse as parseYaml } from "yaml";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import test from "node:test";

const run = promisify(execFile);
const ACTION_PATH = path.join(import.meta.dirname, "..", "..", "..", "action.yml");
const GATE_EXIT_CODE = 3;

interface ActionManifest {
  readonly runs: { readonly steps: readonly { readonly name?: string; readonly run?: string }[] };
}

interface ScriptFailure {
  readonly code: number;
  readonly stdout: string;
}

async function gateScript(): Promise<string> {
  // SAFETY: action.yml is this repository's composite action manifest; `runs.steps` is its schema.
  const action = parseYaml(await readFile(ACTION_PATH, "utf8")) as ActionManifest;
  const gate = action.runs.steps.find((step) => step.name === "Gate");
  assert.ok(gate?.run, "action.yml has a Gate step with a run script");
  return gate.run;
}

async function runExpectingFailure(script: string, reason: string): Promise<ScriptFailure> {
  try {
    await run("bash", ["-c", script], { env: { ...process.env, REASON: reason } });
  } catch (error) {
    // SAFETY: execFile rejects with an Error carrying the child's exit code and captured stdout;
    // Both properties are read through a fallback below.
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 0, stdout: failure.stdout ?? "" };
  }
  throw new Error("expected the Gate step to fail");
}

test("the Gate step reports a multi-line reason as one workflow command", async () => {
  const failure = await runExpectingFailure(
    await gateScript(),
    "50% of src/x.ts\n::warning::injected\rline",
  );

  assert.equal(failure.code, GATE_EXIT_CODE);
  assert.equal(failure.stdout, "::error::50%25 of src/x.ts%0A::warning::injected%0Dline\n");
});
