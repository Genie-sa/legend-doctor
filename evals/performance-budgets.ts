/** Resource limits for one whole-app scan of a pinned public repository. */
export interface ScanBudget {
  /** Wall time the scan took on the CI runner when the budget was set. */
  readonly baselineSeconds: number;
  readonly heapLimitMiB: number;
  readonly timeLimitSeconds: number;
}

/**
 * Node's default old-space limit on a 16 GB host, pinned so every machine enforces the same cap and
 * a scan that only finishes with a raised `--max-old-space-size` fails here as it would for users.
 */
export const SCAN_HEAP_LIMIT_MIB = 4096;

/** Headroom over the CI baseline: wide enough for runner noise, narrow enough to catch a blowup. */
export const SCAN_TIME_MULTIPLIER = 3;

/** Small scans finish in seconds, where process startup and runner noise dominate. */
export const SCAN_TIME_FLOOR_SECONDS = 60;

/**
 * Whole-app scan wall time of each repository root on ubuntu-latest (4 CPUs, 16 GB), from the scan
 * budget step of CI run 36409722431 with the analyzer at 51f2d32; gptme, zenborg and junto from CI
 * run 36444683516 at c478731; fractals from CI run 36894444846 at 1b0e659; social-app, fontsource, food-app-expo,
 * campus-rallye and bbplayer from CI run 36936168646 at 16d263d.
 */
export const SCAN_BASELINE_SECONDS: ReadonlyMap<string, number> = new Map([
  ["legend-music", 2.4],
  ["excalidraw", 4.2],
  ["expensify", 47.6],
  ["formbricks", 15],
  ["outline", 6.1],
  ["open-webui-react-native", 3.1],
  ["hoalu", 3.4],
  ["legend-photos", 1.2],
  ["legend-apps", 9.2],
  ["noutube", 4.5],
  ["nori", 2.2],
  ["gptme", 3.9],
  ["zenborg", 3.7],
  ["junto", 13.6],
  ["fractals", 2],
  ["social-app", 8.2],
  ["fontsource", 2.7],
  ["food-app-expo", 2.4],
  ["campus-rallye", 2.1],
  ["bbplayer", 4.1],
]);

export function scanTimeLimitSeconds(baselineSeconds: number): number {
  return Math.max(SCAN_TIME_FLOOR_SECONDS, Math.ceil(baselineSeconds * SCAN_TIME_MULTIPLIER));
}

export function scanBudget(repository: string): ScanBudget {
  const baselineSeconds = SCAN_BASELINE_SECONDS.get(repository);
  if (baselineSeconds === undefined) {
    throw new Error(`${repository} has no scan budget in evals/performance-budgets.ts`);
  }
  return {
    baselineSeconds,
    heapLimitMiB: SCAN_HEAP_LIMIT_MIB,
    timeLimitSeconds: scanTimeLimitSeconds(baselineSeconds),
  };
}
