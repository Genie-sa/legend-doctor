import type {
  HookAction,
  HookFinding,
  LegendPracticeAction,
  LegendPracticeFinding,
} from "../core/types.js";
import type { MaterialityTier } from "../analysis/constants.js";
import type { RecordedAnswer } from "./record-answers.js";
import type { ScanScope } from "../project/git-scope.js";
import { UsageError } from "./usage-error.js";

export type Disposition = HookFinding["disposition"] | LegendPracticeFinding["disposition"];

export type Action = HookAction | LegendPracticeAction;

const DISPOSITIONS: readonly Disposition[] = ["candidate", "change", "keep", "style"];

const DISPOSITION_VALUES: ReadonlySet<string> = new Set(DISPOSITIONS);

const KNOWN_ACTIONS = {
  "assign-observable-fields": true,
  "batch-observable-writes": true,
  "delete-derived-state": true,
  "delete-effect": true,
  "delete-unused-state": true,
  "derive-computed-observable": true,
  "keep-effect": true,
  "keep-state": true,
  "move-state-down": true,
  "move-to-event": true,
  "move-use-value-down": true,
  "move-use-value-into-child": true,
  "narrow-observable-write": true,
  "narrow-use-value-subscription": true,
  "pass-observable-to-reactive-input": true,
  "pass-observable-to-use-value": true,
  "persist-observable": true,
  "replace-legacy-use-value": true,
  "reuse-observable-reference": true,
  "review-effect": true,
  "review-state": true,
  "snapshot-computed-initializer": true,
  "split-use-value-leaves": true,
  "split-use-value-result": true,
  "review-helper-tracking": true,
  "toggle-observable": true,
  "use-mount": true,
  "use-observable": true,
  "use-observe-effect": true,
  "use-peek-for-snapshot": true,
  "use-ref": true,
  "use-unmount": true,
  "use-value": true,
  "use-value-for-render-read": true,
} satisfies Record<Action, true>;

const ACTION_VALUES: ReadonlySet<string> = new Set(Object.keys(KNOWN_ACTIONS));

const MAX_FLAG_SUGGESTION_DISTANCE = 3;

type BooleanOption = "actionable" | "changed" | "coverage" | "help" | "staged" | "version";

const BOOLEAN_FLAGS = new Map<string, BooleanOption>([
  ["--actionable", "actionable"],
  ["--changed", "changed"],
  ["--coverage", "coverage"],
  ["--help", "help"],
  ["-h", "help"],
  ["--staged", "staged"],
  ["--version", "version"],
  ["-v", "version"],
]);

const MATERIALITY_TIERS: readonly MaterialityTier[] = ["broad", "compact"];

const VALUE_FLAGS = [
  "--answer",
  "--confirm",
  "--note",
  "--disposition",
  "--fail-on",
  "--ignore-action",
  "--materiality",
  "--since",
] as const;

const KNOWN_FLAGS = [
  "--actionable",
  "--answer",
  "--note",
  "--changed",
  "--confirm",
  "--coverage",
  "--disposition",
  "--fail-on",
  "--help",
  "--ignore-action",
  "--materiality",
  "--since",
  "--staged",
  "--version",
];

export interface CliOptions {
  actionable: boolean;
  /** Answers to record before the reported scan, each `<id>=<yes|no>`; repeatable. */
  answers: RecordedAnswer[];
  changed: boolean;
  /** Path of a confirmations file whose answered review questions the scan honours. */
  confirm: string | null;
  coverage: boolean;
  disposition: Disposition | null;
  failOn: readonly Disposition[];
  help: boolean;
  /** Actions removed from the report; counted under `hidden`. */
  ignoreActions: readonly Action[];
  /** The tier the flag selected, or null to fall back to the config file and then `broad`. */
  materiality: MaterialityTier | null;
  /** Free-text justification stored with every answer recorded in this run. */
  note: string | null;
  since: string | null;
  staged: boolean;
  target: string | null;
  version: boolean;
}

function defaultOptions(): CliOptions {
  return {
    actionable: false,
    answers: [],
    changed: false,
    confirm: null,
    coverage: false,
    disposition: null,
    failOn: [],
    help: false,
    ignoreActions: [],
    materiality: null,
    note: null,
    since: null,
    staged: false,
    target: null,
    version: false,
  };
}

/** The git scope the flags select, or null for a full scan of the target. */
export function scanScope(options: CliOptions): ScanScope | null {
  if (options.since !== null) {
    return { mode: "since", ref: options.since };
  }
  if (options.staged) {
    return { mode: "staged" };
  }
  return options.changed ? { mode: "changed" } : null;
}

export function scanScopeFlag(scope: ScanScope): string {
  return scope.mode === "since" ? `--since ${scope.ref}` : `--${scope.mode}`;
}

type ValueFlagHandler = (options: CliOptions, value: string | undefined) => void;

const VALUE_FLAG_HANDLERS = {
  "--answer": (options, value): void => {
    options.answers.push(parseAnswer(value));
  },
  "--confirm": (options, value): void => {
    options.confirm = parseConfirmPath(value);
  },
  "--disposition": (options, value): void => {
    options.disposition = parseDisposition(value);
  },
  "--fail-on": (options, value): void => {
    options.failOn = parseFailOn(value);
  },
  "--ignore-action": (options, value): void => {
    options.ignoreActions = [...options.ignoreActions, ...parseIgnoreActions(value)];
  },
  "--materiality": (options, value): void => {
    options.materiality = parseMateriality(value);
  },
  "--note": (options, value): void => {
    options.note = parseNote(value);
  },
  "--since": (options, value): void => {
    options.since = parseSince(value);
  },
} satisfies Record<(typeof VALUE_FLAGS)[number], ValueFlagHandler>;

function valueFlagAt(args: readonly string[], index: number): (typeof VALUE_FLAGS)[number] | null {
  const argument = args[index]!;
  return VALUE_FLAGS.find((flag) => argument === flag || argument.startsWith(`${flag}=`)) ?? null;
}

interface ArgumentCursor {
  readonly args: readonly string[];
  readonly index: number;
}

function applyValueFlag(
  options: CliOptions,
  { args, index }: ArgumentCursor,
  flag: (typeof VALUE_FLAGS)[number],
): number {
  const argument = args[index]!;
  const inline = argument.startsWith(`${flag}=`);
  const value = inline ? argument.slice(flag.length + 1) : args[index + 1];
  VALUE_FLAG_HANDLERS[flag](options, value);
  return inline ? index : index + 1;
}

function parseAnswer(value: string | undefined): RecordedAnswer {
  const separator = value?.lastIndexOf("=") ?? -1;
  const id = value?.slice(0, separator) ?? "";
  const answer = value?.slice(separator + 1) ?? "";
  if (value === undefined || separator <= 0 || id.length === 0 || !isAnswer(answer)) {
    throw new UsageError("--answer requires <question id>=yes or <question id>=no");
  }
  return { answer, id };
}

function isAnswer(value: string): value is RecordedAnswer["answer"] {
  return value === "yes" || value === "no";
}

function parseNote(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new UsageError("--note requires the text to store with the recorded answers");
  }
  return value;
}

function parseConfirmPath(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new UsageError("--confirm requires a path to a confirmations JSON file");
  }
  return value;
}

function applyTargetArgument(options: CliOptions, argument: string): void {
  if (argument === "-") {
    throw new UsageError("stdin is not supported; pass a file or directory path as the target");
  }
  if (argument.startsWith("-")) {
    throw new UsageError(unknownFlagMessage(argument));
  }
  if (options.target !== null) {
    throw new UsageError(
      `unexpected extra argument '${argument}'; pass exactly one target, got '${options.target}' first`,
    );
  }
  options.target = argument;
}

function applyArgument(options: CliOptions, args: readonly string[], index: number): number {
  const argument = args[index]!;
  const booleanFlag = BOOLEAN_FLAGS.get(argument);
  if (booleanFlag) {
    options[booleanFlag] = true;
    return index;
  }
  const valueFlag = valueFlagAt(args, index);
  if (valueFlag) {
    return applyValueFlag(options, { args, index }, valueFlag);
  }
  applyTargetArgument(options, argument);
  return index;
}

export function parseArguments(args: readonly string[]): CliOptions {
  const options = defaultOptions();
  for (let index = 0; index < args.length; index += 1) {
    index = applyArgument(options, args, index);
  }
  const scopeFlags = [
    options.changed ? "--changed" : null,
    options.since === null ? null : "--since",
    options.staged ? "--staged" : null,
  ].filter((flag) => flag !== null);
  if (scopeFlags.length > 1) {
    throw new UsageError(
      `pass one scope flag (--changed, --since <ref>, or --staged); got ${scopeFlags.join(" and ")}`,
    );
  }
  return options;
}

function parseSince(value: string | undefined): string {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new UsageError("--since needs a git ref, for example --since origin/main");
  }
  return value;
}

function isDisposition(value: string): value is Disposition {
  return DISPOSITION_VALUES.has(value);
}

function parseDisposition(value: string | undefined): Disposition {
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`--disposition needs a value: ${DISPOSITIONS.join(" | ")}`);
  }
  if (!isDisposition(value)) {
    throw new UsageError(
      `--disposition must be one of: ${DISPOSITIONS.toSorted().join(", ")}; got '${value}'`,
    );
  }
  return value;
}

function parseMateriality(value: string | undefined): MaterialityTier {
  const tier = MATERIALITY_TIERS.find((candidate) => candidate === value);
  if (!tier) {
    throw new UsageError(
      `--materiality must be one of: ${MATERIALITY_TIERS.join(", ")}; got '${value ?? ""}'`,
    );
  }
  return tier;
}

function parseFailOn(value: string | undefined): Disposition[] {
  if (value === undefined || value.startsWith("-") || value === "") {
    throw new UsageError(
      `--fail-on needs one or more comma-separated values: ${DISPOSITIONS.join(" | ")}`,
    );
  }
  const values = value.split(",").map((part) => part.trim());
  const invalid = values.find((part) => !isDisposition(part));
  if (invalid !== undefined) {
    throw new UsageError(
      `--fail-on values must be among: ${DISPOSITIONS.toSorted().join(", ")}; got '${invalid}'`,
    );
  }
  return [...new Set(values.filter((part): part is Disposition => isDisposition(part)))];
}

export function isAction(value: string): value is Action {
  return ACTION_VALUES.has(value);
}

export function isMaterialityTier(value: string): value is MaterialityTier {
  return MATERIALITY_TIERS.some((tier) => tier === value);
}

function parseIgnoreActions(value: string | undefined): Action[] {
  if (value === undefined || value.startsWith("-") || value === "") {
    throw new UsageError("--ignore-action needs one or more comma-separated action names");
  }
  const values = value.split(",").map((part) => part.trim());
  const invalid = values.find((part) => !isAction(part));
  if (invalid !== undefined) {
    throw new UsageError(
      `--ignore-action values must be action names listed in ACTIONS.md; got '${invalid}'`,
    );
  }
  return [...new Set(values.filter((part) => isAction(part)))];
}

function unknownFlagMessage(argument: string): string {
  const flag = argument.split("=", 1)[0]!;
  const suggestion = closestFlag(flag);
  return suggestion
    ? `unknown flag '${flag}'; did you mean '${suggestion}'?`
    : `unknown flag '${flag}'`;
}

function closestFlag(flag: string): string | null {
  let best: { distance: number; name: string } | null = null;
  for (const known of KNOWN_FLAGS) {
    const distance = editDistance(flag, known);
    if (distance <= MAX_FLAG_SUGGESTION_DISTANCE && (best === null || distance < best.distance)) {
      best = { distance, name: known };
    }
  }
  return best?.name ?? null;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_unused, column) => column);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length]!;
}
