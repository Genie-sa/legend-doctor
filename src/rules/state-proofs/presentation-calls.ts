import { lexicalBinding, moduleBinding } from "../../core/lexical-bindings.js";
import {
  outermostTransparentParent,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { LexicalBinding } from "../../core/lexical-bindings.js";
import { isConstDeclaration } from "../../core/binding-references.js";
import ts from "typescript";

export type StyleSheetMember = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

/** Class-name packages whose exports only join and merge their arguments into class strings. */
const PURE_CLASS_NAME_EXPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["class-variance-authority", new Set(["cva", "cx"])],
  ["classnames", new Set(["default"])],
  ["clsx", new Set(["clsx", "default"])],
  ["tailwind-merge", new Set(["twJoin", "twMerge"])],
]);

/** Modules whose `StyleSheet.create` returns the style object it is given. */
const STYLE_SHEET_MODULES: ReadonlySet<string> = new Set([
  "react-native",
  "react-native-unistyles",
]);

/** Every module-scope name the file imports from a pure class-name package. */
export function pureClassNameImports(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    const localNames = [
      clause?.name,
      ...(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.map((element) => element.name)
        : []),
    ];
    for (const local of localNames) {
      if (local && isPureClassNameBinding(moduleBinding(sourceFile, local.text))) {
        names.add(local.text);
      }
    }
  }
  return names;
}

/**
 * A callee that only builds class strings: an import from a pure class-name package, a `const`
 * bound to the variant function `cva` returns, or a local function whose single return
 * passes its parameters straight into those imports.
 */
export function isPureClassNameCallee(callee: ts.Identifier): boolean {
  const binding = lexicalBinding(callee);
  if (binding?.kind === "function") {
    return (
      ts.isFunctionDeclaration(binding.declaration) &&
      isPureProjectionDeclaration(binding.declaration)
    );
  }
  if (binding?.kind !== "value" || !ts.isVariableDeclaration(binding.declaration)) {
    return isPureClassNameBinding(binding);
  }
  const { initializer } = binding.declaration;
  const builder = initializer && unwrapTransparentExpression(initializer);
  return (
    isConstDeclaration(binding.declaration) &&
    builder !== undefined &&
    ts.isCallExpression(builder) &&
    ts.isIdentifier(builder.expression) &&
    isVariantBuilder(lexicalBinding(builder.expression))
  );
}

/**
 * The function a `styles.member(...)` call invokes when `styles` is a `const` bound to
 * `StyleSheet.create` from React Native or Unistyles, whose style object is written in place.
 */
export function styleSheetMember(callee: ts.PropertyAccessExpression): StyleSheetMember | null {
  const sheet = unwrapTransparentExpression(callee.expression);
  const binding = ts.isIdentifier(sheet) ? lexicalBinding(sheet) : null;
  const declaration = binding?.kind === "value" ? binding.declaration : null;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !isConstDeclaration(declaration) ||
    !declaration.initializer
  ) {
    return null;
  }
  const styles = styleSheetObject(declaration.initializer);
  return styles ? objectMemberFunction(styles, callee.name.text) : null;
}

/**
 * A call rooted at a parameter of the factory passed to `StyleSheet.create`, such as
 * `theme.sizing.scale(22)`. Unistyles itself re-invokes the factory and its member functions with
 * those parameters whenever the theme or runtime changes, outside any React render, so calling
 * them from a moved style member adds no evaluation the library does not already perform.
 */
export function callsStyleSheetTheme(callee: ts.Expression): boolean {
  const root = rootIdentifier(callee);
  const binding = root ? lexicalBinding(root) : null;
  const parameter = binding?.kind === "value" ? binding.declaration : null;
  return parameter !== null && ts.isParameter(parameter) && isStyleSheetFactory(parameter.parent);
}

function isStyleSheetFactory(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
    return false;
  }
  const argument = outermostTransparentParent(node);
  const call = argument.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[0] === argument &&
    isStyleSheetCreate(call.expression)
  );
}

/**
 * A function declaration whose single statement returns a pure class-name call on its parameters,
 * such as `function cn(...inputs) { return twMerge(clsx(inputs)); }`.
 */
export function isPureProjectionDeclaration(declaration: ts.FunctionDeclaration): boolean {
  if (
    !declaration.body ||
    declaration.asteriskToken ||
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    declaration.body.statements.length !== 1 ||
    declaration.parameters.length === 0 ||
    declaration.parameters.some(
      (parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  ) {
    return false;
  }
  const [statement] = declaration.body.statements;
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
    return false;
  }
  // SAFETY: the guard above returns false unless every parameter name is an identifier.
  const parameters = new Set(
    declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text),
  );
  const referenced = new Set<string>();
  const pure = isPureProjectionExpression(statement.expression, parameters, referenced);
  return pure && [...parameters].every((parameter) => referenced.has(parameter));
}

function isPureClassNameBinding(binding: LexicalBinding | null): boolean {
  return (
    binding?.kind === "import" &&
    (PURE_CLASS_NAME_EXPORTS.get(binding.moduleSpecifier)?.has(binding.importedName) ?? false)
  );
}

function isVariantBuilder(binding: LexicalBinding | null): boolean {
  return (
    binding?.kind === "import" &&
    binding.moduleSpecifier === "class-variance-authority" &&
    binding.importedName === "cva"
  );
}

function styleSheetObject(initializer: ts.Expression): ts.ObjectLiteralExpression | null {
  const call = unwrapTransparentExpression(initializer);
  if (!ts.isCallExpression(call) || !isStyleSheetCreate(call.expression)) {
    return null;
  }
  const [argument] = call.arguments;
  const styles = argument && unwrapTransparentExpression(argument);
  const returned =
    styles && ts.isArrowFunction(styles) && !ts.isBlock(styles.body)
      ? unwrapTransparentExpression(styles.body)
      : styles;
  return returned && ts.isObjectLiteralExpression(returned) ? returned : null;
}

function isStyleSheetCreate(callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "create") {
    return false;
  }
  const namespace = unwrapTransparentExpression(callee.expression);
  const binding = ts.isIdentifier(namespace) ? lexicalBinding(namespace) : null;
  return (
    binding?.kind === "import" &&
    binding.importedName === "StyleSheet" &&
    STYLE_SHEET_MODULES.has(binding.moduleSpecifier)
  );
}

/** The one member of that name; a spread or a computed key could replace or add it. */
function objectMemberFunction(
  styles: ts.ObjectLiteralExpression,
  name: string,
): StyleSheetMember | null {
  if (
    styles.properties.some(
      (property) => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name),
    )
  ) {
    return null;
  }
  const members = styles.properties.filter((property) => property.name?.getText() === name);
  const [member] = members;
  if (members.length !== 1 || !member) {
    return null;
  }
  if (ts.isMethodDeclaration(member)) {
    return member;
  }
  const value = ts.isPropertyAssignment(member)
    ? unwrapTransparentExpression(member.initializer)
    : null;
  return value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : null;
}

function isPureProjectionExpression(
  expression: ts.Expression,
  parameters: ReadonlySet<string>,
  referenced: Set<string>,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isIdentifier(value)) {
    if (!parameters.has(value.text)) {
      return false;
    }
    referenced.add(value.text);
    return true;
  }
  if (isPureProjectionLiteral(value)) {
    return true;
  }
  const elements = ts.isArrayLiteralExpression(value)
    ? value.elements
    : isPureClassNameCall(value, parameters) && value.arguments;
  return (
    elements !== false &&
    elements.every(
      (element) =>
        !ts.isSpreadElement(element) && isPureProjectionExpression(element, parameters, referenced),
    )
  );
}

function isPureClassNameCall(
  value: ts.Expression,
  parameters: ReadonlySet<string>,
): value is ts.CallExpression {
  return (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    !parameters.has(value.expression.text) &&
    isPureClassNameBinding(lexicalBinding(value.expression))
  );
}

function isPureProjectionLiteral(value: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}
