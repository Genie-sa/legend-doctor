import { propertyNameText, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { isDirectValueFactory } from "../../core/imports.js";
import { soleTypeDeclaration } from "../child-contract/declared-prop-types.js";
import ts from "typescript";

/**
 * A value domain wide enough that two distinct values can compare equal to the same boolean:
 * `primitive` when every value is a primitive, `object` when a value may be an object.
 */
export type ValueDomain = "object" | "primitive";

/** A domain summary: the distinct primitive values it can hold, or `null` when unbounded. */
export interface DomainValues {
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

/**
 * Where the values at a path are written down: a declared type, or the seed expression whose
 * widened type TypeScript infers.
 */
export type ValueSource =
  | { readonly kind: "seed"; readonly seed: ts.Expression }
  | { readonly kind: "type"; readonly type: ts.TypeNode };

/** The source at `path` under a declared value type, resolving same-file interfaces and aliases. */
export function typeSource(type: ts.TypeNode, path: readonly string[]): ValueSource | null {
  const leaf = memberType(type, path, 0);
  return leaf ? { kind: "type", type: leaf } : null;
}

/**
 * The source at `path` inside an `observable(...)` or `useObservable(...)` declaration: its type
 * argument when present, otherwise the seed TypeScript widens (`"a"` to string, `0` to number).
 */
export function declarationSource(
  declaration: ts.VariableDeclaration,
  path: readonly string[],
): ValueSource | null {
  const call = declaration.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  if (!call || !ts.isCallExpression(call) || !isDirectValueFactory(call)) {
    return null;
  }
  const [typeArgument] = call.typeArguments ?? [];
  if (typeArgument) {
    return typeSource(typeArgument, path);
  }
  const [seed] = call.arguments;
  return seed ? seedSource(seed, path) : null;
}

export function seedSource(seed: ts.Expression, path: readonly string[]): ValueSource | null {
  if (ts.isParenthesizedExpression(seed)) {
    return seedSource(seed.expression, path);
  }
  if (ts.isAsExpression(seed) || ts.isTypeAssertionExpression(seed)) {
    return isConstAssertion(seed.type) ? null : typeSource(seed.type, path);
  }
  const [head, ...rest] = path;
  if (head === undefined) {
    return { kind: "seed", seed };
  }
  const member = seedMember(seed, head);
  return member ? seedSource(member, rest) : null;
}

export function sourceDomainValues(source: ValueSource): DomainValues | null {
  return source.kind === "type" ? typeValues(source.type, 0) : seedLeafValues(source.seed);
}

/**
 * The source of the declared data property `name`, read past `null` and `undefined` members of
 * the receiver's union. Only property signatures resolve, so a read never runs program code.
 */
export function memberSource(source: ValueSource, name: string): ValueSource | null {
  if (source.kind === "seed") {
    return seedSource(source.seed, [name]);
  }
  const present = presentType(source.type, 0);
  return present ? typeSource(present, [name]) : null;
}

/** Whether a value may be `null` or `undefined`, assuming so for unresolved types. */
export function admitsNullish(source: ValueSource): boolean {
  return source.kind === "type" && typeAdmitsNullish(source.type, 0);
}

function presentType(type: ts.TypeNode, depth: number): ts.TypeNode | null {
  if (depth > MAX_TYPE_DEPTH) {
    return null;
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return presentType(type.type, depth + 1);
  }
  if (ts.isUnionTypeNode(type)) {
    const [sole, ...others] = type.types.filter((member) => !isNullishType(member));
    return sole && others.length === 0 ? presentType(sole, depth + 1) : null;
  }
  const declaration = declaredType(type);
  return declaration && ts.isTypeAliasDeclaration(declaration)
    ? presentType(declaration.type, depth + 1)
    : type;
}

function typeAdmitsNullish(type: ts.TypeNode, depth: number): boolean {
  if (depth > MAX_TYPE_DEPTH) {
    return true;
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return typeAdmitsNullish(type.type, depth + 1);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.some((member) => typeAdmitsNullish(member, depth + 1));
  }
  if (ts.isTypeReferenceNode(type)) {
    return referenceAdmitsNullish(type, depth);
  }
  const values = typeValues(type, depth);
  return (
    values === null ||
    (values.primitives !== null &&
      (values.primitives.has("null") || values.primitives.has("undefined")))
  );
}

/** A local alias admits nullish when its type does; an unresolved name may, unless a global container. */
function referenceAdmitsNullish(type: ts.TypeReferenceNode, depth: number): boolean {
  const declaration = declaredType(type);
  return declaration
    ? ts.isTypeAliasDeclaration(declaration) && typeAdmitsNullish(declaration.type, depth + 1)
    : !BUILTIN_OBJECT_TYPES.has(type.typeName.getText()) || importsName(type);
}

function isNullishType(type: ts.TypeNode): boolean {
  return (
    type.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword)
  );
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

function seedLeafValues(seed: ts.Expression): DomainValues | null {
  if (
    ts.isStringLiteralLike(seed) ||
    ts.isNumericLiteral(seed) ||
    ts.isBigIntLiteral(seed) ||
    (ts.isPrefixUnaryExpression(seed) &&
      seed.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(seed.operand))
  ) {
    return UNBOUNDED_PRIMITIVE;
  }
  return ts.isObjectLiteralExpression(seed) || ts.isArrayLiteralExpression(seed) ? OBJECT : null;
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

export function broadDomain(values: DomainValues | null): ValueDomain | null {
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

/** How truthiness splits a domain, for a selector that keeps only `!!value`. */
export interface TruthinessDomain {
  /** Two distinct truthy values exist, so a change between them leaves the boolean unchanged. */
  readonly keepsTruthinessAcrossChanges: boolean;
  /** `0`, `NaN`, `""`, or `0n` is possible, which JSX renders as text where `false` renders nothing. */
  readonly rendersFalsyValue: boolean;
}

export function truthinessDomain(values: DomainValues | null): TruthinessDomain | null {
  if (!values) {
    return null;
  }
  const { objects, primitives } = values;
  if (primitives === null) {
    return { keepsTruthinessAcrossChanges: true, rendersFalsyValue: true };
  }
  const literals = [...primitives];
  return {
    keepsTruthinessAcrossChanges:
      objects || literals.filter((literal) => isTruthyLiteral(literal)).length > 1,
    rendersFalsyValue: literals.some((literal) => isRenderedFalsyLiteral(literal)),
  };
}

function isTruthyLiteral(literal: string): boolean {
  return (
    literal === "true" ||
    (literal.startsWith("string:") && literal !== "string:") ||
    isNonZeroNumber(literal)
  );
}

function isRenderedFalsyLiteral(literal: string): boolean {
  return literal === "string:" || (literal.startsWith("number:") && !isNonZeroNumber(literal));
}

function isNonZeroNumber(literal: string): boolean {
  if (!literal.startsWith("number:")) {
    return false;
  }
  const digits = literal.slice("number:".length).replaceAll("_", "");
  return digits.endsWith("n") ? BigInt(digits.slice(0, -1)) !== 0n : Number(digits) !== 0;
}
