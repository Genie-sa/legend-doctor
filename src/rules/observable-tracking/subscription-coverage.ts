import { isRuntimeFunctionLike, visit } from "../../core/ast.js";
import { isTrackingHookCall, provenObservablePath } from "../observable-reads/observable-paths.js";
import {
  staticPathHasBinding,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { RenderFunction } from "./render-owners.js";
import type { TrackingScan } from "./model.js";
import ts from "typescript";

type ObservablePath = readonly string[];

const MAX_ALIAS_DEPTH = 10;

const subscriptionsByOwner = new WeakMap<RenderFunction, readonly ObservablePath[]>();
const aliasesBySource = new WeakMap<ts.SourceFile, ReadonlyMap<string, ObservablePath>>();

/**
 * True when a `useValue` (or legacy selector hook) call in the owner's own render already
 * subscribes to `path` or to one of its ancestors, so an untracked read of `path` still
 * re-renders with every change it could observe.
 */
export function hasCoveringSubscription(
  owner: RenderFunction,
  path: ObservablePath,
  scan: TrackingScan,
): boolean {
  const read = canonicalPath(path, scan);
  return subscribedPaths(owner, scan).some(
    (subscribed) =>
      subscribed.length <= read.length &&
      subscribed.every((segment, index) => segment === read[index]),
  );
}

function subscribedPaths(owner: RenderFunction, scan: TrackingScan): readonly ObservablePath[] {
  const cached = subscriptionsByOwner.get(owner);
  if (cached) {
    return cached;
  }
  const paths: ObservablePath[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTrackingHookCall(node, scan.imports)) {
      const [selector] = node.arguments;
      if (selector) {
        paths.push(...selectorPaths(selector, scan));
      }
      return;
    }
    if (isRuntimeFunctionLike(node) && node !== owner) {
      return;
    }
    node.forEachChild(walk);
  };
  if (owner.body) {
    walk(owner.body);
  }
  subscriptionsByOwner.set(owner, paths);
  return paths;
}

function selectorPaths(selector: ts.Expression, scan: TrackingScan): ObservablePath[] {
  const direct = provenObservablePath(selector, scan.observableBindings);
  if (direct) {
    const path = staticPropertyPath(direct);
    return path ? [canonicalPath(path, scan)] : [];
  }
  const body = unwrapTransparentExpression(selector);
  if (!ts.isArrowFunction(body) && !ts.isFunctionExpression(body)) {
    return [];
  }
  const paths: ObservablePath[] = [];
  visit(body.body, (node) => {
    const receiver = trackedGetReceiver(node);
    const observable = receiver && provenObservablePath(receiver, scan.observableBindings);
    const path = observable && staticPropertyPath(observable);
    if (path) {
      paths.push(canonicalPath(path, scan));
    }
  });
  return paths;
}

function trackedGetReceiver(node: ts.Node): ts.Expression | null {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length > 1 ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "get"
  ) {
    return null;
  }
  return unwrapTransparentExpression(node.expression.expression);
}

function canonicalPath(path: ObservablePath, scan: TrackingScan): ObservablePath {
  const aliases = observableAliases(scan);
  let current = path;
  for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
    const [root, ...rest] = current;
    const target = root === undefined ? undefined : aliases.get(root);
    if (!target) {
      return current;
    }
    current = [...target, ...rest];
  }
  return current;
}

function observableAliases(scan: TrackingScan): ReadonlyMap<string, ObservablePath> {
  const cached = aliasesBySource.get(scan.sourceFile);
  if (cached) {
    return cached;
  }
  const declarationCounts = new Map<string, number>();
  const candidates = new Map<string, ObservablePath>();
  visit(scan.sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
      return;
    }
    const name = node.name.text;
    declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
    const initializer = node.initializer && unwrapTransparentExpression(node.initializer);
    if (
      !initializer ||
      !ts.isPropertyAccessExpression(initializer) ||
      !staticPathHasBinding(initializer, scan.observableBindings)
    ) {
      return;
    }
    const path = staticPropertyPath(initializer);
    if (path) {
      candidates.set(name, path);
    }
  });
  const aliases = new Map([...candidates].filter(([name]) => declarationCounts.get(name) === 1));
  aliasesBySource.set(scan.sourceFile, aliases);
  return aliases;
}
