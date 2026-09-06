import type { CallbackContractSourceResolver, ChildComponentSource } from "./model.js";
import type { ForwardedPropProof, LeafRenderProof } from "./leaf-render.js";
import { PATH_DEFERRAL, rootTrace, sourceInputCallbackIsDeferred } from "./path-trace.js";
import { bindingDeclarationCount, isNonValueIdentifier } from "../../core/analysis-ast.js";
import {
  bindingElementPropertyName,
  boundPropIdentifier,
  isBindingName,
  propsParameter,
} from "./prop-bindings.js";
import { declaredPropType, primitiveValueType } from "./declared-prop-types.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import { leafRenderVerdict, spreadVerdict } from "./leaf-render.js";
import type { ArrayItemCallbackQuery } from "./array-item-callbacks.js";
import { arrayItemCallbackIsDeferred } from "./array-item-callbacks.js";
import { collectHookImports } from "../../core/imports.js";
import { reactEffectCallbackUsage } from "./react-effect-usage.js";
import ts from "typescript";

/**
 * Proves that a child component consumes one prop as a pure render value:
 * every read lands in JSX output of host elements or in bounded pure
 * projections of such reads, and no read escapes into hooks, callbacks,
 * writes, or other calls. A read forwarded to another component, directly or
 * through a rest spread, counts only when that component is itself a proven
 * leaf render consumer of the same prop, up to a bounded depth. Only then can
 * the owner keep the observable and the call site subscribe without changing
 * behavior.
 */
export type LeafRenderResolver = (file: string, name: string) => ChildComponentSource | null;

export const MAX_LEAF_FORWARD_DEPTH = 3;

interface LeafRenderQuery {
  readonly depth: number;
  readonly resolver: LeafRenderResolver | null;
  readonly visited: ReadonlySet<string>;
}

export function propIsLeafRenderConsumer(
  source: ChildComponentSource,
  propName: string,
  resolver: LeafRenderResolver | null = null,
): boolean {
  return propIsLeafRenderConsumerAt(source, propName, { depth: 0, resolver, visited: new Set() });
}

function propIsLeafRenderConsumerAt(
  source: ChildComponentSource,
  propName: string,
  query: LeafRenderQuery,
): boolean {
  if (!source.owner.body) {
    return false;
  }
  const proof: LeafRenderProof = {
    forwarded: forwardedPropProof(source, query),
    hostTags: collectHookImports(source.owner.getSourceFile()),
  };
  const bound = boundPropIdentifier(source.owner, propName, source.reactWrapped === true);
  if (bound) {
    return (
      bindingDeclarationCount(source.owner, bound.text) === 1 &&
      boundPropRendersAsLeaf(source, bound, proof)
    );
  }
  return restPropRendersAsLeaf(source, propName, proof);
}

function forwardedPropProof(
  source: ChildComponentSource,
  { depth, resolver, visited }: LeafRenderQuery,
): ForwardedPropProof | null {
  if (!resolver || depth >= MAX_LEAF_FORWARD_DEPTH) {
    return null;
  }
  return (opening, forwardedProp) => {
    if (!ts.isIdentifier(opening.tagName)) {
      return false;
    }
    const child = resolver(source.file, opening.tagName.text);
    const key = `${child?.file ?? ""}\0${opening.tagName.text}\0${forwardedProp}`;
    if (!child || visited.has(key)) {
      return false;
    }
    return propIsLeafRenderConsumerAt(child, forwardedProp, {
      depth: depth + 1,
      resolver,
      visited: new Set([...visited, key]),
    });
  };
}

function boundPropRendersAsLeaf(
  source: ChildComponentSource,
  bound: ts.Identifier,
  proof: LeafRenderProof,
): boolean {
  let renderReads = 0;
  let safe = true;
  const scope = { ...proof, tracked: new Set([bound.text]) };
  visit(source.owner.body, (node) => {
    if (!safe || !ts.isIdentifier(node) || !scope.tracked.has(node.text)) {
      return;
    }
    const verdict = leafRenderVerdict(node, source, scope);
    if (verdict === "render-read") {
      renderReads += 1;
    } else if (verdict === "unsafe") {
      safe = false;
    }
  });
  return safe && renderReads > 0;
}

/**
 * When the prop is not destructured it travels inside the rest binding (or the whole props
 * parameter). Every reference to that binding must then be a JSX spread whose receiver renders the
 * prop, so the prop still ends in host output.
 */
function restPropRendersAsLeaf(
  source: ChildComponentSource,
  propName: string,
  proof: LeafRenderProof,
): boolean {
  const rest = restPropsBinding(source, propName);
  if (!rest || bindingDeclarationCount(source.owner, rest.text) !== 1) {
    return false;
  }
  let renderReads = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (!safe || !ts.isIdentifier(node) || node.text !== rest.text || isNonValueIdentifier(node)) {
      return;
    }
    if (findAncestor(node, isRuntimeFunctionLike) !== source.owner) {
      safe = false;
      return;
    }
    const verdict = ts.isJsxSpreadAttribute(node.parent)
      ? spreadVerdict(node.parent, propName, proof)
      : "unsafe";
    if (verdict === "render-read") {
      renderReads += 1;
    } else if (verdict === "unsafe") {
      safe = false;
    }
  });
  return safe && renderReads > 0;
}

function restPropsBinding(source: ChildComponentSource, propName: string): ts.Identifier | null {
  const parameter = propsParameter(source.owner, source.reactWrapped === true);
  if (!parameter) {
    return null;
  }
  if (ts.isIdentifier(parameter.name)) {
    return parameter.name;
  }
  if (!ts.isObjectBindingPattern(parameter.name)) {
    return null;
  }
  const explicit = parameter.name.elements.some(
    (element) => !element.dotDotDotToken && bindingElementPropertyName(element) === propName,
  );
  const rest = parameter.name.elements.find((element) => element.dotDotDotToken);
  return !explicit && rest && ts.isIdentifier(rest.name) ? rest.name : null;
}

/**
 * Proves that one directly bound child prop has a primitive declared type and
 * is consumed by the child. Primitive values make a parent-driven render and
 * a child-owned subscription observably equivalent; object identity and React
 * wrapper comparators remain outside this contract.
 */
export function propIsPrimitiveValueConsumer(
  source: ChildComponentSource,
  propName: string,
): boolean {
  if (source.reactWrapped) {
    return false;
  }
  const bound = boundPropIdentifier(source.owner, propName);
  const type = declaredPropType(source, propName);
  if (
    !bound ||
    !type ||
    !primitiveValueType(type) ||
    bindingDeclarationCount(source.owner, bound.text) !== 1
  ) {
    return false;
  }

  let reads = 0;
  visit(source.owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node !== bound &&
      node.text === bound.text &&
      !isNonValueIdentifier(node) &&
      !isBindingName(node)
    ) {
      reads += 1;
    }
  });
  return reads > 0;
}

export function propDefersArrayItemCallback(query: ArrayItemCallbackQuery): boolean {
  return arrayItemCallbackIsDeferred(query, PATH_DEFERRAL);
}

/**
 * Proves that one callback field of an object prop can only execute after
 * render. The path may cross local/imported component wrappers, JSX spreads,
 * object destructuring, and source-resolved custom hooks. Every path must end
 * in a host-style event prop or a callback whose own registration is proven
 * deferred.
 */
export interface ObjectPropCallbackQuery {
  readonly callbackProperty: string;
  readonly propName: string;
  readonly resolver: CallbackContractSourceResolver;
  readonly source: ChildComponentSource;
}

export function propObjectCallbackIsDeferred({
  callbackProperty,
  propName,
  resolver,
  source,
}: ObjectPropCallbackQuery): boolean {
  return sourceInputCallbackIsDeferred({
    argumentIndex: 0,
    path: [propName, callbackProperty],
    source,
    trace: rootTrace(resolver),
  });
}

export function propCallbackIsDeferred(
  source: ChildComponentSource,
  propName: string,
  resolver: CallbackContractSourceResolver,
): boolean {
  return sourceInputCallbackIsDeferred({
    argumentIndex: 0,
    path: [propName],
    source,
    trace: rootTrace(resolver),
  });
}

/**
 * Proves that a callback prop is referenced only by a React effect: direct
 * invocations and presence checks run in the effect body, while other reads
 * may only preserve the dependency list. This is intentionally narrower than
 * the general deferred-callback contract because an unknown deferred consumer
 * could establish its own Legend tracking context.
 */
export function propCallbackRunsOnlyInReactEffect(
  source: ChildComponentSource,
  propName: string,
): boolean {
  const bound = boundPropIdentifier(source.owner, propName);
  if (!bound || !source.owner.body) {
    return false;
  }
  if (bindingDeclarationCount(source.owner, bound.text) !== 1) {
    return false;
  }

  const imports = collectHookImports(source.owner.getSourceFile());
  let invocations = 0;
  let safe = true;
  visit(source.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== bound.text ||
      node === bound ||
      isNonValueIdentifier(node) ||
      isBindingName(node)
    ) {
      return;
    }
    const usage = reactEffectCallbackUsage(node, source.owner, imports);
    if (usage === "invoke") {
      invocations += 1;
    }
    if (usage === null) {
      safe = false;
    }
  });
  return safe && invocations > 0;
}
