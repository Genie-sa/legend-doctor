import type {
  InPlaceObservableWrite,
  ObservableInPlaceWrites,
} from "../../project/source-components/observable-in-place-writes.js";
import { ANY_MEMBER } from "../../project/source-components/observable-in-place-writes.js";
import { isNonProductionHarness } from "../../core/ast.js";

/** Top-level fields of one observable that a single production write changes together. */
export type FieldWriteGroup = ReadonlySet<string>;

/** Field groups per observable, from its production writes; test and story writes are ignored. */
export function observableFieldWriteGroups(
  writes: ObservableInPlaceWrites,
): ReadonlyMap<string, readonly FieldWriteGroup[]> {
  return new Map(
    [...writes].map(([name, sites]) => [
      name,
      fieldWriteGroups(sites.filter((site) => !isNonProductionHarness(site.file))),
    ]),
  );
}

/**
 * Writes on one source line form one group, so an `assign` of several keys, or two writes sharing
 * a line, only ever widens a group. A group that reaches a runtime-keyed member may change any
 * field and is dropped.
 */
function fieldWriteGroups(sites: readonly InPlaceObservableWrite[]): readonly FieldWriteGroup[] {
  const groups = new Map<string, Set<string>>();
  for (const site of sites) {
    const key = `${site.file}:${site.line}`;
    const group = groups.get(key) ?? new Set<string>();
    group.add(site.path[0] ?? ANY_MEMBER);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => !group.has(ANY_MEMBER));
}

export interface ObservableFieldFacts {
  /** Exact top-level keys per observable whose initial value is an object literal. */
  readonly keys: ReadonlyMap<string, ReadonlySet<string>>;
  /** The subset of those keys that hold data rather than functions. */
  readonly dataKeys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly writes: ReadonlyMap<string, readonly FieldWriteGroup[]>;
}

export const NO_OBSERVABLE_FIELD_FACTS: ObservableFieldFacts = {
  dataKeys: new Map(),
  keys: new Map(),
  writes: new Map(),
};
