import {
  bindCallbackPath,
  isModuleBindingReference,
  objectBindingOmitsProperty,
} from "./prop-bindings.js";
import { findAncestor, identifiersNamed, isRuntimeFunctionLike } from "../../core/ast.js";
import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import type { CallbackTrace } from "./model.js";
import { MAX_CALLBACK_PATH_DEPTH } from "./model.js";
import { climbTransparentExpression } from "./carried-values.js";
import ts from "typescript";

interface ContextConsumerProbe {
  readonly contextName: string;
  readonly property: string;
  readonly providerFile: string;
  readonly trace: CallbackTrace;
}

type ContextConsumerVerdict = "consumed-deferred" | "consumed-undeferred" | "ignored" | "unsafe";

interface ContextConsumerOutcome {
  readonly consumed: boolean;
  readonly safe: boolean;
}

function contextReaderOwner(call: ts.CallExpression): {
  readonly body: ts.ConciseBody;
  readonly owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
} | null {
  const owner = findAncestor(call, isRuntimeFunctionLike);
  if (
    !owner ||
    (!ts.isArrowFunction(owner) &&
      !ts.isFunctionDeclaration(owner) &&
      !ts.isFunctionExpression(owner)) ||
    !owner.body
  ) {
    return null;
  }
  return { body: owner.body, owner };
}

function contextReaderConsumer(node: ts.Identifier): {
  readonly body: ts.ConciseBody;
  readonly declaration: ts.VariableDeclaration;
  readonly owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
} | null {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.expression !== node) {
    return null;
  }
  const resolved = contextReaderOwner(call);
  const carriedCall = climbTransparentExpression(call);
  const declaration = carriedCall.parent;
  if (
    !resolved ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== carriedCall
  ) {
    return null;
  }
  return { body: resolved.body, declaration, owner: resolved.owner };
}

function contextReaderVerdict(
  node: ts.Identifier,
  file: string,
  probe: ContextConsumerProbe,
): ContextConsumerVerdict {
  const { property, trace } = probe;
  if (isDeclarationName(node) || isNonValueIdentifier(node) || isModuleBindingReference(node)) {
    return "ignored";
  }
  const consumer = contextReaderConsumer(node);
  if (!consumer) {
    return "unsafe";
  }
  const tracked = bindCallbackPath(consumer.declaration.name, [property]);
  if (!tracked) {
    return objectBindingOmitsProperty(consumer.declaration.name, property) ? "ignored" : "unsafe";
  }
  return trace.deferral.trackedPath(
    {
      body: consumer.body,
      deferredCallbackHooks: trace.resolver.deferredCallbackHooks(file),
      file,
      owner: consumer.owner,
    },
    tracked,
    trace,
  )
    ? "consumed-deferred"
    : "consumed-undeferred";
}

function contextReaderIdentifiers(
  sourceFile: ts.SourceFile,
  hookNames: ReadonlySet<string>,
): readonly ts.Identifier[] {
  return [...hookNames].flatMap((hookName) => [...identifiersNamed(sourceFile, hookName)]);
}

function contextFileConsumersAreDeferred(
  nodes: readonly ts.Identifier[],
  file: string,
  probe: ContextConsumerProbe,
): ContextConsumerOutcome {
  let consumed = false;
  let safe = true;
  for (const node of nodes) {
    if (!safe) {
      break;
    }
    const verdict = contextReaderVerdict(node, file, probe);
    if (verdict === "consumed-deferred" || verdict === "consumed-undeferred") {
      consumed = true;
    }
    safe = verdict !== "unsafe" && verdict !== "consumed-undeferred";
  }
  return { consumed, safe };
}

function contextReadersOutcome(
  readers: ReadonlyMap<string, ReadonlySet<string>>,
  probe: ContextConsumerProbe,
): ContextConsumerOutcome | null {
  let consumed = false;
  let safe = true;
  for (const [file, hookNames] of readers) {
    const sourceFile = probe.trace.resolver.sourceFile(file);
    if (!sourceFile) {
      return null;
    }
    const outcome = contextFileConsumersAreDeferred(
      contextReaderIdentifiers(sourceFile, hookNames),
      file,
      probe,
    );
    consumed ||= outcome.consumed;
    safe &&= outcome.safe;
  }
  return { consumed, safe };
}

export function contextPropertyConsumersAreDeferred(probe: ContextConsumerProbe): boolean {
  const { contextName, providerFile, trace } = probe;
  if (trace.depth > MAX_CALLBACK_PATH_DEPTH) {
    return false;
  }
  const readers = trace.resolver.contextReaderHooks(providerFile, contextName);
  if (readers.size === 0) {
    return false;
  }
  const outcome = contextReadersOutcome(readers, probe);
  return outcome !== null && outcome.safe && outcome.consumed;
}
