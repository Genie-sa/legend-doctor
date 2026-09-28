import { readFile } from "node:fs/promises";

/** A missing or unreadable file reads as `null`, which callers treat as declaring nothing. */
export async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
