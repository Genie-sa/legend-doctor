import type { AssumptionAnswer } from "../../core/types.js";
import { ConfirmationFormatError } from "./confirmation-format-error.js";

/** One answered review question, as written in a confirmations file. */
export interface Confirmation {
  readonly answer: AssumptionAnswer;
  /** The owner fingerprint the answer was given for; a changed owner makes the answer stale. */
  readonly fingerprint?: string;
  readonly id: string;
  readonly note?: string;
}

/** Every answer a scan honours, keyed by the stable assumption id. */
export class ConfirmationSet {
  readonly #answers: ReadonlyMap<string, Confirmation>;
  readonly #source: string | null;

  public constructor(confirmations: readonly Confirmation[], source: string | null = null) {
    this.#answers = new Map(
      confirmations.map((confirmation) => [confirmation.id, confirmation] as const),
    );
    this.#source = source;
  }

  public answerFor(id: string): AssumptionAnswer | null {
    return this.#answers.get(id)?.answer ?? null;
  }

  public confirmationFor(id: string): Confirmation | null {
    return this.#answers.get(id) ?? null;
  }

  public get ids(): readonly string[] {
    return [...this.#answers.keys()];
  }

  public get size(): number {
    return this.#answers.size;
  }

  /** The file the answers came from, for the report. */
  public get source(): string | null {
    return this.#source;
  }
}

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;

const ANSWERS: ReadonlySet<string> = new Set(["no", "yes"]);

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return value?.constructor === String;
}

function isAnswer(value: string): value is AssumptionAnswer {
  return ANSWERS.has(value);
}

function parseJson(text: string): JsonValue {
  try {
    const parsed: JsonValue = JSON.parse(text);
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new ConfirmationFormatError(`confirmations file is not valid JSON: ${detail}`);
  }
}

function optionalString(
  value: JsonValue | undefined,
  field: string,
  id: string,
): string | undefined {
  if (value !== undefined && !isJsonString(value)) {
    throw new ConfirmationFormatError(`confirmations[].${field} must be a string for ${id}`);
  }
  return value;
}

interface RequiredConfirmationFields {
  readonly answer: AssumptionAnswer;
  readonly id: string;
}

function requiredFields(entry: JsonObject, index: number): RequiredConfirmationFields {
  const { answer, id } = entry;
  if (!isJsonString(id) || id.length === 0) {
    throw new ConfirmationFormatError(`confirmations[${index}].id must be a non-empty string`);
  }
  if (!isJsonString(answer) || !isAnswer(answer)) {
    throw new ConfirmationFormatError(
      `confirmations[${index}].answer must be "yes" or "no" for ${id}`,
    );
  }
  return { answer, id };
}

/** A confirmation under construction; optional fields are added only when the file carries them. */
interface ConfirmationDraft {
  answer: AssumptionAnswer;
  fingerprint?: string;
  id: string;
  note?: string;
}

function withOptionalFields(draft: ConfirmationDraft, entry: JsonObject): Confirmation {
  const note = optionalString(entry["note"], "note", draft.id);
  const fingerprint = optionalString(entry["fingerprint"], "fingerprint", draft.id);
  if (note !== undefined) {
    draft.note = note;
  }
  if (fingerprint !== undefined) {
    draft.fingerprint = fingerprint;
  }
  return draft;
}

function parseConfirmation(entry: JsonValue, index: number): Confirmation {
  if (!isJsonObject(entry)) {
    throw new ConfirmationFormatError(`confirmations[${index}] must be an object`);
  }
  return withOptionalFields({ ...requiredFields(entry, index) }, entry);
}

/**
 * Parses `{ "confirmations": [{ "id", "answer": "yes" | "no", "fingerprint"?, "note"? }] }`.
 * Duplicate ids keep the last answer, so an appended correction wins.
 */
export function parseConfirmations(text: string, source: string | null = null): ConfirmationSet {
  const document = parseJson(text);
  if (!isJsonObject(document) || !Array.isArray(document["confirmations"])) {
    throw new ConfirmationFormatError(
      'confirmations file must be an object with a "confirmations" array',
    );
  }
  return new ConfirmationSet(
    document["confirmations"].map((entry, index) => parseConfirmation(entry, index)),
    source,
  );
}
