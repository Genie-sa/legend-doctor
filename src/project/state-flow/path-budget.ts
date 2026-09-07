import type { PathResult } from "./model.js";

const MAX_PATHS = 128;

/** Truncated paths cannot establish either a positive or negative flow proof. */
export function boundPaths(result: PathResult): PathResult {
  return result.paths.length > MAX_PATHS
    ? { paths: result.paths.slice(0, MAX_PATHS), unknown: true }
    : result;
}
