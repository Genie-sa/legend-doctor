import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const { env } = process;

const STICKY_MARKER = "<!-- legend-doctor-sticky -->";
const REVIEW_MARKER = "<!-- legend-doctor:";
const BLOCKING_ORDER = ["change", "candidate", "style"];
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,(?<count>\d+))? @@/u;
const NEW_FILE_HEADER = "+++ b/";
const SECTIONS = [
  { disposition: "change", title: "Proven edits", hint: "Apply as written.", collapsed: false },
  {
    disposition: "candidate",
    title: "Needs one more fact",
    hint: "Read the named source, then edit only when the fact is proven.",
    collapsed: true,
  },
  {
    disposition: "style",
    title: "Cleaner form",
    hint: "Apply only when the installed Legend State API supports it.",
    collapsed: true,
  },
];

await main();

async function main() {
  const head = await readReport(env.HEAD_REPORT);
  const blocking = blockingDispositions(env.BLOCKING ?? "none");
  if (head.status !== "ok") {
    await emit(renderError(head), [], scanFailedGate(head));
    return;
  }
  const base = env.BASE_REPORT ? await readReport(env.BASE_REPORT) : null;
  const shown = compareWithBase(head, base, await readLines(env.CHANGED_FILES));
  const comments = await buildReviewComments(shown.introduced);
  await emit(
    renderSummary(head, shown, blocking),
    comments,
    evaluateGate(shown.introduced, blocking),
  );
  await reportCounts(shown);
}

async function reportCounts({ introduced, fixed }) {
  const counts = countByDisposition(introduced);
  await setOutput("total-findings", introduced.length);
  await setOutput("fixed-findings", fixed.length);
  await setOutput("change-count", counts.change);
  await setOutput("candidate-count", counts.candidate);
  await setOutput("affected-files", new Set(introduced.map((finding) => repoPath(finding))).size);
}

async function emit(body, reviewComments, gate) {
  await writeFile(
    path.join(env.OUT_DIR, "legend-doctor-comment.md"),
    `${STICKY_MARKER}\n${body}\n`,
  );
  await writeFile(
    path.join(env.OUT_DIR, "legend-doctor-review.json"),
    JSON.stringify({ event: "COMMENT", comments: reviewComments }),
  );
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `${body}\n`);
  }
  await setOutput("review-comment-count", reviewComments.length);
  await setOutput("gate-failed", gate.failed);
  await setOutput("gate-reason", gate.reason ?? "");
  await setOutput("status-state", gate.state);
  await setOutput("status-description", gate.description);
}

async function readReport(reportPath) {
  try {
    return JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    return {
      status: "error",
      reason: "unreadable-report",
      message: `Could not read the report at ${reportPath}: ${error.message}`,
    };
  }
}

async function readLines(listPath) {
  if (!listPath) {
    return null;
  }
  const text = await readOptional(listPath, "");
  return text.split("\n").filter((line) => line.length > 0);
}

async function readOptional(filePath, fallback) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function blockingDispositions(value) {
  const index = BLOCKING_ORDER.indexOf(value.trim());
  return index === -1 ? [] : BLOCKING_ORDER.slice(0, index + 1);
}

function findingsOf(report) {
  return [...report.findings, ...report.practices];
}

/** Findings the pull request adds, and the ones it removes, against the base branch scan. */
function compareWithBase(head, base, changedFiles) {
  const headFindings = findingsOf(head);
  if (base === null || base.status !== "ok") {
    return { introduced: headFindings, fixed: [], compared: false };
  }
  const inScope = (finding) => changedFiles === null || changedFiles.includes(repoPath(finding));
  const headKeys = new Set(headFindings.map((finding) => identity(finding)));
  const baseKeys = new Set(
    findingsOf(base)
      .filter((finding) => inScope(finding))
      .map((finding) => identity(finding)),
  );
  return {
    introduced: headFindings.filter((finding) => !baseKeys.has(identity(finding))),
    fixed: findingsOf(base).filter(
      (finding) => inScope(finding) && !headKeys.has(identity(finding)),
    ),
    compared: true,
  };
}

/** Stable across line shifts, so a finding that only moved is not reported as introduced. */
function identity(finding) {
  const subject = finding.name ?? finding.practice ?? finding.message;
  return [finding.location.file, finding.action, finding.hook ?? "", subject].join("::");
}

function scanFailedGate(report) {
  return {
    failed: true,
    reason: report.message,
    state: "error",
    description: `Scan failed: ${report.reason}`,
  };
}

function evaluateGate(findings, blocking) {
  const blockers = findings.filter((finding) => blocking.includes(finding.disposition));
  const description =
    describeCounts(countByDisposition(findings)) || "No render or effect cost to cut";
  if (blockers.length === 0) {
    return { failed: false, state: "success", description };
  }
  return {
    failed: true,
    state: "failure",
    description,
    reason: `${blockers.length} finding(s) with disposition ${blocking.join(", ")} remain in the scanned scope.`,
  };
}

function countByDisposition(findings) {
  const counts = { change: 0, candidate: 0, style: 0 };
  for (const finding of findings) {
    counts[finding.disposition] = (counts[finding.disposition] ?? 0) + 1;
  }
  return counts;
}

function describeCounts(counts) {
  const parts = [];
  if (counts.change) {
    parts.push(`${counts.change} proven edit(s)`);
  }
  if (counts.candidate) {
    parts.push(`${counts.candidate} candidate(s)`);
  }
  if (counts.style) {
    parts.push(`${counts.style} style`);
  }
  return parts.join(", ");
}

function renderError(report) {
  const next = report.next ? `\n\nNext: \`${report.next}\`` : "";
  return `## Legend Doctor\n\nThe scan failed with reason \`${report.reason}\`.\n\n${report.message}${next}`;
}

function renderSummary(report, shown, blocking) {
  const headline = describeHeadline(countByDisposition(shown.introduced), shown);
  const lines = ["## Legend Doctor", "", `${describeScope(report, shown)} ${headline}`.trim()];
  if (shown.introduced.length === 0) {
    lines.push("", "No render or effect cost to cut in this change.");
  }
  for (const section of SECTIONS) {
    appendSection(lines, section, findingsFor(shown.introduced, section));
  }
  appendFooter(lines, { blocking, report, shown });
  return lines.join("\n");
}

function findingsFor(findings, section) {
  return findings.filter((finding) => finding.disposition === section.disposition);
}

function appendFooter(lines, { blocking, report, shown }) {
  if (shown.fixed.length > 0) {
    lines.push(
      "",
      `This pull request removes ${shown.fixed.length} finding(s) present on the base branch.`,
    );
  }
  if (blocking.length > 0) {
    lines.push("", `The check fails while any \`${blocking.join("`, `")}\` finding remains.`);
  }
  lines.push(
    "",
    `<sub>legend-doctor ${report.analyzer.version} · build \`${report.analyzer.build}\` · schema ${report.schemaVersion}</sub>`,
  );
}

function describeScope(report, shown) {
  if (shown.compared) {
    return `Compared ${report.files} changed file(s) against the base branch.`;
  }
  if (report.scope) {
    return `Scanned ${report.files} changed file(s) of ${report.scope.contextFiles} loaded for proofs.`;
  }
  return `Scanned ${report.files} file(s).`;
}

function describeHeadline(counts, shown) {
  const summary = describeCounts(counts);
  if (!summary) {
    return "";
  }
  return shown.compared ? `This change introduces **${summary}**.` : `Found **${summary}**.`;
}

function appendSection(lines, section, findings) {
  if (findings.length === 0) {
    return;
  }
  const table = [
    "| Location | Action | Edit |",
    "| --- | --- | --- |",
    ...findings.map(
      (finding) =>
        `| ${renderLocation(finding)} | \`${finding.action}\` | ${escapeCell(finding.message)} |`,
    ),
  ];
  lines.push("");
  if (section.collapsed) {
    const summary = `<details><summary><b>${section.title}</b> (${findings.length}). ${section.hint}</summary>`;
    lines.push(summary, "", ...table, "", "</details>");
  } else {
    lines.push(`### ${section.title}`, "", section.hint, "", ...table);
  }
}

function renderLocation(finding) {
  const file = repoPath(finding);
  const label = `${file}:${finding.location.line}`;
  if (!env.SERVER_URL || !env.REPOSITORY || !env.HEAD_SHA) {
    return `\`${label}\``;
  }
  const href = `${env.SERVER_URL}/${env.REPOSITORY}/blob/${env.HEAD_SHA}/${file}`;
  return `[\`${label}\`](${href}#L${finding.location.line})`;
}

/** The finding's path as git reports it, so it matches the changed-file list and the diff. */
function repoPath(finding) {
  const base = (env.DIRECTORY ?? ".").replace(/^\.\/?/u, "").replace(/\/$/u, "");
  return base ? `${base}/${finding.location.file}` : finding.location.file;
}

function escapeCell(text) {
  return text.replaceAll("|", String.raw`\|`).replaceAll(/\r?\n/gu, " ");
}

async function buildReviewComments(findings) {
  if (env.IS_PR !== "true" || !env.PATCH) {
    return [];
  }
  const changedLines = parseChangedLines(await readOptional(env.PATCH, ""));
  const posted = await readPostedMarkers();
  return findings
    .filter((finding) => changedLines.get(repoPath(finding))?.has(finding.location.line))
    .map((finding) => reviewComment(finding))
    .filter((comment) => !posted.has(markerOf(comment)));
}

async function readPostedMarkers() {
  const bodies = env.EXISTING_COMMENTS
    ? JSON.parse(await readOptional(env.EXISTING_COMMENTS, "[]"))
    : [];
  return new Set(bodies.map((body) => reviewMarkerOf(body)).filter((marker) => marker !== null));
}

function reviewComment(finding) {
  const marker = `${REVIEW_MARKER}${identity(finding)} -->`;
  const heading = `**Legend Doctor** \`${finding.action}\` (${finding.disposition})`;
  return {
    path: repoPath(finding),
    line: finding.location.line,
    side: "RIGHT",
    body: `${marker}\n${heading}\n\n${finding.message}`,
  };
}

function markerOf(comment) {
  return reviewMarkerOf(comment.body);
}

function reviewMarkerOf(body) {
  const match = /<!-- legend-doctor:[^\n]*? -->/u.exec(body);
  return match ? match[0] : null;
}

/** Lines the diff adds or changes, per file, so comments land only where GitHub accepts them. */
function parseChangedLines(patch) {
  const files = new Map();
  let current = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith(NEW_FILE_HEADER)) {
      current = new Set();
      files.set(line.slice(NEW_FILE_HEADER.length), current);
    } else {
      addHunkLines(current, line);
    }
  }
  return files;
}

function addHunkLines(target, line) {
  const hunk = HUNK_HEADER.exec(line);
  if (!hunk?.groups || target === null) {
    return;
  }
  const start = Number(hunk.groups.start);
  const count = hunk.groups.count === undefined ? 1 : Number(hunk.groups.count);
  for (let offset = 0; offset < count; offset += 1) {
    target.add(start + offset);
  }
}

async function setOutput(name, value) {
  if (!env.GITHUB_OUTPUT) {
    return;
  }
  await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
