import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Writes `files` under a fresh temporary root, runs `run`, and always removes the root. */
export async function withProject(
  files: Readonly<Record<string, string>>,
  run: (root: string, sources: ReadonlyMap<string, string>) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-components-"));
  try {
    const sources = new Map<string, string>();
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source, "utf8");
      sources.set(file, source);
    }
    await run(root, sources);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
