import type { StateCandidate, StateUsage } from "./model.js";
import type { RuntimeFunctionLike } from "../core/ast.js";
import type ts from "typescript";

export const BROAD_OWNER_JSX_ELEMENTS = 12;

export const COMPACT_OWNER_JSX_ELEMENTS = 8;

/** Which owners count as broad enough for a render cut to be worth an edit. */
export type MaterialityTier = "broad" | "compact";

export interface MaterialityPolicy {
  readonly broadOwnerJsx: number;
  readonly tier: MaterialityTier;
}

export const DEFAULT_MATERIALITY: MaterialityPolicy = {
  broadOwnerJsx: BROAD_OWNER_JSX_ELEMENTS,
  tier: "broad",
};

export const COMPACT_MATERIALITY: MaterialityPolicy = {
  broadOwnerJsx: COMPACT_OWNER_JSX_ELEMENTS,
  tier: "compact",
};

export function materialityFor(tier: MaterialityTier): MaterialityPolicy {
  return tier === "compact" ? COMPACT_MATERIALITY : DEFAULT_MATERIALITY;
}

export const DEFAULT_PRESENTATION_LEAF_COUNT = 2;

export const HOOK_CALL_ARITY = 2;

export const KEY_VALUE_TUPLE_LENGTH = 2;

export const LARGE_OWNER_LINE_SPAN = 100;

export const MAX_FEEDBACK_LEAF_ELEMENTS = 4;

export const MAX_LEAF_ELEMENTS = 9;

export const MAX_LEAF_SUBTREE_RATIO = 0.4;

export const MAX_PROJECTION_HOPS = 3;

export const MAX_REPEATED_PROJECTION_RATIO = 0.25;

export const MAX_TERMINAL_LEAVES = 6;

export const MIN_COLLECTION_RENDER_WORK = 2;

export const MIN_DIRECT_RENDER_READS = 2;

export const MIN_LEAF_SUBTREE_ELEMENTS = 2;

export const MIN_OWNER_RENDER_CUT_ELEMENTS = 5;

export const MIN_REPEATED_SETTER_CALLS = 2;

export const MIN_TERMINAL_LEAVES = 2;

export const PAIRED_CLUSTER_SIZE = 2;

export const PAIRED_FINALIZER_STATEMENTS = 2;

export const PAIRED_SETTER_CALLS = 2;

export const PAIRED_TRANSPORT_OCCURRENCES = 2;

export const SMALL_OWNER_JSX_ELEMENTS = 5;

export const STABLE_CALL_SITE_PAIR = 2;

export const WIDE_OWNER_LINE_SPAN = 150;

export const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

export const SAFE_PROJECTION_CALLS: ReadonlySet<string> = new Set(["cn"]);

export const MEMO_HOOK_NAMES: ReadonlySet<string> = new Set(["useMemo"]);

export const CALLBACK_HOOK_NAMES: ReadonlySet<string> = new Set(["useCallback"]);

export const MUTATION_PROPERTY_NAMES: ReadonlySet<string> = new Set(["mutate", "mutateAsync"]);

export const EMPTY_NODES: ReadonlySet<ts.Node> = new Set();

export const EMPTY_RUNTIME_FUNCTIONS: ReadonlySet<RuntimeFunctionLike> = new Set();

export const EMPTY_STATE_CANDIDATES: ReadonlyMap<string, StateCandidate> = new Map();

export const EMPTY_STATE_USAGES: ReadonlyMap<string, StateUsage> = new Map();

export const PURE_MATH_METHODS: ReadonlySet<string> = new Set(["abs", "max", "min"]);
