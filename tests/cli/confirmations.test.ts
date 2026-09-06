import { CLI_PATH, failurePayload, run } from "./harness.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview /><Nav />";

const FILTER_ID = "panel.tsx::Panel::filter::render-cut-unproven";

async function writeReviewRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-confirm-"));
  await writeFile(
    path.join(root, "panel.tsx"),
    `
      import { useState } from "react";
      export function Panel({ rows }: { rows: string[] }) {
        const [filter, setFilter] = useState("");
        return <main>${CHROME}
          <input value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul>{rows.filter((r) => r.includes(filter)).map((r) => <li key={r}>{r}</li>)}</ul>
          <p>{filter ? "filtered" : "all"}</p>
        </main>;
      }
    `,
    "utf8",
  );
  return root;
}

interface CliReportDocument {
  confirmations?: {
    applied: number;
    rejected: number;
    source: string | null;
    stale: number;
    unmatched: string[];
  };
  findings: {
    action: string;
    assumption?: {
      fingerprint: string;
      id: string;
      ifConfirmed: string;
      question: string;
      status: string;
    };
    disposition: string;
  }[];
  questions?: { id: string; rank: number }[];
}

async function scan(args: readonly string[]): Promise<CliReportDocument> {
  const { stdout } = await run(process.execPath, [CLI_PATH, ...args]);
  // SAFETY: the CLI exited successfully, so stdout is a serialized report.
  return JSON.parse(stdout) as CliReportDocument;
}

test("a review finding carries its open question", async (testContext) => {
  const root = await writeReviewRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const report = await scan([root]);
  const [finding] = report.findings;
  assert.equal(finding?.action, "review-state");
  assert.equal(finding?.assumption?.id, FILTER_ID);
  assert.equal(finding?.assumption?.status, "open");
  assert.equal(report.confirmations, undefined);
  assert.match(String(finding?.assumption?.question), /`filter` is read 3 times/u);
  assert.equal(finding?.assumption?.ifConfirmed, "use-observable");
});

test("--confirm converts a confirmed review finding and reports unmatched ids", async (testContext) => {
  const root = await writeReviewRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const confirmPath = path.join(root, "confirmations.json");
  await writeFile(
    confirmPath,
    JSON.stringify({
      confirmations: [
        { answer: "yes", id: FILTER_ID, note: "each read is one leaf" },
        { answer: "no", id: "gone.tsx::Gone::value::render-cut-unproven" },
      ],
    }),
    "utf8",
  );

  const report = await scan([root, "--confirm", confirmPath]);
  const [finding] = report.findings;
  assert.equal(finding?.action, "use-observable");
  assert.equal(finding?.disposition, "change");
  assert.equal(finding?.assumption?.status, "confirmed");
  assert.deepEqual(report.confirmations, {
    applied: 1,
    rejected: 0,
    source: confirmPath,
    stale: 0,
    unmatched: ["gone.tsx::Gone::value::render-cut-unproven"],
  });

  const inline = await scan([root, `--confirm=${confirmPath}`]);
  assert.equal(inline.findings[0]?.action, "use-observable");
  assert.equal(inline.questions, undefined);
});

test("answers in .legend-doctor/confirmations.json are discovered without a flag, and stale ones are reported", async (testContext) => {
  const root = await writeReviewRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const first = await scan([root]);
  const fingerprint = first.findings[0]?.assumption?.fingerprint;
  assert.match(String(fingerprint), /^[0-9a-f]{12}$/u);
  assert.equal(first.questions?.length, 1);
  assert.equal(first.questions?.[0]?.rank, 1);
  assert.equal(first.questions?.[0]?.id, FILTER_ID);

  await mkdir(path.join(root, ".legend-doctor"));
  const discovered = path.join(root, ".legend-doctor", "confirmations.json");
  await writeFile(
    discovered,
    JSON.stringify({
      confirmations: [{ answer: "yes", fingerprint: "ffffffffffff", id: FILTER_ID }],
    }),
    "utf8",
  );
  const stale = await scan([root]);
  assert.equal(stale.findings[0]?.action, "review-state");
  assert.equal(stale.findings[0]?.assumption?.status, "stale");
  assert.equal(stale.confirmations?.stale, 1);
  assert.equal(stale.confirmations?.source, discovered);
  assert.equal(stale.questions?.[0]?.id, FILTER_ID);

  await writeFile(
    discovered,
    JSON.stringify({ confirmations: [{ answer: "yes", fingerprint, id: FILTER_ID }] }),
    "utf8",
  );
  const applied = await scan([root]);
  assert.equal(applied.findings[0]?.action, "use-observable");
  assert.equal(applied.confirmations?.applied, 1);
  assert.equal(applied.questions, undefined);
});

test("--confirm rejects a missing file or a malformed document as a usage error", async (testContext) => {
  const root = await writeReviewRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const missing = await failurePayload([root, "--confirm", path.join(root, "nope.json")]);
  assert.equal(missing.code, 2);
  assert.match(missing.payload.message, /--confirm file could not be read/u);

  const malformedPath = path.join(root, "bad.json");
  await writeFile(
    malformedPath,
    JSON.stringify({ confirmations: [{ id: FILTER_ID, answer: "maybe" }] }),
  );
  const malformed = await failurePayload([root, "--confirm", malformedPath]);
  assert.equal(malformed.code, 2);
  assert.match(malformed.payload.message, /answer must be "yes" or "no"/u);

  const valueless = await failurePayload([root, "--confirm"]);
  assert.equal(valueless.code, 2);
  assert.match(valueless.payload.message, /--confirm requires a path/u);
});

test("--answer records the fingerprinted answer and reports the scan that honours it", async (testContext) => {
  const root = await writeReviewRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const report = await scan([
    root,
    "--answer",
    `${FILTER_ID}=yes`,
    "--note",
    "each read is one leaf",
  ]);
  assert.equal(report.findings[0]?.action, "use-observable");
  assert.equal(report.confirmations?.applied, 1);
  // SAFETY: the CLI just wrote this file through recordAnswers, so it is the documented confirmations document.
  const stored = JSON.parse(
    await readFile(path.join(root, ".legend-doctor", "confirmations.json"), "utf8"),
  ) as { confirmations: { answer: string; fingerprint: string; id: string; note?: string }[] };
  assert.equal(stored.confirmations.length, 1);
  assert.equal(stored.confirmations[0]?.id, FILTER_ID);
  assert.equal(stored.confirmations[0]?.answer, "yes");
  assert.equal(stored.confirmations[0]?.note, "each read is one leaf");
  assert.match(String(stored.confirmations[0]?.fingerprint), /^[0-9a-f]{12}$/u);

  const flipped = await scan([root, `--answer=${FILTER_ID}=no`]);
  assert.equal(flipped.findings[0]?.action, "review-state");
  assert.equal(flipped.findings[0]?.assumption?.status, "rejected");
});

test("--answer rejects an unknown id and a malformed value as usage errors", async (testContext) => {
  const root = await writeReviewRoot();
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const unknown = await failurePayload([
    root,
    "--answer",
    "panel.tsx::Panel::nope::render-cut-unproven=yes",
  ]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.payload.message, /names no open question/u);
  assert.match(
    unknown.payload.message,
    /Open questions in that file: panel\.tsx::Panel::filter::render-cut-unproven/u,
  );

  const malformed = await failurePayload([root, "--answer", `${FILTER_ID}=maybe`]);
  assert.equal(malformed.code, 2);
  assert.match(
    malformed.payload.message,
    /--answer requires <question id>=yes or <question id>=no/u,
  );
});
