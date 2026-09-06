import type { AnalysisContext } from "./analysis-context.js";
import type { AnalysisFile } from "../analysis-project.js";
import type { ResolvedSymbol } from "../source-components/model.js";
import { importedHookBindings } from "./source-declarations.js";
import { isNonProductionHarness } from "../../core/ast.js";
import { pathIdentityKey } from "../../core/path-identity.js";

interface HookConsumerBinding {
  readonly file: AnalysisFile;
  readonly hookBinding: string;
}

// Context identity owns the snapshot: a new scan never reuses old files or resolutions.
const consumersByContext = new WeakMap<
  AnalysisContext,
  ReadonlyMap<string, readonly HookConsumerBinding[]>
>();

export function importedHookConsumers(
  context: AnalysisContext,
  declaration: ResolvedSymbol,
): readonly HookConsumerBinding[] {
  let index = consumersByContext.get(context);
  if (!index) {
    index = buildHookConsumerIndex(context);
    consumersByContext.set(context, index);
  }
  return index.get(symbolKey(declaration)) ?? [];
}

export function hookConsumers(
  context: AnalysisContext,
  declaration: ResolvedSymbol,
): readonly HookConsumerBinding[] {
  const imported = importedHookConsumers(context, declaration);
  const file = context.project.getFile(declaration.file);
  if (!file || isNonProductionHarness(file.originalPath)) {
    return imported;
  }
  // Preserve project-file order, with local reads after imports from the same file.
  const nextFile = imported.findIndex((consumer) => consumer.file.identityPath > file.identityPath);
  const consumers = [...imported];
  consumers.splice(nextFile === -1 ? consumers.length : nextFile, 0, {
    file,
    hookBinding: declaration.localName,
  });
  return consumers;
}

function buildHookConsumerIndex(
  context: AnalysisContext,
): ReadonlyMap<string, readonly HookConsumerBinding[]> {
  const index = new Map<string, HookConsumerBinding[]>();
  for (const file of context.project.files) {
    if (isNonProductionHarness(file.originalPath)) {
      continue;
    }
    for (const hookBinding of importedHookBindings(file.sourceFile)) {
      indexConsumer(context, index, { file, hookBinding });
    }
  }
  return index;
}

function indexConsumer(
  context: AnalysisContext,
  index: Map<string, HookConsumerBinding[]>,
  consumer: HookConsumerBinding,
): void {
  const declaration = context.sourceIndex.hookDeclarationFor(
    consumer.file.identityPath,
    consumer.hookBinding,
  );
  if (declaration) {
    const key = symbolKey(declaration);
    const consumers = index.get(key) ?? [];
    consumers.push(consumer);
    index.set(key, consumers);
  }
}

function symbolKey(declaration: ResolvedSymbol): string {
  return `${pathIdentityKey(declaration.file)}\0${declaration.localName}`;
}
