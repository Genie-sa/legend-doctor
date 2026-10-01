import { propertyNameText, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { hasSoleSourceBinding } from "./independent-subscription-bindings.js";
import { isDirectValueFactory } from "../../core/imports.js";
import ts from "typescript";

const NO_CONSTANTS: ReadonlySet<string> = new Set();

/**
 * Paths of a `const x$ = observable(seed)` whose seed subtree is plain data: literals, `null`,
 * `undefined`, names in `plainConstants`, and arrays or objects of them. Such a node holds a value,
 * never a lazy `synced`, computed, or linked observable that a subscription would activate.
 */
export function plainSeedPaths(
  declaration: ts.VariableDeclaration,
  plainConstants: ReadonlySet<string> = NO_CONSTANTS,
): ReadonlySet<string> {
  const paths = new Set<string>();
  const call = declaration.initializer;
  if (
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    call &&
    ts.isCallExpression(call) &&
    call.arguments.length === 1 &&
    isDirectValueFactory(call)
  ) {
    collectPlainPaths(call.arguments[0]!, "", { paths, plainConstants });
  }
  return paths;
}

/** Module `const` bindings of a plain scalar literal whose name no other binding in the file reuses. */
export function localPlainConstants(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        isPlainConstantDeclaration(declaration) &&
        hasSoleSourceBinding(sourceFile, declaration.name.text)
      ) {
        names.add(declaration.name.text);
      }
    }
  }
  return names;
}

export function isPlainConstantDeclaration(
  declaration: ts.VariableDeclaration,
): declaration is ts.VariableDeclaration & { readonly name: ts.Identifier } {
  return (
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer !== undefined &&
    isPlainScalar(unwrapTransparentExpression(declaration.initializer), NO_CONSTANTS)
  );
}

interface PlainPathCollection {
  readonly paths: Set<string>;
  readonly plainConstants: ReadonlySet<string>;
}

function collectPlainPaths(
  seed: ts.Expression,
  prefix: string,
  collection: PlainPathCollection,
): void {
  const value = unwrapTransparentExpression(seed);
  if (isPlainValue(value, collection.plainConstants)) {
    collection.paths.add(prefix);
  }
  if (!ts.isObjectLiteralExpression(value) || !hasStaticUniqueKeys(value)) {
    return;
  }
  for (const property of value.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name)!;
      collectPlainPaths(property.initializer, prefix ? `${prefix}.${name}` : name, collection);
    }
  }
}

/** Without spreads, accessors, or repeated keys, no later member can replace a property's seed. */
function hasStaticUniqueKeys(value: ts.ObjectLiteralExpression): boolean {
  const names = new Set<string>();
  return value.properties.every((property) => {
    const name =
      ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
        ? propertyNameText(property.name)
        : null;
    if (name === null || names.has(name)) {
      return false;
    }
    names.add(name);
    return true;
  });
}

export function isPlainValue(seed: ts.Expression, plainConstants: ReadonlySet<string>): boolean {
  const value = unwrapTransparentExpression(seed);
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) !== null &&
        isPlainValue(property.initializer, plainConstants),
    );
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every(
      (element) =>
        !ts.isSpreadElement(element) &&
        !ts.isOmittedExpression(element) &&
        isPlainValue(element, plainConstants),
    );
  }
  return isPlainScalar(value, plainConstants);
}

function isPlainScalar(value: ts.Expression, plainConstants: ReadonlySet<string>): boolean {
  return (
    (ts.isIdentifier(value) && plainConstants.has(value.text)) ||
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) && value.text === "undefined") ||
    (ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand))
  );
}
