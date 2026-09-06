import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

interface DraftSeed {
  readonly object: ts.ObjectLiteralExpression;
  readonly typeName: string;
}

const MINIMUM_DRAFT_PROPERTIES = 2;

const MAXIMUM_DRAFT_PROPERTIES = 8;

export function typedStringDraftProperties(state: StateCandidate): ReadonlySet<string> | null {
  const seed = draftSeedDeclaration(state);
  if (!seed) {
    return null;
  }
  const names = draftTypeStringProperties(state, seed.typeName, seed.object.properties.length);
  return names && seededPropertiesMatchNames(seed.object, names) ? names : null;
}

function draftSeedDeclaration(state: StateCandidate): DraftSeed | null {
  const [initialArgument] = state.call.arguments;
  const initial = initialArgument && unwrapTransparentExpression(initialArgument);
  if (!initial || !ts.isIdentifier(initial)) {
    return null;
  }
  const declarations = moduleVariableDeclarations(state.call.getSourceFile(), initial.text);
  const declaration = declarations.length === 1 ? declarations[0] : null;
  const object = declaration?.initializer && unwrapTransparentExpression(declaration.initializer);
  if (
    !declaration?.type ||
    !ts.isTypeReferenceNode(declaration.type) ||
    !ts.isIdentifier(declaration.type.typeName) ||
    !object ||
    !ts.isObjectLiteralExpression(object) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    object.properties.length < MINIMUM_DRAFT_PROPERTIES ||
    object.properties.length > MAXIMUM_DRAFT_PROPERTIES ||
    !moduleConstantOnlySeedsState(state, declaration, initial.text)
  ) {
    return null;
  }
  return { object, typeName: declaration.type.typeName.text };
}

function moduleVariableDeclarations(
  sourceFile: ts.SourceFile,
  name: string,
): readonly ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        declarations.push(declaration);
      }
    }
  }
  return declarations;
}

function draftTypeStringProperties(
  state: StateCandidate,
  typeName: string,
  propertyCount: number,
): ReadonlySet<string> | null {
  const types = state.call
    .getSourceFile()
    .statements.filter(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === typeName,
    );
  const type = types.length === 1 ? types[0] : null;
  if (
    !type ||
    type.members.length !== propertyCount ||
    type.members.some((member) => !isRequiredStringPropertySignature(member))
  ) {
    return null;
  }
  const names = new Set(
    type.members.map((member) =>
      // SAFETY: Every member passed isRequiredStringPropertySignature above, so each
      // PropertySignature here has a statically named property.
      (member as ts.PropertySignature).name.getText().replaceAll(/^['"]|['"]$/gu, ""),
    ),
  );
  return names.size === type.members.length ? names : null;
}

function isRequiredStringPropertySignature(member: ts.TypeElement): boolean {
  return (
    ts.isPropertySignature(member) &&
    member.questionToken === undefined &&
    member.type?.kind === ts.SyntaxKind.StringKeyword &&
    member.name !== undefined &&
    (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
  );
}

function seededPropertiesMatchNames(
  object: ts.ObjectLiteralExpression,
  names: ReadonlySet<string>,
): boolean {
  return object.properties.every((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
    ) {
      return false;
    }
    return (
      names.has(property.name.text) &&
      ts.isStringLiteralLike(unwrapTransparentExpression(property.initializer))
    );
  });
}

function moduleConstantOnlySeedsState(
  state: StateCandidate,
  declaration: ts.VariableDeclaration,
  name: string,
): boolean {
  let safe = true;
  visit(state.call.getSourceFile(), (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      node === declaration.name ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    if (isDeclarationName(node)) {
      safe = false;
      return;
    }
    const call = node.parent;
    safe =
      ts.isCallExpression(call) &&
      call.arguments[0] === node &&
      call.expression.getText() === state.call.expression.getText();
  });
  return safe;
}
