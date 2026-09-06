import type {
  HookPresentationConsumer,
  HookReturnMembers,
} from "../../rules/child-contract/model.js";
import {
  hookConsumerResult,
  hookPresentationConsumerResult,
} from "../../rules/hook-consumer-contract/hook-consumer-contract.js";
import type { AnalysisContext } from "./analysis-context.js";
import { hookConsumers } from "./hook-consumer-index.js";

interface HookConsumerQuery {
  readonly context: AnalysisContext;
  readonly hookName: string;
  readonly importerFile: string;
  readonly members: HookReturnMembers;
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
