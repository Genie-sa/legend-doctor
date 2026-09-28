import type {
  InPlaceObservableWrite,
  ObservableInPlaceWrites,
} from "../../project/source-components/observable-in-place-writes.js";
import { ANY_MEMBER } from "../../project/source-components/observable-in-place-writes.js";
import { isNonProductionHarness } from "../../core/ast.js";

/**
 * The member paths below one observable root that a single synchronous stretch of production code
 * writes, so one render observes them together; `*` stands for a member known only at runtime.
 */
export interface ObservableWriteGroup {
  readonly paths: readonly (readonly string[])[];
  /** `file:line` of the stretch's first write, relative to the analysis root. */
  readonly site: string;
}

/**
 * Write groups per observable, from the production writes that can land after a consumer mounts:
 * test and story writes and module-load initialization are ignored.
 */
export function observableWriteGroups(
  writes: ObservableInPlaceWrites,
): ReadonlyMap<string, readonly ObservableWriteGroup[]> {
  return new Map(
    [...writes].map(([name, sites]) => [
      name,
      writeGroups(
        sites.filter((site) => !site.unit.atModuleLoad && !isNonProductionHarness(site.file)),
      ),
    ]),
  );
}

function writeGroups(sites: readonly InPlaceObservableWrite[]): readonly ObservableWriteGroup[] {
  const groups = new Map<string, ObservableWriteGroup>();
  for (const site of sites) {
    const key = `${site.file}\0${site.unit.key}`;
    const group = groups.get(key) ?? { paths: [], site: `${site.file}:${site.line}` };
    groups.set(key, { ...group, paths: [...group.paths, site.path] });
  }
  return [...groups.values()];
}

/** The top-level fields a group writes, or null when a runtime-keyed member could be any field. */
export function topLevelFields(group: ObservableWriteGroup): ReadonlySet<string> | null {
  const fields = new Set(group.paths.map((path) => path[0] ?? ANY_MEMBER));
  return fields.has(ANY_MEMBER) ? null : fields;
}

/** Whether two member paths can name the same node or one another's ancestor. */
export function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const [leftMember, rightMember] = [left[index], right[index]];
    if (leftMember !== rightMember && leftMember !== ANY_MEMBER && rightMember !== ANY_MEMBER) {
      return false;
    }
  }
  return true;
}

export interface ObservableFieldFacts {
  /** Exact top-level keys per observable whose initial value is an object literal. */
  readonly keys: ReadonlyMap<string, ReadonlySet<string>>;
  /** The subset of those keys that hold data rather than functions. */
  readonly dataKeys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly writes: ReadonlyMap<string, readonly ObservableWriteGroup[]>;
}

export const NO_OBSERVABLE_FIELD_FACTS: ObservableFieldFacts = {
  dataKeys: new Map(),
  keys: new Map(),
  writes: new Map(),
};
