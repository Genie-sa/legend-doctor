#!/usr/bin/env node

import process from "node:process";

import { analyzePath } from "./analyze-path.js";
import { agentFindings, formatTextReport } from "./format.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const actionableOnly = args.includes("--actionable");
  const positional = args.filter(argument => !argument.startsWith("--"));
  const target = positional[0] ?? process.cwd();
  const report = await analyzePath(target);
  const outputReport = actionableOnly ? { ...report, findings: agentFindings(report.findings) } : report;
  process.stdout.write(
    json
      ? `${JSON.stringify(outputReport, null, 2)}\n`
      : `${formatTextReport(report, actionableOnly)}\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`legend-doctor: ${message}\n`);
  process.exitCode = 1;
});
