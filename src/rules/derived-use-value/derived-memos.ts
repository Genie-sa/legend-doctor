import {
  bindingDeclarationCount,
  isNonValueIdentifier,
  localBindingNames,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import {
  isUseValueCall,
  isValueReferenceTo,
  provenObservablePath,
} from "../observable-reads/observable-paths.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedHookCall } from "../../core/imports.js";
import ts from "typescript";

export type MemoCallback = ts.ArrowFunction | ts.FunctionExpression;

export interface ObservableMemoInput {
  readonly declaration: ts.VariableDeclaration;
  readonly localName: string;
  readonly observable: ts.Expression;
}

export interface DerivedMemo {
  readonly call: ts.CallExpression;
  readonly callback: MemoCallback;
  readonly derivedName: string;
  readonly inputs: readonly ObservableMemoInput[];
  readonly owner: RuntimeFunctionLike;
  /** Every value the callback can return; a bare `return` or fall-through yields undefined. */
  readonly results: readonly ts.Expression[];
}

export interface DerivedMemoScan {
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
}

interface MemoCandidate {
  readonly call: ts.CallExpression;
  readonly callback: MemoCallback;
  readonly dependencies: ts.ArrayLiteralExpression;
  readonly derivedName: string;
  readonly owner: RuntimeFunctionLike;
}

const USE_MEMO_ARGUMENTS = 2;

/**
 * A `const derived = useMemo(callback, deps)` whose every dependency is a `useValue` subscription
 * read nowhere else, so the memo can become one computed observable.
 */
export function derivedMemoDeclaration(
  declaration: ts.VariableDeclaration,
  scan: DerivedMemoScan,
): DerivedMemo | null {
  const candidate = memoCandidate(declaration, scan.imports);
  const inputs = candidate && observableInputs(candidate, scan);
  if (
    !candidate ||
    !inputs ||
    !inputsConfinedToCallback(inputs, candidate) ||
    !callbackStaysInsideComputed(candidate, inputs, scan.observableBindings)
  ) {
    return null;
  }
  const results = resultExpressions(candidate.callback);
  return results ? { ...candidate, inputs, results } : null;
}

function memoCandidate(
  declaration: ts.VariableDeclaration,
  imports: HookImports,
): MemoCandidate | null {
  const call = useMemoInitializer(declaration, imports);
  if (!call || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  const callback = unwrapTransparentExpression(call.arguments[0]!);
  const dependencies = unwrapTransparentExpression(call.arguments[1]!);
  const owner = findAncestor(call, isRuntimeFunctionLike);
  if (
    !isSynchronousThunk(callback) ||
    !ts.isArrayLiteralExpression(dependencies) ||
    dependencies.elements.length === 0 ||
    !owner?.body ||
    findAncestor(declaration, isRuntimeFunctionLike) !== owner ||
    bindingDeclarationCount(owner, declaration.name.text) !== 1
  ) {
    return null;
  }
  return { call, callback, dependencies, derivedName: declaration.name.text, owner };
}

function useMemoInitializer(
  declaration: ts.VariableDeclaration,
  imports: HookImports,
): ts.CallExpression | null {
  if (!declaration.initializer || !isConst(declaration)) {
    return null;
  }
  const call = unwrapTransparentExpression(declaration.initializer);
  const isUseMemo =
    ts.isCallExpression(call) &&
    call.arguments.length === USE_MEMO_ARGUMENTS &&
    isImportedHookCall({
      call,
      canonicalName: "useMemo",
      localNames: imports.useMemo,
      namespaceNames: imports.reactNamespaces,
    });
  return isUseMemo ? call : null;
}

function isSynchronousThunk(node: ts.Expression): node is MemoCallback {
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parameters.length === 0 &&
    !node.asteriskToken &&
    !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function isConst(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function observableInputs(
  candidate: MemoCandidate,
  scan: DerivedMemoScan,
): readonly ObservableMemoInput[] | null {
  const inputs = candidate.dependencies.elements.map((element) =>
    dependencyInput(element, candidate.owner, scan),
  );
  const resolved = inputs.filter((input) => input !== null);
  const distinct = new Set(resolved.map((input) => input.localName)).size === resolved.length;
  return resolved.length === inputs.length && distinct ? resolved : null;
}

function dependencyInput(
  element: ts.Expression,
  owner: RuntimeFunctionLike,
  scan: DerivedMemoScan,
): ObservableMemoInput | null {
  const dependency = unwrapTransparentExpression(element);
  if (!ts.isIdentifier(dependency) || bindingDeclarationCount(owner, dependency.text) !== 1) {
    return null;
  }
  let input: ObservableMemoInput | null = null;
  visit(owner.body, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === dependency.text
    ) {
      input = useValueDeclarationInput(node, owner, scan);
    }
  });
  return input;
}

function useValueDeclarationInput(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
  scan: DerivedMemoScan,
): ObservableMemoInput | null {
  const call = declaration.initializer && unwrapTransparentExpression(declaration.initializer);
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !ts.isIdentifier(declaration.name) ||
    !isConst(declaration) ||
    !isUseValueCall(call, scan.imports) ||
    findAncestor(declaration, isRuntimeFunctionLike) !== owner
  ) {
    return null;
  }
  const observable = provenObservablePath(call.arguments[0]!, scan.observableBindings);
  return observable ? { declaration, localName: declaration.name.text, observable } : null;
}

function inputsConfinedToCallback(
  inputs: readonly ObservableMemoInput[],
  candidate: MemoCandidate,
): boolean {
  return inputs.every((input) => {
    let confined = true;
    visit(candidate.owner.body, (node) => {
      if (
        confined &&
        isValueReferenceTo(node, input.localName, input.declaration.name) &&
        !nodeWithin(node, candidate.callback) &&
        !nodeWithin(node, candidate.dependencies)
      ) {
        confined = false;
      }
    });
    return confined;
  });
}

/**
 * The callback may read only its observable inputs and module-level names: any other owner-local
 * binding, observable root, `this`, ref, or suspension would change meaning inside a computed.
 */
function callbackStaysInsideComputed(
  candidate: MemoCandidate,
  inputs: readonly ObservableMemoInput[],
  observableBindings: ReadonlySet<string>,
): boolean {
  const inputNames = new Set(inputs.map((input) => input.localName));
  const ownerLocals = localBindingNames(candidate.owner, candidate.callback);
  let stays = true;
  visit(candidate.callback.body, (node) => {
    if (!stays) {
      return;
    }
    if (ts.isIdentifier(node) && !isNonValueIdentifier(node) && !inputNames.has(node.text)) {
      stays = !ownerLocals.has(node.text) && !observableBindings.has(node.text);
      return;
    }
    stays = !escapesComputedContext(node);
  });
  return stays;
}

function escapesComputedContext(node: ts.Node): boolean {
  return (
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "current")
  );
}

function resultExpressions(callback: MemoCallback): readonly ts.Expression[] | null {
  if (!ts.isBlock(callback.body)) {
    return [callback.body];
  }
  const results: ts.Expression[] = [];
  let returns = 0;
  const collect = (node: ts.Node): void => {
    if (isRuntimeFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      returns += 1;
      if (node.expression) {
        results.push(node.expression);
      }
    }
    node.forEachChild(collect);
  };
  callback.body.forEachChild(collect);
  return returns > 0 ? results : null;
}
