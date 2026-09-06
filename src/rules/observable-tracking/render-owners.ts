import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { jsxElementCount } from "../state-proofs/jsx-subtrees.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

export type RenderFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

export interface RenderOwner {
  /** Synchronous iteration callbacks between the node and the render function's own body. */
  readonly hops: number;
  readonly kind: "component" | "hook";
  readonly name: string;
  readonly owner: RenderFunction;
  /** `observer` or `reactiveObserver` wraps the component, so `get()` calls in its render track. */
  readonly tracked: boolean;
}

interface ObservedFunctions {
  readonly names: ReadonlySet<string>;
  readonly nodes: ReadonlySet<ts.Node>;
}

const SYNC_ITERATION_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
  "toSorted",
]);

const OBSERVER_FACTORIES = new Set(["observer", "reactiveObserver"]);

const observedFunctionsBySource = new WeakMap<ts.SourceFile, ObservedFunctions>();

/**
 * Resolves the component or custom hook whose render executes `node`. A node inside a nested
 * function counts only when that function is the callback of a synchronous array iteration
 * method whose call is itself render-executed; every other nested function (handlers, effects,
 * selectors, reactive children) has its own execution context and returns null.
 */
export function renderOwnerOf(node: ts.Node, imports: HookImports): RenderOwner | null {
  return resolveRenderOwner(node, imports, 0);
}

function resolveRenderOwner(node: ts.Node, imports: HookImports, hops: number): RenderOwner | null {
  const enclosing = findAncestor(node, isRuntimeFunctionLike);
  if (!enclosing) {
    return null;
  }
  const owner = classifyRenderFunction(enclosing, imports);
  if (owner) {
    return { ...owner, hops };
  }
  const iteration = renderIterationCall(enclosing);
  return iteration ? resolveRenderOwner(iteration, imports, hops + 1) : null;
}

function renderIterationCall(callback: RuntimeFunctionLike): ts.CallExpression | null {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    return null;
  }
  let current: ts.Node = callback;
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const call = current.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== current) {
    return null;
  }
  const callee = unwrapTransparentExpression(call.expression);
  return ts.isPropertyAccessExpression(callee) && SYNC_ITERATION_METHODS.has(callee.name.text)
    ? call
    : null;
}

function classifyRenderFunction(
  candidate: RuntimeFunctionLike,
  imports: HookImports,
): Omit<RenderOwner, "hops"> | null {
  if (
    !ts.isArrowFunction(candidate) &&
    !ts.isFunctionDeclaration(candidate) &&
    !ts.isFunctionExpression(candidate)
  ) {
    return null;
  }
  const name = renderFunctionName(candidate);
  if (name === null) {
    return null;
  }
  if (/^use[A-Z0-9]/u.test(name)) {
    return { kind: "hook", name, owner: candidate, tracked: false };
  }
  return /^[A-Z]/u.test(name) && jsxElementCount(candidate) > 0
    ? componentOwner(candidate, name, imports)
    : null;
}

function componentOwner(
  candidate: RenderFunction,
  name: string,
  imports: HookImports,
): Omit<RenderOwner, "hops"> {
  const observed = observedFunctions(candidate.getSourceFile(), imports);
  return {
    kind: "component",
    name,
    owner: candidate,
    tracked: observed.nodes.has(candidate) || observed.names.has(name),
  };
}

function renderFunctionName(candidate: RenderFunction): string | null {
  if (candidate.name && ts.isIdentifier(candidate.name)) {
    return candidate.name.text;
  }
  if (ts.isFunctionDeclaration(candidate)) {
    return null;
  }
  return declaredName(candidate);
}

/** The variable an expression is assigned to, looking through parentheses and wrapper calls. */
function declaredName(expression: ts.Expression): string | null {
  const { parent } = expression;
  if (
    ts.isParenthesizedExpression(parent) ||
    (ts.isCallExpression(parent) && parent.arguments.includes(expression))
  ) {
    return declaredName(parent);
  }
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
}

function observedFunctions(sourceFile: ts.SourceFile, imports: HookImports): ObservedFunctions {
  const cached = observedFunctionsBySource.get(sourceFile);
  if (cached) {
    return cached;
  }
  const names = new Set<string>();
  const nodes = new Set<ts.Node>();
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isObserverFactoryCall(node, imports)) {
      return;
    }
    const wrapped = innermostWrappedArgument(node);
    if (!wrapped) {
      return;
    }
    if (ts.isIdentifier(wrapped)) {
      names.add(wrapped.text);
    } else if (isRuntimeFunctionLike(wrapped)) {
      nodes.add(wrapped);
    }
  });
  const observed = { names, nodes };
  observedFunctionsBySource.set(sourceFile, observed);
  return observed;
}

function isObserverFactoryCall(call: ts.CallExpression, imports: HookImports): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return imports.legendObservers.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    imports.legendReactNamespaces.has(callee.expression.text) &&
    OBSERVER_FACTORIES.has(callee.name.text)
  );
}

function innermostWrappedArgument(call: ts.CallExpression): ts.Expression | null {
  let [current] = call.arguments;
  while (current) {
    const value: ts.Expression = unwrapTransparentExpression(current);
    if (!ts.isCallExpression(value)) {
      return value;
    }
    [current] = value.arguments;
  }
  return null;
}
