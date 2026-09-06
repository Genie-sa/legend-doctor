import {
  collectReactComponentWrappers,
  isReactComponentWrapper,
} from "../../core/react-component-wrappers.js";
import type { ChildComponentSource } from "../../rules/child-contract/model.js";
import type { ReactComponentWrappers } from "../../core/react-component-wrappers.js";
import type { SourceHookDeclaration } from "../../rules/source-callback-contract/model.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

const HOOK_BINDING_PATTERN = /^use[A-Z0-9]/u;

interface ComponentDeclarationQuery {
  deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  file: string;
  localName: string;
  sourceFile: ts.SourceFile;
}

export function importedHookBindings(sourceFile: ts.SourceFile): readonly string[] {
  return sourceFile.statements.flatMap((statement) => statementHookBindings(statement));
}

function statementHookBindings(statement: ts.Statement): string[] {
  if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
    return [];
  }
  const clause = statement.importClause;
  const defaultBinding =
    clause?.name && HOOK_BINDING_PATTERN.test(clause.name.text) ? [clause.name.text] : [];
  return [...defaultBinding, ...namedHookBindings(clause?.namedBindings)];
}

function namedHookBindings(namedBindings: ts.NamedImportBindings | undefined): string[] {
  if (!namedBindings || !ts.isNamedImports(namedBindings)) {
    return [];
  }
  return namedBindings.elements
    .filter((element) => !element.isTypeOnly && HOOK_BINDING_PATTERN.test(element.name.text))
    .map((element) => element.name.text);
}

export function findHookDeclaration(
  sourceFile: ts.SourceFile,
  localName: string,
): SourceHookDeclaration["owner"] | null {
  for (const statement of sourceFile.statements) {
    const owner = statementHookOwner(statement, localName);
    if (owner) {
      return owner;
    }
  }
  return null;
}

function statementHookOwner(
  statement: ts.Statement,
  localName: string,
): SourceHookDeclaration["owner"] | null {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name?.text === localName && statement.body ? statement : null;
  }
  if (!ts.isVariableStatement(statement)) {
    return null;
  }
  for (const declaration of statement.declarationList.declarations) {
    const owner = declarationHookOwner(declaration, localName);
    if (owner) {
      return owner;
    }
  }
  return null;
}

function declarationHookOwner(
  declaration: ts.VariableDeclaration,
  localName: string,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== localName ||
    !declaration.initializer
  ) {
    return null;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? initializer
    : null;
}

export function findComponentDeclaration(
  query: ComponentDeclarationQuery,
): ChildComponentSource | null {
  const reactWrappers = collectReactComponentWrappers(query.sourceFile);
  for (const statement of query.sourceFile.statements) {
    const source = statementComponentSource(statement, query, reactWrappers);
    if (source) {
      return source;
    }
  }
  return null;
}

function statementComponentSource(
  statement: ts.Statement,
  query: ComponentDeclarationQuery,
  reactWrappers: ReactComponentWrappers,
): ChildComponentSource | null {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name?.text === query.localName && statement.body
      ? {
          body: statement.body,
          deferredCallbackHooks: query.deferredCallbackHooks,
          file: query.file,
          owner: statement,
          reactWrapped: false,
        }
      : null;
  }
  if (!ts.isVariableStatement(statement)) {
    return null;
  }
  for (const declaration of statement.declarationList.declarations) {
    const source = declarationComponentSource(declaration, query, reactWrappers);
    if (source) {
      return source;
    }
  }
  return null;
}

function declarationComponentSource(
  declaration: ts.VariableDeclaration,
  query: ComponentDeclarationQuery,
  reactWrappers: ReactComponentWrappers,
): ChildComponentSource | null {
  if (
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== query.localName ||
    !declaration.initializer
  ) {
    return null;
  }
  const unwrapped = unwrapTransparentExpression(declaration.initializer);
  const wrapped = wrapperRenderFunction(unwrapped, reactWrappers);
  const initializer = wrapped ?? unwrapped;
  if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) {
    return null;
  }
  return {
    body: initializer.body,
    deferredCallbackHooks: query.deferredCallbackHooks,
    file: query.file,
    owner: initializer,
    reactWrapped: wrapped !== null,
  };
}

function wrapperRenderFunction(
  initializer: ts.Expression,
  reactWrappers: ReactComponentWrappers,
): ts.Expression | null {
  if (
    !ts.isCallExpression(initializer) ||
    !isReactComponentWrapper(initializer.expression, reactWrappers) ||
    initializer.arguments.length === 0
  ) {
    return null;
  }
  const inner = unwrapTransparentExpression(initializer.arguments[0]!);
  return wrapperRenderFunction(inner, reactWrappers) ?? inner;
}
