#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { analyzePath, analyzePathDetailed } from "./analyze-path.js";
import { agentFindings, formatTextReport } from "./format.js";
import type { AnalysisReport, HookFinding, LegendPracticeFinding } from "./types.js";

type Disposition = HookFinding["disposition"] | LegendPracticeFinding["disposition"];

const DISPOSITIONS: readonly Disposition[] = ["candidate", "change", "keep", "style"];
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

class UsageError extends Error {}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`legend-doctor ${await packageVersion()}\n`);
    return;
  }
  const target = path.resolve(options.target ?? process.cwd());
  await assertReadableTarget(target);
  const detailed = options.coverage ? await analyzePathDetailed(target) : null;
  const report = detailed?.report ?? (await analyzePath(target));
  const outputReport = filterReport(report, options.actionable, options.disposition);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(detailed ? { ...detailed, report: outputReport } : outputReport, null, 2)}\n`
      : `${formatTextReport(outputReport, target)}\n`,
  );
}

function parseArguments(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    actionable: false,
    coverage: false,
    disposition: null,
    help: false,
    json: false,
    target: null,
    version: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const booleanFlag = BOOLEAN_FLAGS.get(argument);
    if (booleanFlag) {
      options[booleanFlag] = true;
    } else if (argument === "--disposition" || argument.startsWith("--disposition=")) {
      const inline = argument.startsWith("--disposition=");
      const value = inline ? argument.slice("--disposition=".length) : args[index + 1];
      if (!inline) {
        index += 1;
      }
      options.disposition = parseDisposition(value);
    } else if (argument.startsWith("-") && argument !== "-") {
      throw new UsageError(unknownFlagMessage(argument));
    } else if (options.target === null) {
      options.target = argument;
    } else {
      throw new UsageError(
        `unexpected extra argument '${argument}'; pass exactly one target, got '${options.target}' first`,
      );
    }
  }
  if (options.coverage && !options.json) {
    throw new UsageError("--coverage has no text layout; add --json");
  }
  return options;
}

function parseDisposition(value: string | undefined): Disposition {
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`--disposition needs a value: ${DISPOSITIONS.join(" | ")}`);
  }
  if (!(DISPOSITIONS as readonly string[]).includes(value)) {
    throw new UsageError(
      `--disposition must be one of: ${[...DISPOSITIONS].sort().join(", ")}; got '${value}'`,
    );
  }
  return value as Disposition;
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
    if (distance <= 3 && (best === null || distance < best.distance)) {
      best = { distance, name: known };
    }
  }
  return best?.name ?? null;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, column) => column);
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

async function packageVersion(): Promise<string> {
  const manifest = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const { version } = JSON.parse(manifest) as { version: string };
  return version;
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

main().catch((error: unknown) => {
  const usage = error instanceof UsageError;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`legend-doctor: ${message}\n`);
  if (usage) {
    process.stderr.write("Run `legend-doctor --help` for usage.\n");
  }
  process.exitCode = usage ? 2 : 1;
});
