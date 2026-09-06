import type {
  CallbackContractSourceResolver,
  CallbackDeferral,
  CallbackReferenceProbe,
  CallbackTrace,
  ChildComponentSource,
  SourceInputProbe,
  TrackedCallbackPath,
} from "./model.js";
import { MAX_CALLBACK_PATH_DEPTH, deeperTrace } from "./model.js";
import { bindCallbackPath, isBindingName } from "./prop-bindings.js";
import { bindingDeclarationCount, isNonValueIdentifier } from "../../core/analysis-ast.js";
import { climbTransparentExpression, staticPropertyAccessFrom } from "./carried-values.js";
import { callbackPathExpressionIsDeferred } from "./expression-stages.js";
import { destructuredCallbackPath } from "./hook-boundary-paths.js";
import { identifiersNamed } from "../../core/ast.js";
import type ts from "typescript";

export const PATH_DEFERRAL: CallbackDeferral = {
  sourceInput: sourceInputCallbackIsDeferred,
  trackedPath: trackedCallbackPathIsDeferred,
};

export function rootTrace(resolver: CallbackContractSourceResolver): CallbackTrace {
  return { deferral: PATH_DEFERRAL, depth: 0, resolver, returnTarget: null, visited: new Set() };
}

export function sourceInputCallbackIsDeferred(probe: SourceInputProbe): boolean {
  const { argumentIndex, path, source, trace } = probe;
  if (trace.depth > MAX_CALLBACK_PATH_DEPTH || !source.owner.body) {
    return false;
  }
  const parameter = source.owner.parameters[argumentIndex];
  const tracked = parameter ? bindCallbackPath(parameter.name, path) : null;
  return tracked !== null && trackedCallbackPathIsDeferred(source, tracked, trace);
}

function trackedPathKey(source: ChildComponentSource, tracked: TrackedCallbackPath): string {
  const invocationKey = source.invocation
    ? `${source.invocation.getSourceFile().fileName}:${source.invocation.pos}`
    : "";
  return `${source.file}\0${source.owner.pos}\0${invocationKey}\0${tracked.name}\0${tracked.path.join(".")}`;
}

function trackedReferencesAreDeferred(
  source: ChildComponentSource,
  tracked: TrackedCallbackPath,
  trace: CallbackTrace,
): boolean {
  let references = 0;
  let safe = true;
  for (const node of identifiersNamed(source.owner.body, tracked.name)) {
    if (!safe) {
      break;
    }
    if (isBindingName(node) || isNonValueIdentifier(node)) {
      continue;
    }
    references += 1;
    safe = callbackPathReferenceIsDeferred({ path: tracked.path, reference: node, source, trace });
  }
  return safe && references > 0;
}

function trackedCallbackPathIsDeferred(
  source: ChildComponentSource,
  tracked: TrackedCallbackPath,
  trace: CallbackTrace,
): boolean {
  if (
    trace.depth > MAX_CALLBACK_PATH_DEPTH ||
    bindingDeclarationCount(source.owner, tracked.name) !== 1
  ) {
    return false;
  }
  const key = trackedPathKey(source, tracked);
  if (trace.visited.has(key)) {
    return false;
  }
  const nextTrace: CallbackTrace = {
    deferral: trace.deferral,
    depth: trace.depth,
    resolver: trace.resolver,
    returnTarget: trace.returnTarget,
    visited: new Set(trace.visited).add(key),
  };
  return trackedReferencesAreDeferred(source, tracked, nextTrace);
}

function nestedPathVerdict(options: {
  readonly expression: ts.Expression;
  readonly head: string;
  readonly path: readonly string[];
  readonly source: ChildComponentSource;
  readonly trace: CallbackTrace;
}): boolean | null {
  const { expression, head, path, source, trace } = options;
  const access = staticPropertyAccessFrom(expression);
  if (access) {
    return (
      access.name !== head ||
      callbackPathExpressionIsDeferred({
        expression: access.expression,
        path: path.slice(1),
        source,
        trace,
      })
    );
  }
  const destructured = destructuredCallbackPath(source.owner, expression, path);
  if (destructured) {
    return trackedCallbackPathIsDeferred(
      source,
      destructured,
      deeperTrace(trace, trace.returnTarget),
    );
  }
  return null;
}

function callbackPathReferenceIsDeferred(probe: CallbackReferenceProbe): boolean {
  const { path, reference, source, trace } = probe;
  const expression = climbTransparentExpression(reference);
  const [head] = path;
  const nested =
    head === undefined ? null : nestedPathVerdict({ expression, head, path, source, trace });
  if (nested !== null) {
    return nested;
  }
  return callbackPathExpressionIsDeferred({ expression, path, source, trace });
}
