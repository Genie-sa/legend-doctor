import ts from "typescript";

/**
 * The runtime kind of a method receiver. An `object` is a locally declared object, class, or
 * function type: its methods are the program's own code, never a read-only built-in.
 */
export type Receiver =
  | { readonly kind: "array"; readonly element: Receiver | null }
  | { readonly kind: "map" | "number" | "object" | "set" | "string" };

type LocalTypeDeclaration = ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

/** A type name declared in no enclosing scope, so it names a global such as `Array`. */
const GLOBAL_TYPE = Symbol("global type");

/** Bounds alias hops, so a cyclic `type` pair cannot recurse forever. */
const MAX_ALIAS_HOPS = 8;

export const NUMBER_RECEIVER: Receiver = { kind: "number" };
export const OBJECT_RECEIVER: Receiver = { kind: "object" };
export const STRING_RECEIVER: Receiver = { kind: "string" };

const GLOBAL_COLLECTIONS: ReadonlyMap<string, Receiver> = new Map([
  ["Map", { kind: "map" }],
  ["ReadonlyMap", { kind: "map" }],
  ["ReadonlySet", { kind: "set" }],
  ["Set", { kind: "set" }],
  ["WeakMap", { kind: "map" }],
  ["WeakSet", { kind: "set" }],
]);

export function arrayOf(element: Receiver | null): Receiver {
  return { element, kind: "array" };
}

/** A global `Map`, `Set`, or weak or read-only variant, by its constructor or type name. */
export function globalCollectionReceiver(name: string): Receiver | null {
  return GLOBAL_COLLECTIONS.get(name) ?? null;
}

export function sameReceiver(left: Receiver | null, right: Receiver | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.kind === "array" && right.kind === "array") {
    return sameReceiver(left.element, right.element);
  }
  return left.kind === right.kind;
}

/** The receiver a written type proves, resolving local aliases, interfaces, and classes. */
export function typeReceiver(type: ts.TypeNode, hops = MAX_ALIAS_HOPS): Receiver | null {
  if (
    ts.isParenthesizedTypeNode(type) ||
    (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword)
  ) {
    return typeReceiver(type.type, hops);
  }
  if (ts.isUnionTypeNode(type)) {
    return unionReceiver(type, hops);
  }
  if (ts.isTypeReferenceNode(type)) {
    return referenceReceiver(type, hops);
  }
  if (ts.isTypeLiteralNode(type) || ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) {
    return OBJECT_RECEIVER;
  }
  return arrayTypeReceiver(type, hops) ?? primitiveTypeReceiver(type);
}

/** An instance of a local class declares no inherited built-in methods unless the class extends. */
export function classReceiver(declaration: ts.ClassDeclaration): Receiver | null {
  return extendsAnything(declaration) ? null : OBJECT_RECEIVER;
}

/** The written type of one property of a type literal or a local interface or alias. */
export function propertyType(
  type: ts.TypeNode,
  property: string,
  hops = MAX_ALIAS_HOPS,
): ts.TypeNode | null {
  const members = typeMembers(type, hops);
  const member = members?.find(
    (candidate): candidate is ts.PropertySignature =>
      ts.isPropertySignature(candidate) && candidate.name.getText() === property,
  );
  return member?.type ?? null;
}

function typeMembers(type: ts.TypeNode, hops: number): readonly ts.TypeElement[] | null {
  if (ts.isParenthesizedTypeNode(type)) {
    return typeMembers(type.type, hops);
  }
  if (ts.isTypeLiteralNode(type)) {
    return type.members;
  }
  const declaration = ts.isTypeReferenceNode(type) ? localTypeDeclaration(type) : null;
  if (!declaration || declaration === GLOBAL_TYPE || ts.isClassDeclaration(declaration)) {
    return null;
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return declaration.members;
  }
  return hops > 0 ? typeMembers(declaration.type, hops - 1) : null;
}

function arrayTypeReceiver(type: ts.TypeNode, hops: number): Receiver | null {
  if (ts.isArrayTypeNode(type)) {
    return arrayOf(typeReceiver(type.elementType, hops));
  }
  return ts.isTupleTypeNode(type) ? arrayOf(null) : null;
}

function primitiveTypeReceiver(type: ts.TypeNode): Receiver | null {
  if (
    type.kind === ts.SyntaxKind.StringKeyword ||
    ts.isTemplateLiteralTypeNode(type) ||
    (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal))
  ) {
    return STRING_RECEIVER;
  }
  return type.kind === ts.SyntaxKind.NumberKeyword ||
    (ts.isLiteralTypeNode(type) && ts.isNumericLiteral(type.literal))
    ? NUMBER_RECEIVER
    : null;
}

/** A union whose members share one receiver once `null` and `undefined` are set aside. */
function unionReceiver(type: ts.UnionTypeNode, hops: number): Receiver | null {
  const [first, ...rest] = type.types
    .filter((member) => !isNullishType(member))
    .map((member) => typeReceiver(member, hops));
  return first !== undefined && rest.every((receiver) => sameReceiver(first, receiver))
    ? first
    : null;
}

function isNullishType(type: ts.TypeNode): boolean {
  return (
    type.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

function referenceReceiver(type: ts.TypeReferenceNode, hops: number): Receiver | null {
  const declaration = localTypeDeclaration(type);
  if (declaration === GLOBAL_TYPE) {
    return globalTypeReceiver(type);
  }
  if (!declaration) {
    return null;
  }
  if (ts.isClassDeclaration(declaration)) {
    return classReceiver(declaration);
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return extendsAnything(declaration) ? null : OBJECT_RECEIVER;
  }
  return hops > 0 ? typeReceiver(declaration.type, hops - 1) : null;
}

function globalTypeReceiver(type: ts.TypeReferenceNode): Receiver | null {
  const name = type.typeName.getText();
  if (name === "Array" || name === "ReadonlyArray") {
    const [element] = type.typeArguments ?? [];
    return arrayOf(element ? typeReceiver(element) : null);
  }
  return globalCollectionReceiver(name);
}

/** An `extends` clause may inherit built-in methods, such as from `Array`. */
function extendsAnything(declaration: ts.ClassDeclaration | ts.InterfaceDeclaration): boolean {
  return (
    declaration.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword) ??
    false
  );
}

/**
 * The one local declaration a type name resolves to, `GLOBAL_TYPE` when no enclosing scope
 * declares it, and null when it is imported, a type parameter, merged, or otherwise unresolved.
 */
function localTypeDeclaration(
  type: ts.TypeReferenceNode,
): LocalTypeDeclaration | typeof GLOBAL_TYPE | null {
  if (!ts.isIdentifier(type.typeName)) {
    return null;
  }
  const name = type.typeName.text;
  for (let scope: ts.Node | undefined = type.parent; scope; scope = scope.parent) {
    const declarations = scopeTypeDeclarations(scope, name);
    if (declarations.length > 0) {
      return declarations.length === 1 ? (declarations[0] ?? null) : null;
    }
  }
  return GLOBAL_TYPE;
}

function declaresTypeParameter(scope: ts.Node, name: string): boolean {
  const parameters =
    ts.isFunctionLike(scope) ||
    ts.isClassLike(scope) ||
    ts.isInterfaceDeclaration(scope) ||
    ts.isTypeAliasDeclaration(scope)
      ? scope.typeParameters
      : undefined;
  return parameters?.some((parameter) => parameter.name.text === name) ?? false;
}

/**
 * Every declaration of the type name in one scope; a type parameter, import, or enum of that name
 * makes it unresolvable.
 */
function scopeTypeDeclarations(
  scope: ts.Node,
  name: string,
): readonly (LocalTypeDeclaration | null)[] {
  if (declaresTypeParameter(scope, name)) {
    return [null];
  }
  if (!ts.isSourceFile(scope) && !ts.isBlock(scope) && !ts.isModuleBlock(scope)) {
    return [];
  }
  return scope.statements.flatMap((statement) => statementTypeDeclarations(statement, name));
}

function statementTypeDeclarations(
  statement: ts.Statement,
  name: string,
): readonly (LocalTypeDeclaration | null)[] {
  if (
    (ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return [statement];
  }
  return (ts.isEnumDeclaration(statement) && statement.name.text === name) ||
    (ts.isImportDeclaration(statement) && importsName(statement, name))
    ? [null]
    : [];
}

function importsName(declaration: ts.ImportDeclaration, name: string): boolean {
  const clause = declaration.importClause;
  if (!clause) {
    return false;
  }
  if (clause.name?.text === name) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (!bindings) {
    return false;
  }
  return ts.isNamespaceImport(bindings)
    ? bindings.name.text === name
    : bindings.elements.some((element) => element.name.text === name);
}
