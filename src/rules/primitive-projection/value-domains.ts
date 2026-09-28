import { propertyNameText, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { collectHookImports } from "../../core/imports.js";
import { soleTypeDeclaration } from "../child-contract/declared-prop-types.js";
import ts from "typescript";

/**
 * A value domain wide enough that two distinct values can compare equal to the same boolean:
 * `primitive` when every value is a primitive, `object` when a value may be an object.
 */
export type ValueDomain = "object" | "primitive";

/** A domain summary: the distinct primitive values it can hold, or `null` when unbounded. */
interface DomainValues {
  readonly objects: boolean;
  readonly primitives: ReadonlySet<string> | null;
}

const MAX_TYPE_DEPTH = 8;

const MIN_BROAD_FINITE_VALUES = 3;

const UNBOUNDED_PRIMITIVE: DomainValues = { objects: false, primitives: null };

const OBJECT: DomainValues = { objects: true, primitives: new Set() };

const KEYWORD_VALUES = new Map<ts.SyntaxKind, DomainValues>([
  [ts.SyntaxKind.ArrayType, OBJECT],
  [ts.SyntaxKind.BigIntKeyword, UNBOUNDED_PRIMITIVE],
  [ts.SyntaxKind.BooleanKeyword, { objects: false, primitives: new Set(["true", "false"]) }],
  [ts.SyntaxKind.FunctionType, OBJECT],
  [ts.SyntaxKind.NullKeyword, { objects: false, primitives: new Set(["null"]) }],
  [ts.SyntaxKind.NumberKeyword, UNBOUNDED_PRIMITIVE],
  [ts.SyntaxKind.StringKeyword, UNBOUNDED_PRIMITIVE],
  [ts.SyntaxKind.TemplateLiteralType, UNBOUNDED_PRIMITIVE],
  [ts.SyntaxKind.TupleType, OBJECT],
  [ts.SyntaxKind.TypeLiteral, OBJECT],
  [ts.SyntaxKind.UndefinedKeyword, { objects: false, primitives: new Set(["undefined"]) }],
  [ts.SyntaxKind.VoidKeyword, { objects: false, primitives: new Set(["undefined"]) }],
]);

/** Global generic containers whose instances are always objects. */
const BUILTIN_OBJECT_TYPES = new Set(["Array", "Map", "ReadonlyArray", "Record", "Set"]);

/** The domain at `path` under a declared value type, resolving same-file interfaces and aliases. */
export function typeValueDomain(type: ts.TypeNode, path: readonly string[]): ValueDomain | null {
  const leaf = memberType(type, path, 0);
  return leaf ? broadDomain(typeValues(leaf, 0)) : null;
}

/**
 * The domain at `path` inside an `observable(...)` or `useObservable(...)` declaration: its type
 * argument when present, otherwise the seed TypeScript widens (`"a"` to string, `0` to number).
 */
export function declarationValueDomain(
  declaration: ts.VariableDeclaration,
  path: readonly string[],
): ValueDomain | null {
  const call = declaration.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  if (!call || !ts.isCallExpression(call) || !isDirectValueFactory(call)) {
    return null;
  }
  const [typeArgument] = call.typeArguments ?? [];
  if (typeArgument) {
    return typeValueDomain(typeArgument, path);
  }
  const [seed] = call.arguments;
  return seed ? seedValueDomain(seed, path) : null;
}

function isDirectValueFactory(call: ts.CallExpression): boolean {
  const imports = collectHookImports(call.getSourceFile());
  return (
    ts.isIdentifier(call.expression) &&
    (imports.observable.has(call.expression.text) ||
      imports.useObservable.has(call.expression.text))
  );
}

function seedValueDomain(seed: ts.Expression, path: readonly string[]): ValueDomain | null {
  if (ts.isParenthesizedExpression(seed)) {
    return seedValueDomain(seed.expression, path);
  }
  if (ts.isAsExpression(seed) || ts.isTypeAssertionExpression(seed)) {
    return isConstAssertion(seed.type) ? null : typeValueDomain(seed.type, path);
  }
  const [head, ...rest] = path;
  if (head === undefined) {
    return seedLeafDomain(seed);
  }
  const member = seedMember(seed, head);
  return member ? seedValueDomain(member, rest) : null;
}

/** The sole plain `key: value` initializer of an object literal without spreads. */
function seedMember(seed: ts.Expression, key: string): ts.Expression | null {
  if (
    !ts.isObjectLiteralExpression(seed) ||
    seed.properties.some((member) => ts.isSpreadAssignment(member))
  ) {
    return null;
  }
  const matches = seed.properties.filter(
    (property) => property.name && propertyNameText(property.name) === key,
  );
  const [property] = matches;
  return matches.length === 1 && property && ts.isPropertyAssignment(property)
    ? property.initializer
    : null;
}

function seedLeafDomain(seed: ts.Expression): ValueDomain | null {
  if (
    ts.isStringLiteralLike(seed) ||
    ts.isNumericLiteral(seed) ||
    ts.isBigIntLiteral(seed) ||
    (ts.isPrefixUnaryExpression(seed) &&
      seed.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(seed.operand))
  ) {
    return "primitive";
  }
  return ts.isObjectLiteralExpression(seed) || ts.isArrayLiteralExpression(seed) ? "object" : null;
}

function isConstAssertion(type: ts.TypeNode): boolean {
  return (
    ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "const"
  );
}

function memberType(type: ts.TypeNode, path: readonly string[], depth: number): ts.TypeNode | null {
  const [head, ...rest] = path;
  if (head === undefined) {
    return type;
  }
  if (depth > MAX_TYPE_DEPTH) {
    return null;
  }
  const members = typeMembers(type, depth);
  const matches =
    members?.filter((member) => member.name && propertyNameText(member.name) === head) ?? [];
  const [member] = matches;
  return matches.length === 1 &&
    member &&
    ts.isPropertySignature(member) &&
    !member.questionToken &&
    member.type
    ? memberType(member.type, rest, depth + 1)
    : null;
}

function typeMembers(type: ts.TypeNode, depth: number): ts.NodeArray<ts.TypeElement> | null {
  if (ts.isParenthesizedTypeNode(type)) {
    return typeMembers(type.type, depth + 1);
  }
  if (ts.isTypeLiteralNode(type)) {
    return indexFree(type.members);
  }
  const declaration = declaredType(type);
  if (!declaration || depth > MAX_TYPE_DEPTH) {
    return null;
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    return typeMembers(declaration.type, depth + 1);
  }
  return declaration.heritageClauses?.length ? null : indexFree(declaration.members);
}

function indexFree(members: ts.NodeArray<ts.TypeElement>): ts.NodeArray<ts.TypeElement> | null {
  return members.some((member) => ts.isIndexSignatureDeclaration(member)) ? null : members;
}

function declaredType(type: ts.TypeNode): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && !type.typeArguments
    ? soleTypeDeclaration(type.getSourceFile(), type.typeName.text)
    : null;
}

function typeValues(type: ts.TypeNode, depth: number): DomainValues | null {
  if (depth > MAX_TYPE_DEPTH) {
    return null;
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return typeValues(type.type, depth + 1);
  }
  if (ts.isUnionTypeNode(type)) {
    return unionValues(type.types.map((member) => typeValues(member, depth + 1)));
  }
  return ts.isLiteralTypeNode(type) ? literalValues(type.literal) : namedTypeValues(type, depth);
}

function namedTypeValues(type: ts.TypeNode, depth: number): DomainValues | null {
  return ts.isTypeReferenceNode(type)
    ? referenceValues(type, depth)
    : (KEYWORD_VALUES.get(type.kind) ?? null);
}

function literalValues(literal: ts.LiteralTypeNode["literal"]): DomainValues | null {
  if (literal.kind === ts.SyntaxKind.NullKeyword) {
    return { objects: false, primitives: new Set(["null"]) };
  }
  if (literal.kind === ts.SyntaxKind.TrueKeyword || literal.kind === ts.SyntaxKind.FalseKeyword) {
    return { objects: false, primitives: new Set([literal.getText()]) };
  }
  if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) {
    return { objects: false, primitives: new Set([`string:${literal.text}`]) };
  }
  if (ts.isNumericLiteral(literal) || ts.isBigIntLiteral(literal)) {
    return { objects: false, primitives: new Set([`number:${literal.text}`]) };
  }
  return null;
}

function referenceValues(type: ts.TypeReferenceNode, depth: number): DomainValues | null {
  if (!ts.isIdentifier(type.typeName)) {
    return null;
  }
  const declaration = soleTypeDeclaration(type.getSourceFile(), type.typeName.text);
  if (declaration) {
    return ts.isInterfaceDeclaration(declaration)
      ? OBJECT
      : typeValues(declaration.type, depth + 1);
  }
  return BUILTIN_OBJECT_TYPES.has(type.typeName.text) && !importsName(type) ? OBJECT : null;
}

function importsName(type: ts.TypeReferenceNode): boolean {
  const name = type.typeName.getText();
  return type
    .getSourceFile()
    .statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        statement.importClause !== undefined &&
        (statement.importClause.name?.text === name ||
          (statement.importClause.namedBindings !== undefined &&
            ts.isNamedImports(statement.importClause.namedBindings) &&
            statement.importClause.namedBindings.elements.some(
              (element) => element.name.text === name,
            ))),
    );
}

function unionValues(members: readonly (DomainValues | null)[]): DomainValues | null {
  let primitives: Set<string> | null = new Set();
  let objects = false;
  for (const member of members) {
    if (!member) {
      return null;
    }
    objects ||= member.objects;
    primitives =
      primitives === null || member.primitives === null
        ? null
        : new Set([...primitives, ...member.primitives]);
  }
  return { objects, primitives };
}

function broadDomain(values: DomainValues | null): ValueDomain | null {
  if (!values) {
    return null;
  }
  if (values.objects) {
    return "object";
  }
  return values.primitives === null || values.primitives.size >= MIN_BROAD_FINITE_VALUES
    ? "primitive"
    : null;
}
