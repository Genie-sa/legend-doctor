import { visit, visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingDeclarationCount } from "../../core/analysis-ast.js";
import ts from "typescript";

const uniqueVariableDeclarationsByBoundary = new WeakMap<
  ts.Node,
  ReadonlyMap<string, ts.VariableDeclaration | null>
>();

const localFunctionBindingsByOwner = new WeakMap<
  RuntimeFunctionLike,
  ReadonlyMap<string, ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression>
>();

export function sourceHasRuntimeBinding(sourceFile: ts.SourceFile, name: string): boolean {
  let found = false;
  visit(sourceFile, (node) => {
    if (!found && nodeBindsRuntimeName(node, name)) {
      found = true;
    }
  });
  return found;
}

/** The node introduces a runtime binding for the name, shadowing any global of that name. */
function nodeBindsRuntimeName(node: ts.Node, name: string): boolean {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
    return bindingContainsName(node.name, name);
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return node.name?.text === name;
  }
  if (ts.isCatchClause(node)) {
    return (
      node.variableDeclaration !== undefined &&
      bindingContainsName(node.variableDeclaration.name, name)
    );
  }
  return (
    (ts.isImportClause(node) && node.name?.text === name) ||
    (ts.isImportSpecifier(node) && node.name.text === name) ||
    (ts.isNamespaceImport(node) && node.name.text === name)
  );
}

export function isUnshadowedMathCall(
  owner: RuntimeFunctionLike,
  call: ts.CallExpression,
  methods: ReadonlySet<string>,
): boolean {
  const callee = call.expression;
  return (
    !sourceHasRuntimeBinding(owner.getSourceFile(), "Math") &&
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Math" &&
    methods.has(callee.name.text)
  );
}

export function expressionDependsOnBinding(
  expression: ts.Expression,
  binding: ts.BindingName,
  boundary: ts.Node,
): boolean {
  let found = false;
  visit(expression, (node) => {
    if (!ts.isIdentifier(node)) {
      return;
    }
    if (bindingContainsName(binding, node.text)) {
      found = true;
      return;
    }
    const declaration = uniqueVariableDeclaration(boundary, node.text);
    if (
      declaration?.initializer &&
      expressionDependsOnBinding(declaration.initializer, binding, declaration)
    ) {
      found = true;
    }
  });
  return found;
}

export function bindingContainsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) {
    return binding.text === name;
  }
  return binding.elements.some(
    (element) => ts.isBindingElement(element) && bindingContainsName(element.name, name),
  );
}

export function uniqueVariableDeclaration(
  boundary: ts.Node,
  name: string,
): ts.VariableDeclaration | null {
  let declarations = uniqueVariableDeclarationsByBoundary.get(boundary);
  if (!declarations) {
    const collected = new Map<string, ts.VariableDeclaration | null>();
    visitSkippingNestedRuntimeFunctions(boundary, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
        return;
      }
      collected.set(node.name.text, collected.has(node.name.text) ? null : node);
    });
    declarations = collected;
    uniqueVariableDeclarationsByBoundary.set(boundary, declarations);
  }
  return declarations.get(name) ?? null;
}

export function localFunctionBinding(
  owner: RuntimeFunctionLike,
  name: string,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  if (!owner.body || bindingDeclarationCount(owner, name) !== 1) {
    return null;
  }
  let bindings = localFunctionBindingsByOwner.get(owner);
  if (!bindings) {
    const collected = new Map<
      string,
      ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression
    >();
    visit(owner.body, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        collected.set(node.name.text, node);
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        collected.set(node.name.text, node.initializer);
      }
    });
    bindings = collected;
    localFunctionBindingsByOwner.set(owner, bindings);
  }
  return bindings.get(name) ?? null;
}
