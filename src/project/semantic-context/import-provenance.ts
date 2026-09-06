import type { ImportProvenance } from "./model.js";
import ts from "typescript";

export function importProvenanceOfSymbol(symbol: ts.Symbol): ImportProvenance | undefined {
  for (const declaration of symbol.declarations ?? []) {
    const provenance = importProvenanceOfDeclaration(declaration);
    if (provenance) {
      return provenance;
    }
  }
  return undefined;
}

/**
 * The local half of an import binding, before the owning statement is confirmed to be a real
 * `import` declaration rather than a JSDoc `@import` tag.
 */
interface ImportBinding {
  readonly importedName: string;
  readonly isTypeOnly: boolean;
  readonly kind: "default" | "named" | "namespace";
  readonly localName: string;
  readonly owner: ts.Node;
}

function importProvenanceOfDeclaration(declaration: ts.Declaration): ImportProvenance | undefined {
  if (ts.isImportEqualsDeclaration(declaration)) {
    return importEqualsProvenance(declaration);
  }
  const binding = importBindingOfDeclaration(declaration);
  if (!binding || !ts.isImportDeclaration(binding.owner)) {
    return undefined;
  }
  const moduleSpecifier = stringModuleSpecifier(binding.owner.moduleSpecifier);
  if (!moduleSpecifier) {
    return undefined;
  }
  const { importedName, isTypeOnly, kind, localName } = binding;
  return {
    accessPath: [],
    declaration: binding.owner,
    importedName,
    isTypeOnly,
    kind,
    localName,
    moduleSpecifier,
  };
}

function importBindingOfDeclaration(declaration: ts.Declaration): ImportBinding | undefined {
  if (ts.isImportSpecifier(declaration)) {
    return {
      importedName: declaration.propertyName?.text ?? declaration.name.text,
      isTypeOnly: declaration.isTypeOnly || declaration.parent.parent.isTypeOnly,
      kind: "named",
      localName: declaration.name.text,
      owner: declaration.parent.parent.parent,
    };
  }
  if (ts.isNamespaceImport(declaration)) {
    return {
      importedName: "*",
      isTypeOnly: declaration.parent.isTypeOnly,
      kind: "namespace",
      localName: declaration.name.text,
      owner: declaration.parent.parent,
    };
  }
  if (ts.isImportClause(declaration) && declaration.name) {
    return {
      importedName: "default",
      isTypeOnly: declaration.isTypeOnly,
      kind: "default",
      localName: declaration.name.text,
      owner: declaration.parent,
    };
  }
  return undefined;
}

function importEqualsProvenance(
  declaration: ts.ImportEqualsDeclaration,
): ImportProvenance | undefined {
  const { moduleReference } = declaration;
  if (
    !ts.isExternalModuleReference(moduleReference) ||
    !ts.isStringLiteralLike(moduleReference.expression)
  ) {
    return undefined;
  }
  return {
    accessPath: [],
    declaration,
    importedName: "export=",
    isTypeOnly: declaration.isTypeOnly,
    kind: "import-equals",
    localName: declaration.name.text,
    moduleSpecifier: moduleReference.expression.text,
  };
}

export function staticAccessFromNamespace(
  node: ts.Node,
): { readonly path: readonly string[]; readonly root: ts.Identifier } | undefined {
  const access = enclosingPropertyAccess(node);
  if (!access) {
    return undefined;
  }
  const accessPath: string[] = [];
  let root: ts.Expression = access;
  while (ts.isPropertyAccessExpression(root)) {
    accessPath.unshift(root.name.text);
    root = root.expression;
  }
  return ts.isIdentifier(root) && accessPath.length > 0 ? { path: accessPath, root } : undefined;
}

function enclosingPropertyAccess(node: ts.Node): ts.PropertyAccessExpression | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node;
  }
  return ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)
    ? node.parent
    : undefined;
}

function stringModuleSpecifier(node: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}
