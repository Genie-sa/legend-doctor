import { collectBindingNames, unwrapTransparentExpression } from "./analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "./ast.js";
import type { RuntimeFunctionLike } from "./ast.js";
import ts from "typescript";

/** What a free identifier names, resolved through its enclosing lexical scopes. */
export type LexicalBinding =
  /** A function whose body is in view: a declaration, or a `const` bound to a function. */
  | { readonly kind: "function"; readonly declaration: RuntimeFunctionLike }
  | { readonly kind: "import"; readonly importedName: string; readonly moduleSpecifier: string }
  /** A `declare`d name, which has no body in the program's source. */
  | { readonly kind: "ambient" }
  /** A parameter, a destructured or reassignable variable, or a non-function `const`. */
  | { readonly kind: "value"; readonly declaration: ts.Node };

const bindingsByScope = new WeakMap<ts.Node, ReadonlyMap<string, LexicalBinding>>();

/** Null when no enclosing scope declares the name, so it is a global. */
export function lexicalBinding(identifier: ts.Identifier): LexicalBinding | null {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    const binding = scopeBindings(scope).get(identifier.text);
    if (binding) {
      return binding;
    }
  }
  return null;
}

/** What a module-scope name is bound to, as an export of that module would resolve it. */
export function moduleBinding(sourceFile: ts.SourceFile, name: string): LexicalBinding | null {
  return scopeBindings(sourceFile).get(name) ?? null;
}

function scopeBindings(scope: ts.Node): ReadonlyMap<string, LexicalBinding> {
  const cached = bindingsByScope.get(scope);
  if (cached) {
    return cached;
  }
  const bindings = new Map<string, LexicalBinding>();
  if (isRuntimeFunctionLike(scope)) {
    addFunctionScopeBindings(scope, bindings);
  } else if (hasStatements(scope)) {
    addStatementBindings(scope.statements, bindings);
  } else {
    addHeaderBindings(scope, bindings);
  }
  bindingsByScope.set(scope, bindings);
  return bindings;
}

function hasStatements(
  scope: ts.Node,
): scope is ts.Block | ts.CaseClause | ts.DefaultClause | ts.ModuleBlock | ts.SourceFile {
  return (
    ts.isSourceFile(scope) ||
    ts.isBlock(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
  );
}

function addFunctionScopeBindings(
  scope: RuntimeFunctionLike,
  bindings: Map<string, LexicalBinding>,
): void {
  visit(scope.body, (node) => {
    if (
      ts.isVariableDeclarationList(node) &&
      !(node.flags & ts.NodeFlags.BlockScoped) &&
      findAncestor(node, isRuntimeFunctionLike) === scope
    ) {
      for (const declaration of node.declarations) {
        addValueNames(declaration.name, declaration, bindings);
      }
    }
  });
  for (const parameter of scope.parameters) {
    addValueNames(parameter.name, parameter, bindings);
  }
  if (ts.isFunctionExpression(scope) && scope.name) {
    bindings.set(scope.name.text, { declaration: scope, kind: "function" });
  }
}

function addStatementBindings(
  statements: ts.NodeArray<ts.Statement>,
  bindings: Map<string, LexicalBinding>,
): void {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      bindings.set(
        statement.name.text,
        statement.body && !isAmbient(statement)
          ? { declaration: statement, kind: "function" }
          : { kind: "ambient" },
      );
    } else if (ts.isVariableStatement(statement)) {
      addVariableBindings(statement, bindings);
    } else if (ts.isImportDeclaration(statement)) {
      addImportBindings(statement, bindings);
    } else if (
      (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      bindings.set(
        statement.name.text,
        isAmbient(statement) ? { kind: "ambient" } : { declaration: statement, kind: "value" },
      );
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      bindings.set(statement.name.text, { kind: "ambient" });
    }
  }
}

function addVariableBindings(
  statement: ts.VariableStatement,
  bindings: Map<string, LexicalBinding>,
): void {
  const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
  for (const declaration of statement.declarationList.declarations) {
    const body =
      constant && declaration.initializer ? boundFunction(declaration.initializer) : null;
    if (isAmbient(statement)) {
      addAmbientNames(declaration.name, bindings);
    } else if (body && ts.isIdentifier(declaration.name)) {
      bindings.set(declaration.name.text, { declaration: body, kind: "function" });
    } else {
      addValueNames(declaration.name, declaration, bindings);
    }
  }
}

/** The function a `const` calls when invoked: a function literal, or one memoized by `useCallback`. */
function boundFunction(initializer: ts.Expression): RuntimeFunctionLike | null {
  const value = unwrapTransparentExpression(initializer);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  if (!ts.isCallExpression(value) || !isUseCallback(value.expression)) {
    return null;
  }
  const [callback] = value.arguments;
  const inner = callback ? unwrapTransparentExpression(callback) : null;
  return inner && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) ? inner : null;
}

function isUseCallback(callee: ts.Expression): boolean {
  return (
    (ts.isIdentifier(callee) && callee.text === "useCallback") ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "useCallback")
  );
}

function addImportBindings(
  statement: ts.ImportDeclaration,
  bindings: Map<string, LexicalBinding>,
): void {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return;
  }
  const moduleSpecifier = statement.moduleSpecifier.text;
  if (clause.name) {
    bindings.set(clause.name.text, { importedName: "default", kind: "import", moduleSpecifier });
  }
  if (clause.namedBindings) {
    addNamedImportBindings(clause.namedBindings, moduleSpecifier, bindings);
  }
}

function addNamedImportBindings(
  named: ts.NamedImportBindings,
  moduleSpecifier: string,
  bindings: Map<string, LexicalBinding>,
): void {
  if (ts.isNamespaceImport(named)) {
    bindings.set(named.name.text, { importedName: "*", kind: "import", moduleSpecifier });
    return;
  }
  for (const element of named.elements) {
    if (!element.isTypeOnly) {
      const importedName = (element.propertyName ?? element.name).text;
      bindings.set(element.name.text, { importedName, kind: "import", moduleSpecifier });
    }
  }
}

/** Names a loop header, catch clause, or named class expression introduces for its own body. */
function addHeaderBindings(scope: ts.Node, bindings: Map<string, LexicalBinding>): void {
  if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    for (const declaration of scope.initializer.declarations) {
      addValueNames(declaration.name, declaration, bindings);
    }
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    addValueNames(scope.variableDeclaration.name, scope.variableDeclaration, bindings);
  } else if (ts.isClassExpression(scope) && scope.name) {
    bindings.set(scope.name.text, { declaration: scope, kind: "value" });
  }
}

function addValueNames(
  name: ts.BindingName,
  declaration: ts.Node,
  bindings: Map<string, LexicalBinding>,
): void {
  const names = new Set<string>();
  collectBindingNames(name, names);
  for (const text of names) {
    bindings.set(text, { declaration, kind: "value" });
  }
}

function addAmbientNames(name: ts.BindingName, bindings: Map<string, LexicalBinding>): void {
  const names = new Set<string>();
  collectBindingNames(name, names);
  for (const text of names) {
    bindings.set(text, { kind: "ambient" });
  }
}

function isAmbient(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
    )
  );
}
