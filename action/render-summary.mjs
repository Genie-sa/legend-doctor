import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    await emit(renderError(head), [], scanFailedGate(head, blocking));
    return;
  }
  const base = env.BASE_REPORT ? await readReport(env.BASE_REPORT) : null;
  const shown = compareWithBase(head, base, await readLines(env.CHANGED_FILES));
  const comments = await buildReviewComments(shown.introduced);
  await emit(
    renderSummary(head, shown, blocking),
    comments,
    evaluateGate(shown.introduced, blocking, head.skippedFiles ?? []),
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
  const headKeys = new Set(headFindings.map((finding) => finding.id));
  const baseKeys = new Set(
    findingsOf(base)
      .filter((finding) => inScope(finding))
      .map((finding) => finding.id),
  );
  return {
    introduced: headFindings.filter((finding) => !baseKeys.has(finding.id)),
    fixed: findingsOf(base).filter((finding) => inScope(finding) && !headKeys.has(finding.id)),
    compared: true,
  };
}

/** An advisory check reports a failed scan without failing the job; a blocking one fails closed. */
function scanFailedGate(report, blocking) {
  return {
    failed: blocking.length > 0,
    reason: report.message,
    state: "error",
    description: `Scan failed: ${report.reason}`,
  };
}

function evaluateGate(findings, blocking, skippedFiles) {
  const blockers = findings.filter((finding) => blocking.includes(finding.disposition));
  const description =
    describeCounts(countByDisposition(findings)) || "No render or effect cost to cut";
  if (blockers.length > 0) {
    return {
      failed: true,
      state: "failure",
      description,
      reason: `${blockers.length} finding(s) with disposition ${blocking.join(", ")} remain in the scanned scope.`,
    };
  }
  if (blocking.length > 0 && skippedFiles.length > 0) {
    return {
      failed: true,
      state: "error",
      description: `${skippedFiles.length} file(s) could not be scanned`,
      reason: `A skipped file can hide a blocking finding: ${skippedFiles.map((skipped) => skipped.file).join(", ")}.`,
    };
  }
  return { failed: false, state: "success", description };
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
  appendSkippedFiles(lines, report.skippedFiles ?? []);
  appendFooter(lines, { blocking, report, shown });
  return lines.join("\n");
}

function appendSkippedFiles(lines, skippedFiles) {
  if (skippedFiles.length === 0) {
    return;
  }
  lines.push(
    "",
    `**${skippedFiles.length} file(s) could not be scanned** and report no findings:`,
    "",
    ...skippedFiles.map(
      (skipped) => `- ${codeSpan(skipped.file)} (${skipped.phase}): ${escapeCell(skipped.message)}`,
    ),
  );
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
  const label = codeSpan(`${file}:${finding.location.line}`);
  if (!env.SERVER_URL || !env.REPOSITORY || !env.HEAD_SHA) {
    return label;
  }
  const href = `${env.SERVER_URL}/${env.REPOSITORY}/blob/${env.HEAD_SHA}/${file}`;
  return `[${label}](${href}#L${finding.location.line})`;
}

/** Scanned paths come from the pull request, so they must not close the code span or the line. */
function codeSpan(text) {
  return `\`${escapeCell(text).replaceAll("`", "'")}\``;
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
  // Ids carry pull-request paths; encoding keeps them from closing the HTML comment.
  const marker = `${REVIEW_MARKER}${encodeURIComponent(finding.id)} -->`;
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

/**
 * Values can carry pull-request-controlled paths, so each is written in GitHub's delimited form with
 * a delimiter derived from the value itself, which no value can contain: a newline inside one can
 * never start a second output and reopen the gate.
 */
async function setOutput(name, value) {
  if (!env.GITHUB_OUTPUT) {
    return;
  }
  const text = String(value);
  const delimiter = `EOF_${createHash("sha256").update(text).digest("hex")}`;
  await appendFile(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}
