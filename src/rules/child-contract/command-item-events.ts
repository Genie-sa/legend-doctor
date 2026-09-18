import type { CallbackContractSourceResolver, ChildComponentSource } from "./model.js";
import { bindingDeclarationCount, isNonValueIdentifier } from "../../core/analysis-ast.js";
import { findAncestor, identifiersNamed, visit } from "../../core/ast.js";
import { booleanPropValueAtInvocation } from "./invocation-boolean-props.js";
import ts from "typescript";

const stableImports = new WeakMap<CallbackContractSourceResolver, boolean>();
const stableSources = new WeakMap<ts.SourceFile, boolean>();

/** Audited cmdk 1.1.1: only Item.onSelect, never root value changes or arbitrary on* props. */
export function commandItemEventIsDeferred(
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
  prop: string,
  context: {
    source: ChildComponentSource | undefined;
    resolver: CallbackContractSourceResolver | undefined;
  },
): boolean {
  const { source, resolver } = context;
  if (prop !== "onSelect" || !source || !resolver?.callbackPackageVersion) {
    return false;
  }
  const opening = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return false;
  }
  const tag = opening.tagName;
  if (
    !isHostItemInvocation(opening, attribute, source) ||
    !ts.isPropertyAccessExpression(tag) ||
    tag.name.text !== "Item" ||
    !ts.isIdentifier(tag.expression)
  ) {
    return false;
  }
  return (
    bindingDeclarationCount(source.owner, tag.expression.text) === 0 &&
    isCommandImport(source.owner.getSourceFile(), tag.expression.text) &&
    !hasUntrackedPackageTransport(source.owner.getSourceFile(), true) &&
    loadedCommandImportsAreStable(source, resolver) &&
    resolver.callbackPackageVersion(source.file, "cmdk") === "1.1.1"
  );
}

function isCommandImport(source: ts.SourceFile, name: string): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "cmdk" ||
      statement.importClause?.isTypeOnly
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          element.name.text === name &&
          (element.propertyName?.text ?? element.name.text) === "Command",
      )
    );
  });
}

/** Reject overwritten members and aliases/escapes that could replace the imported terminal. */
function commandImportsOnlyUsedAsTags(source: ts.SourceFile): boolean {
  return source.statements.every((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "cmdk" ||
      statement.importClause?.isTypeOnly
    ) {
      return true;
    }
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (clause?.name || !bindings) {
      return false;
    }
    const names = ts.isNamespaceImport(bindings)
      ? [bindings.name.text]
      : bindings.elements
          .filter(
            (element) =>
              !element.isTypeOnly &&
              ["Command", "CommandItem", "CommandRoot"].includes(
                element.propertyName?.text ?? element.name.text,
              ),
          )
          .map((element) => element.name.text);
    return names.every((name) => importBindingOnlyUsedAsTags(source, name));
  });
}

function importBindingOnlyUsedAsTags(source: ts.SourceFile, name: string): boolean {
  return identifiersNamed(source, name).every((reference) => {
    if (findAncestor(reference, ts.isExportDeclaration)) {
      return false;
    }
    if (
      isNonValueIdentifier(reference) ||
      findAncestor(reference, ts.isImportDeclaration) ||
      findAncestor(reference, ts.isTypeNode)
    ) {
      return true;
    }
    let tag: ts.Node = reference;
    while (ts.isPropertyAccessExpression(tag.parent) && tag.parent.expression === tag) {
      tag = tag.parent;
    }
    const opening = tag.parent;
    return (
      (ts.isJsxOpeningElement(opening) ||
        ts.isJsxSelfClosingElement(opening) ||
        ts.isJsxClosingElement(opening)) &&
      opening.tagName === tag
    );
  });
}

/** A discarded callback cannot establish an actionable event-owned command. */
function attributeIsFinalSelection(attribute: ts.JsxAttribute | ts.JsxSpreadAttribute): boolean {
  const attributes = attribute.parent.properties;
  const index = attributes.indexOf(attribute);
  return (
    index !== -1 &&
    attributes
      .slice(index + 1)
      .every((later) => ts.isJsxAttribute(later) && later.name.getText() !== "onSelect")
  );
}

function isHostItemInvocation(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  attribute: ts.JsxAttribute | ts.JsxSpreadAttribute,
  source: ChildComponentSource,
): boolean {
  const asChild = booleanPropValueAtInvocation(
    {
      ...source,
      invocation: opening,
      invocationOwner: source,
    },
    "asChild",
  );
  return (asChild === "absent" || asChild === false) && attributeIsFinalSelection(attribute);
}

function loadedCommandImportsAreStable(
  source: ChildComponentSource,
  resolver: CallbackContractSourceResolver,
): boolean {
  const cached = stableImports.get(resolver);
  if (cached !== undefined) {
    return cached;
  }
  const files = resolver.sourceFiles?.() ?? [source.owner.getSourceFile()];
  const stable = files.every((file) => sourceCommandImportsAreStable(file));
  stableImports.set(resolver, stable);
  return stable;
}

function sourceCommandImportsAreStable(source: ts.SourceFile): boolean {
  const cached = stableSources.get(source);
  if (cached !== undefined) {
    return cached;
  }
  const safe = commandImportsOnlyUsedAsTags(source) && !hasUntrackedPackageTransport(source);
  stableSources.set(source, safe);
  return safe;
}

function hasUntrackedPackageTransport(source: ts.SourceFile, rejectUnknown = false): boolean {
  let untracked = false;
  visit(source, (node) => {
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "cmdk"
    ) {
      untracked = true;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      node.moduleReference.expression.text === "cmdk"
    ) {
      untracked = true;
    }
    if (
      ts.isCallExpression(node) &&
      isPackageLoader(node.expression) &&
      loaderCouldLoadCommand(node, rejectUnknown)
    ) {
      untracked = true;
    }
  });
  return untracked;
}

function isPackageLoader(expression: ts.Expression): boolean {
  return (
    expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(expression) && expression.text === "require") ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === "require")
  );
}

function loaderCouldLoadCommand(call: ts.CallExpression, rejectUnknown: boolean): boolean {
  const [specifier] = call.arguments;
  return specifier && ts.isStringLiteralLike(specifier) ? specifier.text === "cmdk" : rejectUnknown;
}
