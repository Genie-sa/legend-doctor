export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = boolean | number | string | null | readonly JsonValue[] | JsonObject;

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return value?.constructor === String;
}

/** The top-level fields of a JSON object document, or null when the text is not one. */
export function parseJsonFields(text: string): ReadonlyMap<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed instanceof Object ? new Map(Object.entries(parsed)) : null;
  } catch {
    return null;
  }
}
