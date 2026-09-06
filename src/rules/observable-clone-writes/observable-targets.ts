import {
  ROOT_PATH,
  arrayLiteralPaths,
  observableInitialValue,
} from "../../core/observable-initial-value.js";
import {
  staticPathHasBinding,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { SyncedImports } from "../../core/observable-initial-value.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";
import { uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";

/** What a write rule knows about where each observable array starts. */
export interface ArrayOriginScan {
  readonly importedObservableArrayPaths: ReadonlySet<string>;
  readonly imports: SyncedImports;
  readonly sourceFile: ts.SourceFile;
}

export function observableSetTarget(
  call: ts.CallExpression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  if (
    call.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "set"
  ) {
    return null;
  }
  const target = unwrapTransparentExpression(call.expression.expression);
  return staticPathHasBinding(target, observableBindings) ? target : null;
}

/**
 * Whether the observable path starts as an array literal: in the factory call that declares it in
 * this file, or in the declaring module when the root is imported.
 */
export function observableTargetStartsAsArray(
  target: ts.Expression,
  write: ts.CallExpression,
  scan: ArrayOriginScan,
): boolean {
  const [root, ...properties] = staticPropertyPath(target) ?? [];
  if (root === undefined) {
    return false;
  }
  const declaration =
    lexicalVariableDeclaration(write, root) ?? uniqueVariableDeclaration(scan.sourceFile, root);
  if (!declaration) {
    return scan.importedObservableArrayPaths.has([root, ...properties].join("."));
  }
  const factory = declaration.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  const initial =
    factory && ts.isCallExpression(factory) ? observableInitialValue(factory, scan.imports) : null;
  return initial !== null && arrayLiteralPaths(initial).has(properties.join(".") || ROOT_PATH);
}

function lexicalVariableDeclaration(node: ts.Node, name: string): ts.VariableDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isRuntimeFunctionLike(current) && current.body) {
      const declaration = uniqueVariableDeclaration(current.body, name);
      if (declaration) {
        return declaration;
      }
    }
    current = current.parent;
  }
  return null;
}
