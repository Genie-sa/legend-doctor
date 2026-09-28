import {
  ABSTENTION_REASONS,
  CAPABILITY_GATE_REASONS,
  EDITABLE_PRACTICE_ACTIONS,
  EFFECT_ACTIONS,
  HOOK_DISPOSITIONS,
  LEGEND_PRACTICE_ACTIONS,
  LEGEND_STATE_SOURCES,
  PRACTICE_DISPOSITIONS,
  REVIEW_KINDS,
  STATE_ACTIONS,
} from "../../src/core/types.js";
import {
  SELECTOR_RESULTS,
  SUBSCRIPTION_INVENTORY_REASONS,
  SUBSCRIPTION_INVENTORY_STATUSES,
  SUBSCRIPTION_READ_KINDS,
} from "../../src/core/subscriptions.js";
import { existsSync, readFileSync } from "node:fs";
import { FAILURE_REASONS } from "../../src/cli/failures.js";
import { HELP } from "../../src/cli/help.js";
import { UNAVAILABLE_SOURCE_REASONS } from "../../src/project/source-components/source-context.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

interface DocumentedSet {
  readonly document: string;
  readonly header: string;
  readonly values: readonly string[];
}

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..", "..");

const ACTIONS = [...STATE_ACTIONS, ...EFFECT_ACTIONS, ...LEGEND_PRACTICE_ACTIONS];

const DISPOSITIONS = [...new Set([...HOOK_DISPOSITIONS, ...PRACTICE_DISPOSITIONS])];

const TABLE_SETS: readonly DocumentedSet[] = [
  { document: "ACTIONS.md", header: "Action", values: ACTIONS },
  { document: "README.md", header: "Disposition", values: DISPOSITIONS },
  { document: "skills/legend-doctor/SKILL.md", header: "Disposition", values: DISPOSITIONS },
  { document: "REPORT.md", header: "`abstentionReason`", values: ABSTENTION_REASONS },
  { document: "REPORT.md", header: "`review.kind`", values: REVIEW_KINDS },
  { document: "REPORT.md", header: "Edited action", values: EDITABLE_PRACTICE_ACTIONS },
  { document: "REPORT.md", header: "`source`", values: LEGEND_STATE_SOURCES },
  { document: "REPORT.md", header: "`disabledRules` reason", values: CAPABILITY_GATE_REASONS },
  { document: "REPORT.md", header: "Inventory `status`", values: SUBSCRIPTION_INVENTORY_STATUSES },
  { document: "REPORT.md", header: "Read `kind`", values: SUBSCRIPTION_READ_KINDS },
  { document: "REPORT.md", header: "Selector `result`", values: SELECTOR_RESULTS },
  { document: "REPORT.md", header: "Inventory reason", values: SUBSCRIPTION_INVENTORY_REASONS },
  { document: "REPORT.md", header: "Unavailable `reason`", values: UNAVAILABLE_SOURCE_REASONS },
];

function readDocument(document: string): string {
  return readFileSync(path.join(REPOSITORY_ROOT, document), "utf8");
}

function tableCells(row: string): string[] {
  return row
    .trim()
    .replaceAll(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => cell.trim());
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`(?<value>[^`\n]+)`/gu)].map((match) => match.groups?.value ?? "");
}

/** Code spans in the first column of every table whose first header cell is `header`. */
function tableKeys(markdown: string, header: string): string[] {
  const keys: string[] = [];
  let inTable = false;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const [first = ""] = tableCells(line);
    if (!inTable && first === header) {
      inTable = true;
    } else if (inTable && !/^:?-+:?$/u.test(first)) {
      keys.push(...codeSpans(first));
    }
  }
  return keys;
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

/** First words of the entries indented directly below the help line ending with `heading`. */
function helpEntries(heading: string): string[] {
  const lines = HELP.split("\n");
  const body = lines.slice(lines.findIndex((line) => line.endsWith(heading)) + 1);
  const indent = indentation(body[0] ?? "");
  const end = body.findIndex((line) => line.trim() === "" || indentation(line) < indent);
  return body
    .slice(0, end === -1 ? undefined : end)
    .filter((line) => indentation(line) === indent)
    .map((line) => line.trim().split(/\s+/u)[0] ?? "");
}

function assertSameValues(documented: readonly string[], emitted: readonly string[]): void {
  const documentedValues = new Set(documented);
  const emittedValues = new Set(emitted);
  assert.deepEqual(
    {
      stale: [...documentedValues].filter((value) => !emittedValues.has(value)),
      undocumented: [...emittedValues].filter((value) => !documentedValues.has(value)),
    },
    { stale: [], undocumented: [] },
  );
}

function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N} -]/gu, "")
    .replaceAll(" ", "-");
}

for (const { document, header, values } of TABLE_SETS) {
  test(`${document} table "${header}" lists exactly the values the report can emit`, () => {
    assertSameValues(tableKeys(readDocument(document), header), values);
  });
}

test("CLI help lists exactly the failure reasons and dispositions the report can emit", () => {
  assertSameValues(helpEntries("where reason is:"), FAILURE_REASONS);
  assertSameValues(helpEntries("Dispositions"), DISPOSITIONS);
});

test("the skill names every failure reason", () => {
  const spans = new Set(codeSpans(readDocument("skills/legend-doctor/SKILL.md")));
  assert.deepEqual(
    FAILURE_REASONS.filter((reason) => !spans.has(reason)),
    [],
  );
});

test("every ACTIONS.md link resolves to a file, and every EXAMPLES.md anchor to a heading", () => {
  const actions = readDocument("ACTIONS.md");
  const anchors = new Set(
    [...readDocument("EXAMPLES.md").matchAll(/^#+ (?<heading>.+)$/gmu)].map((match) =>
      headingSlug(match.groups?.heading ?? ""),
    ),
  );
  const broken = [...actions.matchAll(/\]\((?<file>[^)#]+)(?:#(?<anchor>[^)]+))?\)/gu)].filter(
    ({ groups }) =>
      !existsSync(path.join(REPOSITORY_ROOT, groups?.file ?? "")) ||
      (groups?.file === "EXAMPLES.md" &&
        groups.anchor !== undefined &&
        !anchors.has(groups.anchor)),
  );
  assert.deepEqual(
    broken.map(([link]) => link),
    [],
  );
});
