import type { SourceIndexState } from "./model.js";
import { primitiveDeclarationPaths } from "../../rules/observable-reads/primitive-paths.js";
import { resolvedFor } from "./symbol-resolution.js";
import ts from "typescript";

export function observablePrimitivePathsFor(
  state: SourceIndexState,
  file: string,
): ReadonlySet<string> {
  return observableDeclarationPathsFor(state, file, (declaration) =>
    primitiveDeclarationPaths(declaration, forwardsGeneric(state, declaration)),
  );
}

interface ImportedObservableDeclaration {
  readonly declaration: ts.VariableDeclaration;
  readonly declaringFile: string;
  readonly name: string;
}

/** The sole exported declaration of each observable the file imports, keyed by its local name. */
export function observableDeclarationsFor(
  state: SourceIndexState,
  file: string,
): ReadonlyMap<string, ts.VariableDeclaration> {
  const declarations = new Map<string, ts.VariableDeclaration>();
  for (const { declaration, name } of importedObservableDeclarations(state, file)) {
    declarations.set(name, declaration);
  }
  return declarations;
}

/** Paths that `pathsOf` proves for each observable the file imports, keyed by its local name. */
export function observableDeclarationPathsFor(
  state: SourceIndexState,
  file: string,
  pathsOf: (declaration: ts.VariableDeclaration, declaringFile: string) => ReadonlySet<string>,
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const { declaration, declaringFile, name } of importedObservableDeclarations(state, file)) {
    for (const suffix of pathsOf(declaration, declaringFile)) {
      paths.add(suffix ? `${name}.${suffix}` : name);
    }
  }
  return paths;
}

function* importedObservableDeclarations(
  state: SourceIndexState,
  file: string,
): Iterable<ImportedObservableDeclaration> {
  for (const [name, symbol] of resolvedFor(state, file, "observable")) {
    const source = state.sourceFiles.get(symbol.file);
    const declaration = source ? exportedDeclaration(source, symbol.localName) : null;
    if (declaration) {
      yield { declaration, declaringFile: symbol.file, name };
    }
  }
}

export function exportedDeclaration(
  source: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | null {
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
  return declarations.length === 1 ? declarations[0]! : null;
}

function forwardsGeneric(state: SourceIndexState, declaration: ts.VariableDeclaration): boolean {
  const call = declaration.initializer;
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
    return false;
  }
  const symbol = resolvedFor(state, declaration.getSourceFile().fileName, "observable-factory").get(
    call.expression.text,
  );
  const source = symbol && state.sourceFiles.get(symbol.file);
  const factory = source?.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === symbol?.localName,
  );
  if (
    !factory ||
    !ts.isFunctionDeclaration(factory) ||
    !factory.type ||
    !ts.isTypeReferenceNode(factory.type)
  ) {
    return false;
  }
  return forwardedReturn(factory, factory.type);
}

function forwardedReturn(factory: ts.FunctionDeclaration, result: ts.TypeReferenceNode): boolean {
  const [parameter] = factory.typeParameters ?? [];
  const [argument] = result.typeArguments ?? [];
  return (
    parameter !== undefined &&
    argument !== undefined &&
    ts.isTypeReferenceNode(argument) &&
    argument.typeName.getText() === parameter.name.text &&
    factory
      .getSourceFile()
      .statements.some(
        (node) =>
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === "@legendapp/state" &&
          node.importClause?.namedBindings !== undefined &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some(
            (item) =>
              (item.propertyName?.text ?? item.name.text) === "Observable" &&
              item.name.text === result.typeName.getText(),
          ),
      )
  );
}
