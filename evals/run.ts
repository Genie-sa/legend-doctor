import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { analyzePath, createAnalysisContext } from "../src/analyze-path.js";
import type { AnalysisReport, HookFinding } from "../src/types.js";
import { goldCases, goldPracticeCases, goldStateGroups, repositories } from "./corpus.js";

interface TargetResult {
  report: AnalysisReport;
  root: string;
}

async function main(): Promise<void> {
  const repositoryRoots = parseRepositoryRoots(process.argv.slice(2));
  if (repositoryRoots.size === 0) {
    throw new Error(
      "Provide checked-out repositories as --repo platform=/path --repo memoria=/path --repo legend-music=/path --repo excalidraw=/path" +
        " --repo expensify=/path --repo formbricks=/path --repo outline=/path --repo genie-courses=/path",
    );
  }

  const targets = new Map<string, TargetResult>(),
    failures: string[] = [];
  let inventoriedHooks = 0;

  for (const repository of repositories) {
    const repositoryRoot = repositoryRoots.get(repository.name);
    if (!repositoryRoot) {
      continue;
    }
    const actualCommit = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (actualCommit !== repository.commit) {
      failures.push(
        `${repository.name}: expected commit ${repository.commit}, received ${actualCommit}`,
      );
      continue;
    }
    const contextRoot = "contextRoot" in repository ? repository.contextRoot : undefined,
      context = contextRoot
        ? await createAnalysisContext(path.join(repositoryRoot, contextRoot))
        : undefined;
    for (const target of repository.targets) {
      const root = path.join(repositoryRoot, target.root),
        report = await analyzePath(root, context);
      targets.set(target.id, { report, root });
      inventoriedHooks += report.hooks.total;
      if (report.hooks.states !== target.states || report.hooks.effects !== target.effects) {
        failures.push(
          `${target.id}: expected ${target.states} useState/${target.effects} useEffect, received ${report.hooks.states}/${report.hooks.effects}`,
        );
      }
    }
  }

  let labeled = 0,
    matched = 0,
    actualActionable = 0,
    correctActionable = 0,
    expectedActionable = 0,
    knownMisses = 0;
  const byAction = new Map<string, { correct: number; expected: number; predicted: number }>();
  for (const gold of goldCases) {
    const target = targets.get(gold.target);
    if (!target) {
      continue;
    }
    labeled += 1;
    const finding = findGoldFinding(target.report.findings, gold);
    if (!finding) {
      failures.push(`${gold.target}/${gold.file}:${gold.line}: hook was not inventoried`);
      continue;
    }
    if (isActionable(finding.action)) {
      actualActionable += 1;
      if (finding.action === gold.action) {
        correctActionable += 1;
      }
    }
    if (isActionable(gold.action)) {
      expectedActionable += 1;
    }
    for (const action of new Set([gold.action, finding.action])) {
      if (!isActionable(action)) {
        continue;
      }
      const score = byAction.get(action) ?? { correct: 0, expected: 0, predicted: 0 };
      if (gold.action === action) {
        score.expected += 1;
      }
      if (finding.action === action) {
        score.predicted += 1;
      }
      if (gold.action === action && finding.action === action) {
        score.correct += 1;
      }
      byAction.set(action, score);
    }
    if (finding.action === gold.action) {
      matched += 1;
    } else {
      if ("enforced" in gold && gold.enforced === false) {
        knownMisses += 1;
      } else {
        failures.push(
          `${gold.target}/${gold.file}:${gold.line}: expected ${gold.action}, received ${finding.action} (${gold.rationale})`,
        );
      }
    }
  }

  let groupLabels = 0,
    groupMatches = 0;
  for (const gold of goldStateGroups) {
    const target = targets.get(gold.target);
    if (!target) {
      continue;
    }
    groupLabels += 1;
    const finding = target.report.findings.find(
        (candidate) =>
          candidate.location.file === path.normalize(gold.file) &&
          candidate.location.line === gold.line &&
          candidate.hook === "useState",
      ),
      actualMembers = finding?.group?.primary ? finding.group.members : null;
    if (sameMembers(actualMembers, gold.members)) {
      groupMatches += 1;
    } else {
      failures.push(
        `${gold.target}/${gold.file}:${gold.line}: expected state group ${formatMembers(gold.members)}, received ${formatMembers(actualMembers)} (${gold.rationale})`,
      );
    }
  }

  let practiceMatches = 0,
    practiceLabels = 0;
  const labeledPractices = new Set(
    goldPracticeCases.map((gold) => practiceKey(gold.target, gold.file, gold.line, gold.action)),
  );
  for (const gold of goldPracticeCases) {
    const target = targets.get(gold.target);
    if (!target) {
      continue;
    }
    practiceLabels += 1;
    const finding = target.report.practices.find(
      (candidate) =>
        candidate.location.file === path.normalize(gold.file) &&
        candidate.location.line === gold.line &&
        candidate.action === gold.action,
    );
    if (finding) {
      practiceMatches += 1;
    } else {
      failures.push(
        `${gold.target}/${gold.file}:${gold.line}: expected ${gold.action} (${gold.rationale})`,
      );
    }
  }
  let practicePredictions = 0;
  for (const [targetId, target] of targets) {
    for (const finding of target.report.practices) {
      practicePredictions += 1;
      if (
        !labeledPractices.has(
          practiceKey(targetId, finding.location.file, finding.location.line, finding.action),
        )
      ) {
        failures.push(
          `${targetId}/${finding.location.file}:${finding.location.line}: unexpected Legend practice ${finding.action}`,
        );
      }
    }
  }

  const precision = actualActionable === 0 ? 1 : correctActionable / actualActionable,
    recall = expectedActionable === 0 ? 1 : correctActionable / expectedActionable,
    actionLines = [...byAction.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([action, score]) => {
        const actionPrecision = score.predicted === 0 ? 1 : score.correct / score.predicted,
          actionRecall = score.expected === 0 ? 1 : score.correct / score.expected;
        return `${action}: precision ${(actionPrecision * 100).toFixed(1)}% (${score.correct}/${score.predicted}), recall ${(actionRecall * 100).toFixed(1)}% (${score.correct}/${score.expected})`;
      });
  process.stdout.write(
    `${[
      `Inventoried ${inventoriedHooks} hooks across ${targets.size} targets.`,
      `Matched ${matched}/${labeled} manually labeled hooks.`,
      `Known labeled misses: ${knownMisses}.`,
      `Matched ${groupMatches}/${groupLabels} grouped agent instructions.`,
      `Matched ${practiceMatches}/${practiceLabels} Legend practice findings.`,
      `Legend practice precision: ${practicePredictions === 0 ? "100.0" : ((practiceMatches / practicePredictions) * 100).toFixed(1)}% (${practiceMatches}/${practicePredictions}).`,
      `Actionable precision on labeled hooks: ${(precision * 100).toFixed(1)}% (${correctActionable}/${actualActionable}).`,
      `Actionable recall on labeled hooks: ${(recall * 100).toFixed(1)}% (${correctActionable}/${expectedActionable}).`,
      ...actionLines,
    ].join("\n")}\n`,
  );
  if (failures.length > 0) {
    process.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

function practiceKey(target: string, file: string, line: number, action: string): string {
  return `${target}\0${path.normalize(file)}\0${line}\0${action}`;
}

function sameMembers(
  actual: readonly string[] | null | undefined,
  expected: readonly string[] | null,
): boolean {
  if (actual == null || expected == null) {
    return actual == null && expected == null;
  }
  return (
    actual.length === expected.length && actual.every((member, index) => member === expected[index])
  );
}

function formatMembers(members: readonly string[] | null | undefined): string {
  return members ? `[${members.join(", ")}]` : "none";
}

function parseRepositoryRoots(args: readonly string[]): Map<string, string> {
  const roots = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--repo") {
      continue;
    }
    const assignment = args[index + 1];
    if (!assignment) {
      throw new Error("--repo requires name=/absolute/path");
    }
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid repository assignment: ${assignment}`);
    }
    roots.set(assignment.slice(0, separator), path.resolve(assignment.slice(separator + 1)));
    index += 1;
  }
  return roots;
}

function findGoldFinding(
  findings: readonly HookFinding[],
  gold: (typeof goldCases)[number],
): HookFinding | null {
  return (
    findings.find(
      (finding) =>
        finding.location.file === path.normalize(gold.file) &&
        finding.location.line === gold.line &&
        finding.hook === gold.hook &&
        finding.name === gold.name,
    ) ?? null
  );
}

function isActionable(action: HookFinding["action"]): boolean {
  return !["keep-effect", "keep-state", "review-effect", "review-state"].includes(action);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
