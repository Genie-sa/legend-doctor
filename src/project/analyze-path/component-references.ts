import { findAncestor, identifiersNamed, visit } from "../../core/ast.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { AnalysisFile } from "../analysis-project.js";
import { pathIdentityKey } from "../../core/path-identity.js";
import ts from "typescript";

export interface ComponentTarget {
  readonly declarationName: ts.Identifier;
  readonly file: string;
  readonly name: string;
}

export interface ComponentReferences {
  /** False when a namespace import, re-export, or dynamic import can reach the component unseen. */
  readonly complete: boolean;
  readonly references: readonly ts.Identifier[];
}

/** Every value reference to a component across the project, excluding its declaration, imports, and types. */
export function componentReferences(
  context: AnalysisContext,
  target: ComponentTarget,
): ComponentReferences {
  const references: ts.Identifier[] = [];
  let complete = true;
  for (const file of context.project.files) {
    complete &&= !untrackedTransport(file, target, context);
    for (const name of componentNames(file, target, context)) {
      references.push(...valueReferences(file, name, target));
    }
  }
  return { complete, references };
}

function componentNames(
  file: AnalysisFile,
  target: ComponentTarget,
  context: AnalysisContext,
): string[] {
  const names = new Set(context.sourceIndex.componentsFor(file.originalPath));
  if (pathIdentityKey(file.originalPath) === target.file) {
    names.add(target.name);
  }
  return [...names].filter((name) => {
    const resolved = context.sourceIndex.componentDeclarationFor(file.originalPath, name);
    return (
      resolved &&
      pathIdentityKey(resolved.file) === target.file &&
      resolved.localName === target.name
    );
  });
}

function valueReferences(
  file: AnalysisFile,
  name: string,
  target: ComponentTarget,
): ts.Identifier[] {
  return identifiersNamed(file.sourceFile, name).filter(
    (reference) =>
      reference !== target.declarationName &&
      !findAncestor(reference, ts.isImportDeclaration) &&
      !findAncestor(reference, ts.isTypeNode),
  );
}

function untrackedTransport(
  file: AnalysisFile,
  target: ComponentTarget,
  context: AnalysisContext,
): boolean {
  let unknown = false;
  visit(file.sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !(
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
    ) {
      return;
    }
    const [specifier] = node.arguments;
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      unknown = true;
      return;
    }
    const module = context.sourceIndex.moduleFileFor(file.originalPath, specifier.text);
    if (module && pathIdentityKey(module) === target.file) {
      unknown = true;
    }
  });
  return (
    unknown ||
    file.sourceFile.statements.some((statement) =>
      untrackedStaticTransport(statement, { file, target }, context),
    )
  );
}

function untrackedStaticTransport(
  statement: ts.Statement,
  { file, target }: { file: AnalysisFile; target: ComponentTarget },
  context: AnalysisContext,
): boolean {
  if (
    (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
    !statement.moduleSpecifier ||
    !ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return false;
  }
  const module = context.sourceIndex.moduleFileFor(
    file.originalPath,
    statement.moduleSpecifier.text,
  );
  if (!module || pathIdentityKey(module) !== target.file) {
    return false;
  }
  if (ts.isExportDeclaration(statement)) {
    return !statement.isTypeOnly;
  }
  const clause = statement.importClause;
  return (
    !clause ||
    (!clause.isTypeOnly &&
      (clause.name !== undefined ||
        !clause.namedBindings ||
        ts.isNamespaceImport(clause.namedBindings)))
  );
}
