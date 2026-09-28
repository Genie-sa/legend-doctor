import type { InPlaceMemoKeyScan, RawValueBinding } from "./model.js";
import {
  bindingDeclarationCount,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  directObservableReadPath,
  isUseValueCall,
  provenObservablePath,
} from "../observable-reads/observable-paths.js";
import { findAncestor, isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

/**
 * `const value = useValue(source$)` or `useValue(() => source$.get())`. The hook rerenders on an
 * in-place write below the source because Legend reports the changed node's own value, but it
 * returns the same reference it returned before the write.
 */
export function rawValueBinding(
  declaration: ts.VariableDeclaration,
  scan: InPlaceMemoKeyScan,
): RawValueBinding | null {
  const call = declaration.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !ts.isIdentifier(declaration.name) ||
    !isConstDeclaration(declaration) ||
    !isUseValueCall(call, scan.imports)
  ) {
    return null;
  }
  const source = observedSource(call.arguments[0]!, scan.observableBindings);
  const sourcePath = source ? staticPropertyPath(source) : null;
  const owner = findAncestor(declaration, isRuntimeFunctionLike);
  const { name } = declaration;
  if (!source || !sourcePath || !owner || bindingDeclarationCount(owner, name.text) !== 1) {
    return null;
  }
  return {
    call,
    name: name.text,
    owner,
    sourcePath,
    sourceText: source.getText(scan.sourceFile),
  };
}

function observedSource(
  argument: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ts.Expression | null {
  const selector = unwrapTransparentExpression(argument);
  if (ts.isArrowFunction(selector) && !ts.isBlock(selector.body)) {
    return selector.parameters.length === 0
      ? directObservableReadPath(selector.body, observableBindings)
      : null;
  }
  return provenObservablePath(selector, observableBindings);
}

function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
}
