import { isDeclarationName, isNonValueIdentifier } from "../../core/analysis-ast.js";
import type { ReachResolver } from "./synchronous-reach.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { functionEntryKey } from "../../core/execution-units.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

/** How one file refers to functions, which decides whether a function can start its own stretch. */
export interface FunctionReferences {
  /** Entries of this file's named functions; a function literal is never named. */
  readonly named: ReadonlySet<string>;
  readonly exported: ReadonlySet<string>;
  /** Functions this file uses as values, so something other than a visible call may run them. */
  readonly escaping: ReadonlySet<string>;
}

interface ReferenceSets {
  readonly escaping: Set<string>;
  readonly exported: Set<string>;
  readonly named: Set<string>;
}

/**
 * Named functions of this file, and every function (here or imported) this file uses as a value
 * rather than calling it, which lets it start a stretch of its own.
 */
export function functionReferences(
  sourceFile: ts.SourceFile,
  resolver: ReachResolver,
): FunctionReferences {
  const references: ReferenceSets = {
    escaping: new Set(),
    exported: new Set(),
    named: new Set(),
  };
  visit(sourceFile, (node) => {
    if (
      ts.isIdentifier(node) &&
      !isNonValueIdentifier(node) &&
      !ts.findAncestor(
        node,
        (ancestor) => ts.isTypeNode(ancestor) || ts.isImportDeclaration(ancestor),
      )
    ) {
      recordReference(references, node, resolver);
    }
  });
  return references;
}

function recordReference(
  references: ReferenceSets,
  identifier: ts.Identifier,
  resolver: ReachResolver,
): void {
  const binding = lexicalBinding(identifier);
  if (binding?.kind === "function") {
    recordFunctionReference(references, identifier, binding.declaration);
    return;
  }
  if (binding?.kind !== "import" || isDirectCallee(identifier) || isExportReference(identifier)) {
    return;
  }
  const imported = resolver.importedCallee(identifier.getSourceFile(), binding);
  if (imported.kind === "function") {
    references.escaping.add(functionEntryKey(imported.declaration));
  }
}

function recordFunctionReference(
  references: ReferenceSets,
  identifier: ts.Identifier,
  declaration: RuntimeFunctionLike,
): void {
  const entry = functionEntryKey(declaration);
  if (isDeclarationName(identifier)) {
    references.named.add(entry);
    if (isExported(declaration)) {
      references.exported.add(entry);
    }
    return;
  }
  if (isExportReference(identifier)) {
    references.exported.add(entry);
  } else if (!isDirectCallee(identifier)) {
    references.escaping.add(entry);
  }
}

function isExportReference(identifier: ts.Identifier): boolean {
  return ts.isExportSpecifier(identifier.parent) || ts.isExportAssignment(identifier.parent);
}

function isExported(declaration: RuntimeFunctionLike): boolean {
  const statement = ts.isFunctionDeclaration(declaration)
    ? declaration
    : declaringStatement(declaration);
  return (
    statement !== null &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword ||
        modifier.kind === ts.SyntaxKind.DefaultKeyword,
    )
  );
}

function declaringStatement(value: ts.Node): ts.VariableStatement | null {
  let current = value;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isCallExpression(current.parent)
  ) {
    current = current.parent;
  }
  const list = ts.isVariableDeclaration(current.parent) ? current.parent.parent : null;
  return list && ts.isVariableStatement(list.parent) ? list.parent : null;
}

function isDirectCallee(identifier: ts.Identifier): boolean {
  let current: ts.Node = identifier;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isAsExpression(current.parent)
  ) {
    current = current.parent;
  }
  return ts.isCallExpression(current.parent) && current.parent.expression === current;
}
