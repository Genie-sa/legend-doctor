#!/usr/bin/env node
import type { Action, CliOptions, Disposition } from "./cli/options.js";
import type { AnalysisReport, ReportScope } from "./core/types.js";
import { CliError, EXIT_GATE_FAILED, EXIT_SCAN_FAILED } from "./cli/failures.js";
import type { GateResult, HiddenCounts } from "./report/format.js";
import { GitScopeError, resolveScopedFiles } from "./project/git-scope.js";
import { analyzePath, analyzePathDetailed } from "./project/analyze-path/analyze-path.js";
import { parseArguments, scanScope, scanScopeFlag } from "./cli/options.js";
import { readFile, stat } from "node:fs/promises";
import type { AnalyzerIdentity } from "./cli/analyzer-identity.js";
import type { CliFailure } from "./cli/failures.js";
import { ConfirmationFormatError } from "./analysis/assumptions/confirmation-format-error.js";
import type { ConfirmationSet } from "./analysis/assumptions/confirmations.js";
import type { DetailedAnalysisResult } from "./project/analyze-path/analyze-path.js";
import { HELP } from "./cli/help.js";
import { SCHEMA_VERSION } from "./core/types.js";
import type { ScanScope } from "./project/git-scope.js";
import { UsageError } from "./cli/usage-error.js";
import { agentFindings } from "./report/format.js";
import { analyzerIdentity } from "./cli/analyzer-identity.js";
import { discoverConfig } from "./cli/config.js";
import { isSupportedAnalysisFile } from "./project/analysis-project.js";
import { materialityFor } from "./analysis/constants.js";
import { parseConfirmations } from "./analysis/assumptions/confirmations.js";
import path from "node:path";
import { pathIdentityKey } from "./core/path-identity.js";
import process from "node:process";
import { recordAnswers } from "./cli/record-answers.js";

const CLI_ARGUMENT_OFFSET = 2;

const JSON_INDENT = 2;

const DISCOVERED_CONFIRMATIONS = path.join(".legend-doctor", "confirmations.json");

interface FilteredReport {
  hidden: HiddenCounts;
  report: AnalysisReport;
}

interface CliScope {
  contextFiles: number;
  mode: ScanScope["mode"];
  ref?: string;
}

interface CliReport extends Omit<AnalysisReport, "scope"> {
  analyzer: AnalyzerIdentity;
  coverage?: DetailedAnalysisResult["coverage"];
  diagnostics?: DetailedAnalysisResult["diagnostics"];
  gate?: GateResult;
  hidden: HiddenCounts;
  root: string;
  scope?: CliScope;
  status: "ok";
}

/** Where a scan runs: the resolved target, its scan root, and the optional git scope filter. */
interface ScanTarget {
  readonly fileFilter: ((absolutePath: string) => boolean) | undefined;
  readonly root: string;
  readonly scope: ScanScope | null;
  readonly target: string;
}

interface TargetAnalysis {
  readonly detailed: DetailedAnalysisResult | null;
  readonly filtered: FilteredReport;
}

async function writeInformationalOutput(options: CliOptions): Promise<boolean> {
  if (options.help) {
    process.stdout.write(HELP);
    return true;
  }
  if (options.version) {
    const { version } = await analyzerIdentity();
    process.stdout.write(`legend-doctor ${version}\n`);
    return true;
  }
  return false;
}

async function resolveScanTarget(options: CliOptions): Promise<ScanTarget> {
  const target = path.resolve(options.target ?? process.cwd());
  const root = await resolveScanRoot(target);
  const scope = scanScope(options);
  if (scope && root !== target) {
    throw new UsageError(
      `${scanScopeFlag(scope)} needs a directory target; git selects the files, so pass the scan root instead of '${target}'`,
    );
  }
  const fileFilter = scope ? await scopedFileFilter(root, scope) : undefined;
  return { fileFilter, root, scope, target };
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseArguments(args);
  if (await writeInformationalOutput(options)) {
    return;
  }
  const scanTarget = await resolveScanTarget(options);
  if (options.answers.length > 0) {
    await recordScanAnswers(options, scanTarget);
  }
  const { detailed, filtered } = await analyzeTarget(options, scanTarget);
  const report = buildCliReport(scanTarget.root, filtered, {
    analyzer: await analyzerIdentity(),
    detailed,
    failOn: options.failOn,
    scope: scanTarget.scope,
  });
  writeReport(report);
}

function writeReport(report: CliReport): void {
  writeJson(report);
  if (report.gate && report.gate.matched > 0) {
    process.exitCode = EXIT_GATE_FAILED;
  }
}

async function analyzeTarget(
  options: CliOptions,
  { fileFilter, root, target }: ScanTarget,
): Promise<TargetAnalysis> {
  const confirmations =
    options.confirm === null
      ? await discoverConfirmations(root)
      : await loadConfirmations(options.confirm);
  const config = await discoverConfig(root);
  const materiality = materialityFor(options.materiality ?? config.materiality ?? "broad");
  const analyzeOptions = fileFilter
    ? { confirmations, fileFilter, materiality }
    : { confirmations, materiality };
  const detailed = options.coverage ? await analyzePathDetailed(target, analyzeOptions) : null;
  const filtered = filterReport(detailed?.report ?? (await analyzePath(target, analyzeOptions)), {
    actionableOnly: options.actionable,
    disposition: options.disposition,
    ignoreActions: [...new Set([...config.ignoreActions, ...options.ignoreActions])],
  });
  return { detailed, filtered };
}

/**
 * Records `--answer` entries against the questions a first scan produces, so each carries the
 * fingerprint of the owner it was answered for; the reported scan then honours them.
 */
async function recordScanAnswers(options: CliOptions, scanTarget: ScanTarget): Promise<void> {
  const { filtered } = await analyzeTarget(
    { ...options, actionable: false, disposition: null },
    scanTarget,
  );
  await recordAnswers({
    answers: options.answers,
    findings: filtered.report.findings,
    note: options.note,
    target:
      options.confirm === null
        ? path.join(scanTarget.root, DISCOVERED_CONFIRMATIONS)
        : path.resolve(options.confirm),
  });
}

/** The repository's own answers, honoured whenever the scan root carries them. */
async function discoverConfirmations(root: string): Promise<ConfirmationSet | null> {
  const discovered = path.join(root, DISCOVERED_CONFIRMATIONS);
  const exists = await stat(discovered).then(
    (entry) => entry.isFile(),
    () => false,
  );
  return exists ? loadConfirmations(discovered) : null;
}

async function loadConfirmations(confirmPath: string): Promise<ConfirmationSet> {
  const resolved = path.resolve(confirmPath);
  try {
    return parseConfirmations(await readFile(resolved, "utf8"), resolved);
  } catch (error) {
    if (error instanceof ConfirmationFormatError) {
      throw new UsageError(`--confirm ${confirmPath}: ${error.message}`);
    }
    const detail = error instanceof Error ? error.message : "unreadable";
    throw new UsageError(`--confirm file could not be read: ${confirmPath} (${detail})`);
  }
}

async function scopedFileFilter(
  root: string,
  scope: ScanScope,
): Promise<(absolutePath: string) => boolean> {
  try {
    const files = await resolveScopedFiles(root, scope);
    return (absolutePath) => files.has(pathIdentityKey(absolutePath));
  } catch (error) {
    if (error instanceof GitScopeError) {
      throw new CliError(error.message, {
        exitCode: EXIT_SCAN_FAILED,
        reason: "scope_unavailable",
      });
    }
    throw error;
  }
}

interface CliReportInputs {
  readonly analyzer: AnalyzerIdentity;
  readonly detailed: DetailedAnalysisResult | null;
  readonly failOn: readonly Disposition[];
  readonly scope: ScanScope | null;
}

function cliScope(scope: ScanScope | null, reportScope: ReportScope | undefined): CliScope | null {
  if (!scope || !reportScope) {
    return null;
  }
  const described: CliScope = { contextFiles: reportScope.contextFiles, mode: scope.mode };
  if (scope.mode === "since") {
    described.ref = scope.ref;
  }
  return described;
}

function gateFor(filtered: FilteredReport, failOn: readonly Disposition[]): GateResult | null {
  if (failOn.length === 0) {
    return null;
  }
  const shown = [
    ...filtered.report.findings.map((finding) => finding.disposition),
    ...filtered.report.practices.map((practice) => practice.disposition),
  ];
  return { failOn, matched: shown.filter((disposition) => failOn.includes(disposition)).length };
}

type OptionalSections = Pick<CliReport, "coverage" | "diagnostics" | "gate" | "scope">;

function optionalSections(
  filtered: FilteredReport,
  inputs: CliReportInputs,
  reportScope: ReportScope | undefined,
): OptionalSections {
  const sections: OptionalSections = {};
  const scope = cliScope(inputs.scope, reportScope);
  if (scope) {
    sections.scope = scope;
  }
  const gate = gateFor(filtered, inputs.failOn);
  if (gate) {
    sections.gate = gate;
  }
  return inputs.detailed ? withCoverage(sections, inputs.detailed) : sections;
}

function withCoverage(
  sections: OptionalSections,
  detailed: DetailedAnalysisResult,
): OptionalSections {
  return { ...sections, coverage: detailed.coverage, diagnostics: detailed.diagnostics };
}

function buildCliReport(
  root: string,
  filtered: FilteredReport,
  inputs: CliReportInputs,
): CliReport {
  const { scope: reportScope, ...analysis } = filtered.report;
  return {
    status: "ok",
    root,
    analyzer: inputs.analyzer,
    ...analysis,
    hidden: filtered.hidden,
    ...optionalSections(filtered, inputs, reportScope),
  };
}

function writeJson(payload: CliFailure | CliReport): void {
  process.stdout.write(`${JSON.stringify(payload, null, JSON_INDENT)}\n`);
}

async function resolveScanRoot(target: string): Promise<string> {
  const isDirectory = await stat(target).then(
    (entry) => entry.isDirectory(),
    () => null,
  );
  if (isDirectory === null) {
    throw new CliError(`target does not exist: ${target}`, {
      exitCode: EXIT_SCAN_FAILED,
      reason: "target_not_found",
    });
  }
  if (isDirectory) {
    return target;
  }
  if (!isSupportedAnalysisFile(target)) {
    throw new UsageError(
      `'${path.extname(target) || path.basename(target)}' is not a scannable source file extension; pass a directory or a .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, or .cjs file`,
      "unsupported_target",
    );
  }
  return path.dirname(target);
}

/** What the report keeps: the actionable subset, one disposition, minus the ignored actions. */
interface ReportFilter {
  readonly actionableOnly: boolean;
  readonly disposition: Disposition | null;
  readonly ignoreActions: readonly Action[];
}

function filterReport(report: AnalysisReport, filter: ReportFilter): FilteredReport {
  const shown = (finding: { action: Action; disposition: Disposition }): boolean =>
    (filter.disposition === null || finding.disposition === filter.disposition) &&
    !filter.ignoreActions.includes(finding.action);
  const agentOnly = filter.actionableOnly ? agentFindings(report.findings) : report.findings;
  const findings = agentOnly.filter((finding) => shown(finding));
  const practices = report.practices.filter((practice) => shown(practice));
  return {
    hidden: {
      findings: report.findings.length - findings.length,
      practices: report.practices.length - practices.length,
    },
    report: { ...report, findings, practices },
  };
}

function toFailure(error: Error): CliFailure {
  if (error instanceof CliError) {
    const failure: CliFailure = {
      schemaVersion: SCHEMA_VERSION,
      status: "error",
      reason: error.reason,
      message: error.message,
    };
    if (error.next.length > 0) {
      failure.next = error.next;
    }
    return failure;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "error",
    reason: "scan_failed",
    message: error.message,
  };
}

/** Failures are reported on stdout as JSON like every other result, so callers parse one channel. */
function reportFailure(error: Error): void {
  process.exitCode = error instanceof CliError ? error.exitCode : EXIT_SCAN_FAILED;
  writeJson(toFailure(error));
}

try {
  await main(process.argv.slice(CLI_ARGUMENT_OFFSET));
} catch (error) {
  reportFailure(error instanceof Error ? error : new Error(String(error)));
}
