import {
  soleTypeDeclaration,
  staticPropertyName,
} from "../rules/child-contract/declared-prop-types.js";
import ts from "typescript";
import { typeNamesObservable } from "./observable-paths.js";

type MemberVerdict =
  | { readonly kind: "absent" }
  | { readonly kind: "observable"; readonly type: ts.TypeNode }
  | { readonly kind: "other" };

const ABSENT: MemberVerdict = { kind: "absent" };

const OTHER: MemberVerdict = { kind: "other" };

interface MemberQuery {
  readonly depth: number;
  readonly observableTypes: ReadonlySet<string>;
  readonly propName: string;
}

const MAX_TYPE_DEPTH = 8;

const KEY_FILTERS = new Set(["Omit", "Pick"]);

const KEY_FILTER_ARGUMENTS = 2;

/**
 * The props type declares `propName` as a required observable. Only same-file syntax counts: type
 * literals, interfaces, aliases, intersections, and `Omit`/`Pick` over literal keys.
 */
export function declaresObservableProp(
  propsType: ts.TypeNode,
  propName: string,
  observableTypes: ReadonlySet<string>,
): boolean {
  return declaredObservablePropType(propsType, propName, observableTypes) !== null;
}

/** The declared observable type of `propName`, such as `Observable<string>`, under the same rules. */
export function declaredObservablePropType(
  propsType: ts.TypeNode,
  propName: string,
  observableTypes: ReadonlySet<string>,
): ts.TypeNode | null {
  const verdict = memberVerdict(propsType, { depth: 0, observableTypes, propName });
  return verdict?.kind === "observable" ? verdict.type : null;
}

function memberVerdict(type: ts.TypeNode, query: MemberQuery): MemberVerdict | null {
  if (query.depth > MAX_TYPE_DEPTH) {
    return null;
  }
  const nested = { ...query, depth: query.depth + 1 };
  if (ts.isParenthesizedTypeNode(type)) {
    return memberVerdict(type.type, nested);
  }
  if (ts.isTypeLiteralNode(type)) {
    return literalMemberVerdict(type.members, query);
  }
  if (ts.isIntersectionTypeNode(type)) {
    return intersectionVerdict(type, nested);
  }
  return ts.isTypeReferenceNode(type) ? referenceVerdict(type, nested) : null;
}

function literalMemberVerdict(
  members: ts.NodeArray<ts.TypeElement>,
  query: MemberQuery,
): MemberVerdict | null {
  if (members.some((member) => ts.isIndexSignatureDeclaration(member))) {
    return null;
  }
  const matches = members.filter(
    (member) => member.name && staticPropertyName(member.name) === query.propName,
  );
  const [member] = matches;
  if (!member) {
    return ABSENT;
  }
  return matches.length === 1 &&
    ts.isPropertySignature(member) &&
    member.type &&
    typeNamesObservable(member.type, query.observableTypes)
    ? { kind: "observable", type: member.type }
    : OTHER;
}

/** An intersection keeps every constituent's member, so one observable declaration proves it. */
function intersectionVerdict(
  type: ts.IntersectionTypeNode,
  query: MemberQuery,
): MemberVerdict | null {
  const verdicts = type.types.map((member) => memberVerdict(member, query));
  if (verdicts.some((verdict) => verdict?.kind === "other")) {
    return OTHER;
  }
  const observable = verdicts.find((verdict) => verdict?.kind === "observable");
  if (observable) {
    return observable;
  }
  return verdicts.every((verdict) => verdict?.kind === "absent") ? ABSENT : null;
}

function referenceVerdict(type: ts.TypeReferenceNode, query: MemberQuery): MemberVerdict | null {
  if (!ts.isIdentifier(type.typeName)) {
    return null;
  }
  const sourceFile = type.getSourceFile();
  const declaration = soleTypeDeclaration(sourceFile, type.typeName.text);
  if (declaration) {
    return declarationVerdict(declaration, query);
  }
  return KEY_FILTERS.has(type.typeName.text) && !importsName(sourceFile, type.typeName.text)
    ? keyFilterVerdict(type, query)
    : null;
}

function declarationVerdict(
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  query: MemberQuery,
): MemberVerdict | null {
  if (ts.isTypeAliasDeclaration(declaration)) {
    return memberVerdict(declaration.type, query);
  }
  const verdict = literalMemberVerdict(declaration.members, query);
  return verdict?.kind === "absent" && declaration.heritageClauses?.length ? null : verdict;
}

function keyFilterVerdict(type: ts.TypeReferenceNode, query: MemberQuery): MemberVerdict | null {
  const [source, keys] = type.typeArguments ?? [];
  const names = keys ? literalKeyNames(keys) : null;
  if (!source || !names || type.typeArguments?.length !== KEY_FILTER_ARGUMENTS) {
    return null;
  }
  const kept = names.has(query.propName) === (type.typeName.getText() === "Pick");
  return kept ? memberVerdict(source, query) : ABSENT;
}

function literalKeyNames(type: ts.TypeNode): ReadonlySet<string> | null {
  const members = ts.isUnionTypeNode(type) ? type.types : [type];
  const names = new Set<string>();
  for (const member of members) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      return null;
    }
    names.add(member.literal.text);
  }
  return names;
}

function importsName(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((element) => element.name.text === name),
  );
}
