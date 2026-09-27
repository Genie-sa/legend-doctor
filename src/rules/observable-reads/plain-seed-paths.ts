import { propertyNameText, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { collectHookImports } from "../../core/imports.js";
import ts from "typescript";

/**
 * Paths of a `const x$ = observable(seed)` whose seed subtree is plain data: literals, `null`,
 * `undefined`, and arrays or objects of them. Such a node holds a value, never a lazy `synced`,
 * computed, or linked observable that a subscription would activate.
 */
export function plainSeedPaths(declaration: ts.VariableDeclaration): ReadonlySet<string> {
  const paths = new Set<string>();
  const call = declaration.initializer;
  if (
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    call &&
    ts.isCallExpression(call) &&
    call.arguments.length === 1 &&
    isValueFactory(call)
  ) {
    collectPlainPaths(call.arguments[0]!, "", paths);
  }
  return paths;
}

function isValueFactory(call: ts.CallExpression): boolean {
  const imports = collectHookImports(call.getSourceFile());
  return (
    ts.isIdentifier(call.expression) &&
    (imports.observable.has(call.expression.text) ||
      imports.useObservable.has(call.expression.text))
  );
}

function collectPlainPaths(seed: ts.Expression, prefix: string, paths: Set<string>): void {
  const value = unwrapTransparentExpression(seed);
  if (isPlainValue(value)) {
    paths.add(prefix);
  }
  if (!ts.isObjectLiteralExpression(value) || !hasStaticUniqueKeys(value)) {
    return;
  }
  for (const property of value.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name)!;
      collectPlainPaths(property.initializer, prefix ? `${prefix}.${name}` : name, paths);
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

function isPlainValue(seed: ts.Expression): boolean {
  const value = unwrapTransparentExpression(seed);
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) !== null &&
        isPlainValue(property.initializer),
    );
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every(
      (element) =>
        !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) && isPlainValue(element),
    );
  }
  return isPlainScalar(value);
}

function isPlainScalar(value: ts.Expression): boolean {
  return (
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
