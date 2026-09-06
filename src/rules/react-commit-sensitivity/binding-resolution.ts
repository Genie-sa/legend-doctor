import { bindingContainsName, uniqueVariableDeclaration } from "../state-proofs/binding-lookup.js";
import {
  collectBindingNames,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

type ReactHookImportName =
  | "startTransition"
  | "useCallback"
  | "useEffect"
  | "useInsertionEffect"
  | "useLayoutEffect"
  | "useRef"
  | "useTransition";

export function constInitializer(owner: RuntimeFunctionLike, name: string): ts.Expression | null {
  const declaration = uniqueVariableDeclaration(owner, name);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return unwrapTransparentExpression(declaration.initializer);
}

export function isSoleReference(owner: RuntimeFunctionLike, value: ts.Identifier): boolean {
  let references = 0;
  let unique = true;
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === value.text &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references += 1;
      if (node !== value) {
        unique = false;
      }
    }
  });
  return unique && references === 1;
}

function reactCallBinding(
  expression: ts.LeftHandSideExpression,
  imports: HookImports,
  hook: ReactHookImportName,
): string | null {
  if (ts.isIdentifier(expression) && imports[hook].has(expression.text)) {
    return expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.reactNamespaces.has(expression.expression.text) &&
    expression.name.text === hook
  ) {
    return expression.expression.text;
  }
  return null;
}

export function isImportedReactCall(
  call: ts.CallExpression,
  imports: HookImports,
  hook: ReactHookImportName,
): boolean {
  const binding = reactCallBinding(call.expression, imports, hook);
  return binding !== null && bindingIsUnshadowed(call, binding);
}

export function bindingIsUnshadowed(node: ts.Node, name: string): boolean {
  const owner = findAncestor(node, isRuntimeFunctionLike);
  return owner === null || !hasLexicalBindingAt(node, owner, name);
}

const functionScopedBindingsByOwner = new WeakMap<RuntimeFunctionLike, ReadonlySet<string>>();

function functionScopedBindings(owner: RuntimeFunctionLike, body: ts.Node): ReadonlySet<string> {
  const cached = functionScopedBindingsByOwner.get(owner);
  if (cached) {
    return cached;
  }
  const collected = new Set<string>();
  visitSkippingNestedRuntimeFunctions(body, (current) => {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isVariableDeclarationList(current.parent) &&
      (current.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
    ) {
      collectBindingNames(current.name, collected);
    }
  });
  functionScopedBindingsByOwner.set(owner, collected);
  return collected;
}

function enclosingScopeDeclares(node: ts.Node, owner: RuntimeFunctionLike, name: string): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== owner;
    current = current.parent
  ) {
    if (scopeDirectlyDeclares(current, name)) {
      return true;
    }
  }
  return false;
}

function hasLexicalBindingAt(node: ts.Node, owner: RuntimeFunctionLike, name: string): boolean {
  if (owner.parameters.some((parameter) => bindingContainsName(parameter.name, name))) {
    return true;
  }
  if (!owner.body) {
    return false;
  }
  return (
    functionScopedBindings(owner, owner.body).has(name) || enclosingScopeDeclares(node, owner, name)
  );
}

function scopeDirectlyDeclares(scope: ts.Node, name: string): boolean {
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    return bindingContainsName(scope.variableDeclaration.name, name);
  }
  if (
    ts.isForStatement(scope) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((declaration) =>
      bindingContainsName(declaration.name, name),
    );
  }
  if (
    (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((declaration) =>
      bindingContainsName(declaration.name, name),
    );
  }
  if (!ts.isBlock(scope)) {
    return false;
  }
  return scope.statements.some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) =>
        bindingContainsName(declaration.name, name),
      );
    }
    return (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    );
  });
}
