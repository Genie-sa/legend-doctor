import { analyzePath } from "../src/project/analyze-path/analyze-path.js";
import { createAnalysisContext } from "../src/project/analyze-path/analysis-context.js";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

/** One fresh-context sample; repeat in separate processes to compare cold scans. */
async function benchmark(): Promise<void> {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const start = performance.now();
  const context = await createAnalysisContext(root);
  const indexed = performance.now();
  const report = await analyzePath(root, { sharedContext: context });
  const finished = performance.now();
  process.stdout.write(
    `${JSON.stringify({
      root,
      files: report.files,
      hooks: report.hooks.total,
      contextMs: indexed - start,
      analysisMs: finished - indexed,
      totalMs: finished - start,
      maxRssMiB: process.resourceUsage().maxRSS / 1024,
    })}\n`,
  );
}

await benchmark();
