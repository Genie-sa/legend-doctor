export const ANALYSIS_COVERAGE_STAGES = [
  "parser",
  "lowering",
  "semantic",
  "detector",
] as const;

export type AnalysisCoverageStage = (typeof ANALYSIS_COVERAGE_STAGES)[number];

export type AnalysisCoverageStatus = "analyzed" | "skipped" | "unknown" | "unsupported";

export interface AnalysisCoverageReason {
  readonly code: string;
  readonly message: string;
}

export interface AnalysisCoverageOutcome {
  readonly status: AnalysisCoverageStatus;
  readonly reason: AnalysisCoverageReason;
}

export interface AnalysisCoverageStages {
  readonly parser: AnalysisCoverageOutcome;
  readonly lowering: AnalysisCoverageOutcome;
  readonly semantic: AnalysisCoverageOutcome;
  readonly detector: AnalysisCoverageOutcome;
}

export type AnalysisCoverageTarget =
  | {
      readonly kind: "file";
      readonly file: string;
    }
  | {
      readonly kind: "function";
      readonly file: string;
      readonly name: string | null;
      readonly start: number;
      readonly end: number;
    };

export interface AnalysisCoverageEntry {
  readonly target: AnalysisCoverageTarget;
  readonly stages: AnalysisCoverageStages;
}

export interface AnalysisCoverageReport {
  readonly schemaVersion: 1;
  /** An empty list means that no targets were registered, never unknown coverage. */
  readonly entries: readonly AnalysisCoverageEntry[];
}

const COVERAGE_STATUSES: ReadonlySet<AnalysisCoverageStatus> = new Set([
  "analyzed",
  "skipped",
  "unknown",
  "unsupported",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTargets(left: AnalysisCoverageTarget, right: AnalysisCoverageTarget): number {
  const fileOrder = compareText(left.file, right.file);
  if (fileOrder !== 0) return fileOrder;

  if (left.kind !== right.kind) return left.kind === "file" ? -1 : 1;
  if (left.kind === "file" || right.kind === "file") return 0;

  const startOrder = left.start - right.start;
  if (startOrder !== 0) return startOrder;

  const endOrder = left.end - right.end;
  if (endOrder !== 0) return endOrder;

  return compareText(left.name ?? "", right.name ?? "");
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return value;
}

function normalizeTarget(target: AnalysisCoverageTarget): AnalysisCoverageTarget {
  const file = requireNonBlank(target.file, "coverage target file");
  if (target.kind === "file") return { kind: "file", file };
  if (target.kind !== "function") {
    throw new TypeError("coverage target kind must be file or function");
  }

  if (target.name !== null) requireNonBlank(target.name, "function target name");
  if (!Number.isSafeInteger(target.start) || target.start < 0) {
    throw new TypeError("function target start must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(target.end) || target.end <= target.start) {
    throw new TypeError("function target end must be a safe integer after start");
  }

  return {
    kind: "function",
    file,
    name: target.name,
    start: target.start,
    end: target.end,
  };
}

function normalizeOutcome(
  stage: AnalysisCoverageStage,
  outcome: AnalysisCoverageOutcome
): AnalysisCoverageOutcome {
  if (!COVERAGE_STATUSES.has(outcome.status)) {
    throw new TypeError(`coverage stage ${stage} has an invalid status`);
  }

  return {
    status: outcome.status,
    reason: {
      code: requireNonBlank(outcome.reason.code, `coverage stage ${stage} reason code`),
      message: requireNonBlank(outcome.reason.message, `coverage stage ${stage} reason message`),
    },
  };
}

function normalizeStages(stages: AnalysisCoverageStages): AnalysisCoverageStages {
  const suppliedStages = Object.keys(stages);
  if (
    suppliedStages.length !== ANALYSIS_COVERAGE_STAGES.length ||
    suppliedStages.some(stage => !(ANALYSIS_COVERAGE_STAGES as readonly string[]).includes(stage))
  ) {
    throw new TypeError("coverage must explicitly report parser, lowering, semantic, and detector stages");
  }

  return {
    parser: normalizeOutcome("parser", stages.parser),
    lowering: normalizeOutcome("lowering", stages.lowering),
    semantic: normalizeOutcome("semantic", stages.semantic),
    detector: normalizeOutcome("detector", stages.detector),
  };
}

function targetKey(target: AnalysisCoverageTarget): string {
  return target.kind === "file"
    ? `file\0${target.file}`
    : `function\0${target.file}\0${target.start}\0${target.end}`;
}

export class AnalysisCoverageLedger {
  readonly #entries = new Map<string, AnalysisCoverageEntry>();
  readonly #expectedTargets: ReadonlyMap<string, AnalysisCoverageTarget>;

  constructor(expectedTargets: readonly AnalysisCoverageTarget[] = []) {
    const expected = new Map<string, AnalysisCoverageTarget>();
    for (const candidate of expectedTargets) {
      const target = normalizeTarget(candidate);
      const key = targetKey(target);
      if (expected.has(key)) throw new Error(`duplicate expected coverage target: ${key}`);
      expected.set(key, target);
    }
    this.#expectedTargets = expected;
  }

  record(entry: AnalysisCoverageEntry): void {
    const normalized: AnalysisCoverageEntry = {
      target: normalizeTarget(entry.target),
      stages: normalizeStages(entry.stages),
    };
    const key = targetKey(normalized.target);
    if (this.#expectedTargets.size > 0 && !this.#expectedTargets.has(key)) {
      throw new Error(`unexpected coverage target: ${key}`);
    }
    if (this.#entries.has(key)) {
      throw new Error(`coverage target already recorded: ${key}`);
    }
    if (
      normalized.stages.parser.status !== "analyzed" &&
      normalized.stages.detector.status === "analyzed"
    ) {
      throw new Error("detector cannot be analyzed when parser coverage is not analyzed");
    }
    this.#entries.set(key, normalized);
  }

  report(): AnalysisCoverageReport {
    const missing = [...this.#expectedTargets].filter(([key]) => !this.#entries.has(key));
    if (missing.length > 0) {
      throw new Error(`coverage targets were not recorded: ${missing.map(([key]) => key).join(", ")}`);
    }
    return {
      schemaVersion: 1,
      entries: [...this.#entries.values()]
        .sort((left, right) => compareTargets(left.target, right.target))
        .map(entry => ({
          target: { ...entry.target },
          stages: {
            parser: normalizeOutcome("parser", entry.stages.parser),
            lowering: normalizeOutcome("lowering", entry.stages.lowering),
            semantic: normalizeOutcome("semantic", entry.stages.semantic),
            detector: normalizeOutcome("detector", entry.stages.detector),
          },
        })),
    };
  }

  toJSON(): AnalysisCoverageReport {
    return this.report();
  }
}
