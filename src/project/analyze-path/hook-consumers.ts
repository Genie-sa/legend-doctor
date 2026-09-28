import type {
  HookPresentationConsumer,
  HookReturnMember,
  HookReturnMembers,
} from "../../rules/child-contract/model.js";
import {
  harnessNeverNamesMember,
  hookMemberReadResult,
} from "../../rules/hook-consumer-contract/unread-member.js";
import {
  hookConsumerResult,
  hookPresentationConsumerResult,
} from "../../rules/hook-consumer-contract/hook-consumer-contract.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { HookMemberReadResult } from "../../rules/hook-consumer-contract/unread-member.js";
import { closedHookConsumers } from "./hook-consumer-closure.js";
import { hookConsumers } from "./hook-consumer-index.js";

interface HookConsumerQuery {
  readonly context: AnalysisContext;
  readonly hookName: string;
  readonly importerFile: string;
  readonly members: HookReturnMembers;
}

interface HookMemberQuery {
  readonly context: AnalysisContext;
  readonly hookName: string;
  readonly importerFile: string;
  readonly member: HookReturnMember;
}

interface PresentationConsumerQuery extends HookConsumerQuery {
  readonly broadOwnerJsx: number;
}

export function hasSingleLeafConsumer(query: HookConsumerQuery): boolean {
  const declaration = query.context.sourceIndex.hookDeclarationFor(
    query.importerFile,
    query.hookName,
  );
  if (!declaration) {
    return false;
  }
  const results = hookConsumers(query.context, declaration).map(({ file, hookBinding }) =>
    hookConsumerResult({ hookBinding, members: query.members, sourceFile: file.sourceFile }),
  );
  return !results.includes("unsafe") && results.filter((result) => result === "leaf").length === 1;
}

/**
 * Counts the production call sites of a hook when the scanned root closes over all of its bindings
 * and none of them reads one returned member; null when any use is unproven or none renders.
 */
export function unreadHookMemberCalls(query: HookMemberQuery): number | null {
  const declaration = query.context.sourceIndex.hookDeclarationFor(
    query.importerFile,
    query.hookName,
  );
  const closure = declaration ? closedHookConsumers(query.context, declaration) : null;
  if (
    !closure ||
    !closure.opaqueHarnesses.every((file) => harnessNeverNamesMember(file.sourceFile, query.member))
  ) {
    return null;
  }
  const results = closure.bindings.map(({ file, harness, hookBinding }) =>
    hookMemberReadResult({
      harness,
      hookBinding,
      member: query.member,
      sourceFile: file.sourceFile,
    }),
  );
  return unreadCallTotal(results);
}

function unreadCallTotal(results: readonly HookMemberReadResult[]): number | null {
  let calls = 0;
  for (const result of results) {
    if (result.kind === "unsafe") {
      return null;
    }
    calls += result.calls;
  }
  return calls > 0 ? calls : null;
}

export function findHookPresentationConsumer(
  query: PresentationConsumerQuery,
): HookPresentationConsumer | null {
  const declaration = query.context.sourceIndex.hookDeclarationFor(
    query.importerFile,
    query.hookName,
  );
  if (!declaration) {
    return null;
  }
  const results = hookConsumers(query.context, declaration).map(({ file, hookBinding }) =>
    hookPresentationConsumerResult({
      broadOwnerJsx: query.broadOwnerJsx,
      hookBinding,
      members: query.members,
      pureProjectionImports: query.context.sourceIndex.pureProjectionsFor(file.identityPath),
      sourceFile: file.sourceFile,
    }),
  );
  if (results.includes("unsafe")) {
    return null;
  }
  const consumers = results.filter((result) => isPresentationConsumer(result));
  return consumers.length === 0
    ? null
    : {
        consumerNames: [
          ...new Set(consumers.flatMap((consumer) => consumer.consumerNames)),
        ].toSorted(),
        derivedBindings: [
          ...new Set(consumers.flatMap((consumer) => consumer.derivedBindings)),
        ].toSorted(),
        renderSites: consumers.reduce((total, consumer) => total + consumer.renderSites, 0),
      };
}

function isPresentationConsumer(
  result: ReturnType<typeof hookPresentationConsumerResult>,
): result is HookPresentationConsumer {
  return result !== "unsafe" && result !== "none";
}
