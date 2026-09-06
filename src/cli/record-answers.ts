import type { AssumptionAnswer, HookFinding, StateAssumption } from "../core/types.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { Confirmation } from "../analysis/assumptions/confirmations.js";
import { ConfirmationFormatError } from "../analysis/assumptions/confirmation-format-error.js";
import { UsageError } from "./usage-error.js";
import { parseConfirmations } from "../analysis/assumptions/confirmations.js";
import path from "node:path";

/** One `--answer <id>=<yes|no>` argument. */
export interface RecordedAnswer {
  readonly answer: AssumptionAnswer;
  readonly id: string;
}

export interface RecordAnswersRequest {
  readonly answers: readonly RecordedAnswer[];
  readonly findings: readonly HookFinding[];
  readonly note: string | null;
  /** The confirmations file to update; created with its directory when missing. */
  readonly target: string;
}

const MAX_SUGGESTIONS = 5;
const JSON_INDENT = 2;

function assumptionsById(findings: readonly HookFinding[]): Map<string, StateAssumption> {
  const byId = new Map<string, StateAssumption>();
  for (const finding of findings) {
    if (finding.assumption) {
      byId.set(finding.assumption.id, finding.assumption);
    }
  }
  return byId;
}

function suggestions(id: string, known: ReadonlyMap<string, StateAssumption>): string {
  const [file = ""] = id.split("::");
  const similar = [...known.keys()]
    .filter((candidate) => candidate.startsWith(file))
    .slice(0, MAX_SUGGESTIONS);
  return similar.length > 0 ? ` Open questions in that file: ${similar.join(", ")}` : "";
}

async function readConfirmationsText(target: string): Promise<string | null> {
  const exists = await stat(target).then(
    (entry) => entry.isFile(),
    () => false,
  );
  return exists ? readFile(target, "utf8") : null;
}

async function existingConfirmations(target: string): Promise<Confirmation[]> {
  const text = await readConfirmationsText(target);
  if (text === null) {
    return [];
  }
  try {
    const parsed = parseConfirmations(text, target);
    return parsed.ids.map((id) => parsed.confirmationFor(id)!);
  } catch (error) {
    if (error instanceof ConfirmationFormatError) {
      throw new UsageError(`cannot append to ${target}: ${error.message}`);
    }
    throw error;
  }
}

function entryFor(
  { answer, id }: RecordedAnswer,
  known: ReadonlyMap<string, StateAssumption>,
  note: string | null,
): Confirmation {
  const assumption = known.get(id);
  if (!assumption) {
    throw new UsageError(
      `--answer names no open question in this scan: ${id}.${suggestions(id, known)}`,
    );
  }
  const entry: Confirmation = { answer, fingerprint: assumption.fingerprint, id };
  return note === null ? entry : { ...entry, note };
}

/**
 * Appends answers to the confirmations file with the fingerprint each question currently carries,
 * so the agent never copies a digest by hand. An unknown id is a usage error naming nearby questions.
 */
export async function recordAnswers({
  answers,
  findings,
  note,
  target,
}: RecordAnswersRequest): Promise<number> {
  const known = assumptionsById(findings);
  const existing = await existingConfirmations(target);
  const entries = new Map(existing.map((entry) => [entry.id, entry] as const));
  for (const recorded of answers) {
    entries.set(recorded.id, entryFor(recorded, known, note));
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify({ confirmations: [...entries.values()] }, null, JSON_INDENT)}\n`,
    "utf8",
  );
  return answers.length;
}
