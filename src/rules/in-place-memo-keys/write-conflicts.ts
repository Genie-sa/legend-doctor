import type { MemoRead, RelativeWrite } from "./model.js";
import { ANY_MEMBER } from "../../project/source-components/observable-in-place-writes.js";
import type { InPlaceObservableWrite } from "../../project/source-components/observable-in-place-writes.js";

/**
 * Writes strictly below the useValue source keep the returned reference. A write to the source
 * path itself or above it replaces the value, so a reference comparison sees it.
 */
export function writesBelow(
  sourceMembers: readonly string[],
  writes: readonly InPlaceObservableWrite[],
): RelativeWrite[] {
  return writes.flatMap((write) =>
    write.path.length > sourceMembers.length && isPathPrefix(sourceMembers, write.path)
      ? [{ path: write.path.slice(sourceMembers.length), write }]
      : [],
  );
}

/**
 * A write changes what a read observes when it replaces the read member or one of its ancestors,
 * or when it lands anywhere inside contents the memo callback consumes.
 */
export function writeChangesRead(write: RelativeWrite, read: MemoRead): boolean {
  return (
    isPathPrefix(write.path, read.path) ||
    (read.consumesContents && isPathPrefix(read.path, write.path))
  );
}

export function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every(
      (member, index) =>
        member === ANY_MEMBER || path[index] === ANY_MEMBER || member === path[index],
    )
  );
}
