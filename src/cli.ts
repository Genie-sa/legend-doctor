#!/usr/bin/env node

import type { AnalysisReport, HookFinding, LegendPracticeFinding } from "./types.js";
import { agentFindings, formatTextReport } from "./format.js";
import { analyzePath, analyzePathDetailed } from "./analyze-path.js";
import { readFile, stat } from "node:fs/promises";
import { URL } from "node:url";
import path from "node:path";
import process from "node:process";

type Disposition = HookFinding["disposition"] | LegendPracticeFinding["disposition"];

const DISPOSITIONS: readonly Disposition[] = ["candidate", "change", "keep", "style"];
const DISPOSITION_VALUES: ReadonlySet<string> = new Set(DISPOSITIONS);
const CLI_ARGUMENT_OFFSET = 2;
const JSON_INDENT = 2;
const MAX_FLAG_SUGGESTION_DISTANCE = 3;
const EXIT_INVALID_USAGE = 2;
const EXIT_SCAN_FAILED = 1;
const BOOLEAN_FLAGS = new Map<string, "actionable" | "coverage" | "help" | "json" | "version">([
  ["--actionable", "actionable"],
  ["--coverage", "coverage"],
  ["--help", "help"],
  ["-h", "help"],
  ["--json", "json"],
  ["--version", "version"],
  ["-v", "version"],
]);
const KNOWN_FLAGS = [
  "--actionable",
  "--coverage",
  "--disposition",
  "--help",
  "--json",
  "--version",
];
const HELP = `legend-doctor — read-only React hook and Legend State triage for coding agents

Usage
  legend-doctor [target] [flags]

  target  File or directory to scan. Defaults to the current working directory.
          Scan the smallest complete root that contains the relevant components,
          hooks, imports, re-exports, and observables; a single-file scan can
          hide the proof a safe finding needs.

Flags
  --json                 Emit the full machine-readable report on stdout.
                         This is the agent interface; stdout stays valid JSON.
  --actionable           Hide keep findings and secondary members of finding
                         groups, leaving one entry per edit.
  --disposition <value>  Keep only findings with this disposition:
                         candidate | change | keep | style
  --coverage             Add parsed files, functions, diagnostics, and skipped
                         analysis stages to the report. Requires --json.
  -h, --help             Show this help.
  -v, --version          Print the version.

Dispositions
  change     Apply the finding's instruction; structural proof is complete.
  candidate  Inspect the named source; resolve the missing timing, ownership,
             or type fact before editing.
  keep       Preserve the current React or lifecycle boundary.
  style      Apply only when the installed Legend State API supports the form.

Agent loop
  1. Scan before editing:  legend-doctor <root> --json --actionable
  2. Apply one group of change findings; inspect candidates against source.
  3. Run the application's formatter, typecheck, and relevant tests.
  4. Scan the same root again and report the finding delta, including zero.

Suppression
  Precede a deliberate React effect with \`// legend-doctor keep-react-effect\`
  to suppress its review-effect finding.

Exit codes
  0  scan completed; the report may contain zero or more findings
  1  the scan failed (unreadable target, analysis error)
  2  invalid usage; nothing was scanned
`;

interface CliOptions {
  actionable: boolean;
  coverage: boolean;
  disposition: Disposition | null;
  help: boolean;
  json: boolean;
  target: string | null;
  version: boolean;
}

class UsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

async function writeInformationalOutput(options: CliOptions): Promise<boolean> {
  if (options.help) {
    process.stdout.write(HELP);
    return true;
  }
  if (options.version) {
    process.stdout.write(`legend-doctor ${await packageVersion()}\n`);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(CLI_ARGUMENT_OFFSET));
  if (await writeInformationalOutput(options)) {
    return;
  }
  const target = path.resolve(options.target ?? process.cwd());
  await assertReadableTarget(target);
  const detailed = options.coverage ? await analyzePathDetailed(target) : null;
  const report = detailed?.report ?? (await analyzePath(target));
  const outputReport = filterReport(report, options.actionable, options.disposition);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(detailed ? { ...detailed, report: outputReport } : outputReport, null, JSON_INDENT)}\n`
      : `${formatTextReport(outputReport, target)}\n`,
  );
}

function defaultOptions(): CliOptions {
  return {
    actionable: false,
    coverage: false,
    disposition: null,
    help: false,
    json: false,
    target: null,
    version: false,
  };
}

function applyDisposition(options: CliOptions, args: readonly string[], index: number): number {
  const argument = args[index]!;
  const inline = argument.startsWith("--disposition=");
  options.disposition = parseDisposition(
    inline ? argument.slice("--disposition=".length) : args[index + 1],
  );
  return inline ? index : index + 1;
}

function applyTargetArgument(options: CliOptions, argument: string): void {
  if (argument.startsWith("-") && argument !== "-") {
    throw new UsageError(unknownFlagMessage(argument));
  }
  if (options.target !== null) {
    throw new UsageError(
      `unexpected extra argument '${argument}'; pass exactly one target, got '${options.target}' first`,
    );
  }
  options.target = argument;
}

function applyArgument(options: CliOptions, args: readonly string[], index: number): number {
  const argument = args[index]!;
  const booleanFlag = BOOLEAN_FLAGS.get(argument);
  if (booleanFlag) {
    options[booleanFlag] = true;
    return index;
  }
  if (argument === "--disposition" || argument.startsWith("--disposition=")) {
    return applyDisposition(options, args, index);
  }
  applyTargetArgument(options, argument);
  return index;
}

function parseArguments(args: readonly string[]): CliOptions {
  const options = defaultOptions();
  for (let index = 0; index < args.length; index += 1) {
    index = applyArgument(options, args, index);
  }
  if (options.coverage && !options.json) {
    throw new UsageError("--coverage has no text layout; add --json");
  }
  return options;
}

function isDisposition(value: string): value is Disposition {
  return DISPOSITION_VALUES.has(value);
}

function parseDisposition(value: string | undefined): Disposition {
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`--disposition needs a value: ${DISPOSITIONS.join(" | ")}`);
  }
  if (!isDisposition(value)) {
    throw new UsageError(
      `--disposition must be one of: ${DISPOSITIONS.toSorted().join(", ")}; got '${value}'`,
    );
  }
  return value;
}

function unknownFlagMessage(argument: string): string {
  const flag = argument.split("=", 1)[0]!;
  const suggestion = closestFlag(flag);
  return suggestion
    ? `unknown flag '${flag}'; did you mean '${suggestion}'?`
    : `unknown flag '${flag}'`;
}

function closestFlag(flag: string): string | null {
  let best: { distance: number; name: string } | null = null;
  for (const known of KNOWN_FLAGS) {
    const distance = editDistance(flag, known);
    if (distance <= MAX_FLAG_SUGGESTION_DISTANCE && (best === null || distance < best.distance)) {
      best = { distance, name: known };
    }
  }
  return best?.name ?? null;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_unused, column) => column);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length]!;
}

async function assertReadableTarget(target: string): Promise<void> {
  try {
    await stat(target);
  } catch {
    throw new Error(`target does not exist: ${target}`);
  }
}

function hasStringVersion(manifest: object): manifest is { version: string } {
  return Object.entries(manifest).some(
    ([key, value]) => key === "version" && String(value) === value,
  );
}

async function packageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (!(manifest instanceof Object) || !hasStringVersion(manifest)) {
    throw new Error("package.json does not declare a string version");
  }
  return manifest.version;
}

function filterReport(
  report: AnalysisReport,
  actionableOnly: boolean,
  disposition: Disposition | null,
): AnalysisReport {
  const findings = actionableOnly ? agentFindings(report.findings) : report.findings;
  return {
    ...report,
    findings: disposition
      ? findings.filter((finding) => finding.disposition === disposition)
      : findings,
    practices: disposition
      ? report.practices.filter((practice) => practice.disposition === disposition)
      : report.practices,
  };
}

try {
  await main();
} catch (error) {
  const usage = error instanceof UsageError;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`legend-doctor: ${message}\n`);
  if (usage) {
    process.stderr.write("Run `legend-doctor --help` for usage.\n");
  }
  process.exitCode = usage ? EXIT_INVALID_USAGE : EXIT_SCAN_FAILED;
}
