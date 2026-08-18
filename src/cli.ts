#!/usr/bin/env node

import process from "node:process";

import { analyzePath, analyzePathDetailed } from "./analyze-path.js";
import { agentFindings, formatTextReport } from "./format.js";
import type { AnalysisReport, HookFinding, LegendPracticeFinding } from "./types.js";

type Disposition = HookFinding["disposition"] | LegendPracticeFinding["disposition"];

const DISPOSITIONS = new Set(["candidate", "change", "keep", "style"]);

async function main(): Promise<void> {
  const { disposition, rest } = extractDisposition(process.argv.slice(2));
  const json = rest.includes("--json");
  const coverage = rest.includes("--coverage");
  const actionableOnly = rest.includes("--actionable");
  const positional = rest.filter(argument => !argument.startsWith("--"));
  const target = positional[0] ?? process.cwd();
  if (coverage && !json) throw new Error("--coverage requires --json");
  const detailed = coverage ? await analyzePathDetailed(target) : null;
  const report = detailed?.report ?? await analyzePath(target);
  const outputReport = filterReport(report, actionableOnly, disposition);
  process.stdout.write(
    json
      ? `${JSON.stringify(detailed ? { ...detailed, report: outputReport } : outputReport, null, 2)}\n`
      : `${formatTextReport(outputReport)}\n`
  );
}

function filterReport(
  report: AnalysisReport,
  actionableOnly: boolean,
  disposition: Disposition | null
): AnalysisReport {
  const findings = actionableOnly ? agentFindings(report.findings) : report.findings;
  return {
    ...report,
    findings: disposition
      ? findings.filter(finding => finding.disposition === disposition)
      : findings,
    practices: disposition
      ? report.practices.filter(practice => practice.disposition === disposition)
      : report.practices,
  };
}

function extractDisposition(
  args: readonly string[]
): { disposition: Disposition | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--disposition") {
      value = args[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--disposition=")) {
      value = argument.slice("--disposition=".length);
    } else {
      rest.push(argument);
    }
  }
  if (value === null) return { disposition: null, rest };
  if (!DISPOSITIONS.has(value)) {
    throw new Error(`--disposition must be one of: ${[...DISPOSITIONS].sort().join(", ")}`);
  }
  return { disposition: value as Disposition, rest };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`legend-doctor: ${message}\n`);
  process.exitCode = 1;
});
