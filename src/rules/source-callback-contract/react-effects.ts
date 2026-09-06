import type { ReactHookImports, SourceHookDeclaration } from "./model.js";
import ts from "typescript";

const REACT_EFFECT_HOOKS = new Set(["useEffect", "useInsertionEffect", "useLayoutEffect"]);

const reactHookImportsCache = new WeakMap<ts.SourceFile, ReactHookImports>();

export function isTracedFunction(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression {
  return (
    ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
  );
}

export function callbackIsWithinReactEffect(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  owner: SourceHookDeclaration["owner"],
  hooks: ReactHookImports,
): boolean {
  for (
    let current: ts.Node | undefined = callback;
    current && current !== owner;
    current = current.parent
  ) {
    if (isTracedFunction(current) && callbackIsReactEffectArgument(current, hooks)) {
      return true;
    }
  }
  return false;
}

export function callbackIsReactEffectArgument(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  hooks: ReactHookImports,
): boolean {
  if (ts.isFunctionDeclaration(callback) || !ts.isCallExpression(callback.parent)) {
    return false;
  }
  return (
    callback.parent.arguments.includes(callback) && isImportedReactEffect(callback.parent, hooks)
  );
}

interface MutableReactHookImports {
  readonly effectNames: Set<string>;
  readonly namespaces: Set<string>;
  readonly refNames: Set<string>;
}

export function reactHookImports(sourceFile: ts.SourceFile): ReactHookImports {
  const cached = reactHookImportsCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const imports = collectReactHookImports(sourceFile);
  reactHookImportsCache.set(sourceFile, imports);
  return imports;
}

function collectReactHookImports(sourceFile: ts.SourceFile): ReactHookImports {
  const collected = {
    effectNames: new Set<string>(),
    namespaces: new Set<string>(),
    refNames: new Set<string>(),
  };
  for (const statement of sourceFile.statements) {
    if (isReactImportDeclaration(statement)) {
      addReactImportBindings(statement.importClause, collected);
    }
  }
  return collected;
}

function isReactImportDeclaration(statement: ts.Statement): statement is ts.ImportDeclaration {
  return (
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === "react"
  );
}

function addReactImportBindings(
  clause: ts.ImportClause | undefined,
  into: MutableReactHookImports,
): void {
  if (clause?.name) {
    into.namespaces.add(clause.name.text);
  }
  const bindings = clause?.namedBindings;
  if (!bindings) {
    return;
  }
  if (ts.isNamespaceImport(bindings)) {
    into.namespaces.add(bindings.name.text);
  } else if (ts.isNamedImports(bindings)) {
    addNamedReactHookImports(bindings, into);
  }
}

function addNamedReactHookImports(bindings: ts.NamedImports, into: MutableReactHookImports): void {
  for (const element of bindings.elements) {
    const imported = element.propertyName?.text ?? element.name.text;
    if (REACT_EFFECT_HOOKS.has(imported)) {
      into.effectNames.add(element.name.text);
    }
    if (imported === "useRef") {
      into.refNames.add(element.name.text);
    }
  }
}

export function isImportedReactEffect(call: ts.CallExpression, imports: ReactHookImports): boolean {
  if (ts.isIdentifier(call.expression)) {
    return imports.effectNames.has(call.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    imports.namespaces.has(call.expression.expression.text) &&
    REACT_EFFECT_HOOKS.has(call.expression.name.text)
  );
}

export function isImportedReactRef(call: ts.CallExpression, imports: ReactHookImports): boolean {
  if (ts.isIdentifier(call.expression)) {
    return imports.refNames.has(call.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    imports.namespaces.has(call.expression.expression.text) &&
    call.expression.name.text === "useRef"
  );
}
