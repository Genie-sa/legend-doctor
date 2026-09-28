import type { FileReach, HandedValue, Handoff } from "./synchronous-reach.js";
import type { ExecutionUnit } from "../../core/execution-units.js";

/** One synchronous stretch a write runs in, directly or through the functions the stretch calls. */
export interface WriteUnit {
  readonly key: string;
  /** The file whose code starts the stretch. */
  readonly file: string;
  /** The stretch also calls application code that is not in view, so it may write anything. */
  readonly opaque: boolean;
}

export interface ProgramReach {
  /** Every stretch that runs a write in `unit` after importers mount; module loading is excluded. */
  readonly writeUnits: (unit: ExecutionUnit) => readonly WriteUnit[];
}

interface CallGraph {
  readonly callers: Map<string, string[]>;
  readonly handoffs: Map<string, readonly Handoff[]>;
  readonly internal: Set<string>;
  readonly invoked: Map<string, Set<number>>;
  readonly opaque: Set<string>;
  readonly units: Map<string, ExecutionUnit>;
}

export function programReach(files: readonly FileReach[]): ProgramReach {
  const graph = mergedGraph(files);
  markInternalFunctions(graph, files);
  propagateInvokedParameters(graph);
  resolveHandoffs(graph);
  const reachesOpaque = callersClosure(graph.opaque, graph.callers);
  return {
    writeUnits: (unit) =>
      callingUnits(graph, unit)
        .filter(
          (current) =>
            !current.atModuleLoad && (current.resumed || !graph.internal.has(current.entry)),
        )
        .map((current) => ({
          file: current.file,
          key: current.key,
          opaque: (graph.invoked.get(current.key)?.size ?? 0) > 0 || reachesOpaque.has(current.key),
        })),
  };
}

/**
 * The unit itself plus every unit that reaches it through synchronous calls. A resumed stretch is
 * entered from a scheduler rather than a caller, so the walk stops there.
 */
function callingUnits(graph: CallGraph, unit: ExecutionUnit): ExecutionUnit[] {
  const found = new Map([[unit.key, unit]]);
  const pending = [unit];
  for (let current = pending.pop(); current; current = pending.pop()) {
    for (const caller of current.resumed ? [] : (graph.callers.get(current.key) ?? [])) {
      const callerUnit = graph.units.get(caller);
      if (callerUnit && !found.has(caller)) {
        found.set(caller, callerUnit);
        pending.push(callerUnit);
      }
    }
  }
  return [...found.values()];
}

function mergedGraph(files: readonly FileReach[]): CallGraph {
  const graph: CallGraph = {
    callers: new Map(),
    handoffs: new Map(),
    internal: new Set(),
    invoked: new Map(),
    opaque: new Set(),
    units: new Map(),
  };
  for (const file of files) {
    mergeFile(graph, file);
  }
  return graph;
}

function mergeFile(graph: CallGraph, file: FileReach): void {
  for (const [key, targets] of file.edges) {
    for (const target of targets) {
      addCaller(graph, target, key);
    }
  }
  for (const key of file.opaque) {
    graph.opaque.add(key);
  }
  copyEntries(graph.units, file.units);
  copyEntries(graph.handoffs, file.handoffs);
  for (const [key, indices] of file.parameterCalls) {
    graph.invoked.set(key, new Set(indices));
  }
}

function copyEntries<Value>(target: Map<string, Value>, source: ReadonlyMap<string, Value>): void {
  for (const [key, value] of source) {
    target.set(key, value);
  }
}

/**
 * A named function runs only inside its callers when nothing uses it as a value and every caller
 * is in view: it is private to its module, or exported and called from somewhere in the project.
 * An exported function nobody calls is taken to be an entry point that runs alone.
 */
function markInternalFunctions(graph: CallGraph, files: readonly FileReach[]): void {
  const escaping = new Set(files.flatMap((file) => [...file.escaping]));
  for (const file of files) {
    for (const entry of file.named) {
      if (!escaping.has(entry) && (!file.exported.has(entry) || graph.callers.has(entry))) {
        graph.internal.add(entry);
      }
    }
  }
}

function addCaller(graph: CallGraph, target: string, caller: string): void {
  const known = graph.callers.get(target) ?? [];
  known.push(caller);
  graph.callers.set(target, known);
}

/** A function calls a parameter when it calls it directly or forwards it to a callee that does. */
function propagateInvokedParameters(graph: CallGraph): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, handoffs] of graph.handoffs) {
      for (const value of invokedValues(graph, handoffs)) {
        if (value.kind === "parameter" && addInvoked(graph, key, value.index)) {
          changed = true;
        }
      }
    }
  }
}

function addInvoked(graph: CallGraph, key: string, index: number): boolean {
  const invoked = graph.invoked.get(key) ?? new Set<number>();
  if (invoked.has(index)) {
    return false;
  }
  invoked.add(index);
  graph.invoked.set(key, invoked);
  return true;
}

/**
 * Each call site runs the functions it hands to parameters the callee calls. A function literal
 * handed to such a parameter runs only there, so it never starts a stretch of its own.
 */
function resolveHandoffs(graph: CallGraph): void {
  for (const [key, handoffs] of graph.handoffs) {
    for (const value of invokedValues(graph, handoffs)) {
      if (value.kind === "function") {
        addCaller(graph, value.entry, key);
      }
      if (value.kind === "function" && value.literal) {
        graph.internal.add(value.entry);
      }
      if (value.kind === "unknown") {
        graph.opaque.add(key);
      }
    }
  }
}

/** The values a call site hands to parameters its callee calls before returning. */
function invokedValues(graph: CallGraph, handoffs: readonly Handoff[]): HandedValue[] {
  return handoffs.flatMap(({ callee, values }) =>
    [...(graph.invoked.get(callee) ?? [])]
      .map((index) => values[index])
      .filter((value) => value !== undefined),
  );
}

/** The given units plus every unit that synchronously calls into one of them. */
function callersClosure(
  seeds: ReadonlySet<string>,
  callers: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const closure = new Set(seeds);
  const pending = [...seeds];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    for (const caller of callers.get(key) ?? []) {
      if (!closure.has(caller)) {
        closure.add(caller);
        pending.push(caller);
      }
    }
  }
  return closure;
}
