import type { StateCandidate, StateUsage } from "../../analysis/model.js";
import { accessPathsEqual, renderedRecordEntry } from "./rendered-record-entries.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import { LIST_SIZED_OWNER_JSX_ELEMENTS } from "./model.js";
import { exactRecordEntryUpdaterKey } from "./record-updater-keys.js";
import { jsxElementCount } from "../state-proofs/jsx-subtrees.js";
import { primitiveScalarType } from "./state-value-shapes.js";
import { stateMayHoldCallable } from "../state-proofs/state-proofs.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { visit } from "../../core/ast.js";
import { writtenRecordEntry } from "./written-record-entries.js";

const RECORD_TYPE_ARGUMENT_COUNT = 2;

export function isKeyedLeafRecordState(
  state: StateCandidate,
  usage: StateUsage | undefined,
  childContracts: ChildContractResolver | null,
): boolean {
  if (
    !usage ||
    !state.setterName ||
    !state.owner.body ||
    !isEmptyPrimitiveRecordState(state) ||
    jsxElementCount(state.owner) < LIST_SIZED_OWNER_JSX_ELEMENTS ||
    usage.directRenderNodes.length === 0 ||
    usage.localRenderReads !== usage.directRenderNodes.length ||
    usage.effectReads > 0 ||
    usage.effectWrites > 0 ||
    usage.deferredReads > 0 ||
    usage.transportedOccurrences > 0 ||
    usage.setterCalls === 0 ||
    usage.setterReferences !== usage.setterCalls ||
    usage.shadowed ||
    usage.escaped
  ) {
    return false;
  }

  const rendered = renderedRecordEntry(state, usage.directRenderNodes);
  if (!rendered) {
    return false;
  }
  return usage.setterCallNodes.every((call) => {
    const key = exactRecordEntryUpdaterKey(call);
    const written = key && writtenRecordEntry({ call, childContracts, key, state });
    return (
      written !== null &&
      written.repeated === rendered.repeated &&
      accessPathsEqual(written.path, rendered.path)
    );
  });
}

function isEmptyPrimitiveRecordState(state: StateCandidate): boolean {
  const [initial] = state.call.arguments;
  const initialValue = initial && unwrapTransparentExpression(initial);
  const type = state.call.typeArguments?.[0];
  if (
    !initialValue ||
    !ts.isObjectLiteralExpression(initialValue) ||
    initialValue.properties.length > 0 ||
    !type ||
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName) ||
    type.typeName.text !== "Record" ||
    type.typeArguments?.length !== RECORD_TYPE_ARGUMENT_COUNT ||
    sourceDeclaresTypeName(state.call.getSourceFile(), "Record") ||
    !recordKeyTypeIsSupported(type.typeArguments[0]!) ||
    !primitiveRecordValueType(type.typeArguments[1]!, state.call.getSourceFile(), new Set())
  ) {
    return false;
  }
  return !stateMayHoldCallable(state);
}

function sourceDeclaresTypeName(sourceFile: ts.SourceFile, name: string): boolean {
  let declared = false;
  visit(sourceFile, (node) => {
    if (declared) {
      return;
    }
    if (
      ((ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
        node.name?.text === name) ||
      (ts.isTypeParameterDeclaration(node) && node.name.text === name) ||
      (ts.isImportSpecifier(node) && node.name.text === name) ||
      (ts.isImportClause(node) && node.name?.text === name) ||
      (ts.isNamespaceImport(node) && node.name.text === name)
    ) {
      declared = true;
    }
  });
  return declared;
}

function recordKeyTypeIsSupported(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type)) {
    return recordKeyTypeIsSupported(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every(recordKeyTypeIsSupported);
  }
  if (ts.isLiteralTypeNode(type)) {
    return ts.isStringLiteralLike(type.literal) || ts.isNumericLiteral(type.literal);
  }
  return type.kind === ts.SyntaxKind.StringKeyword || type.kind === ts.SyntaxKind.NumberKeyword;
}

function primitiveRecordValueType(
  type: ts.TypeNode,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<string>,
): boolean {
  if (primitiveScalarType(type)) {
    return true;
  }
  if (
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName) ||
    type.typeArguments?.length
  ) {
    return false;
  }
  const name = type.typeName.text;
  if (seen.has(name)) {
    return false;
  }
  const alias = soleTypeAlias(sourceFile, name);
  return (
    alias !== null &&
    !alias.typeParameters?.length &&
    primitiveRecordValueType(alias.type, sourceFile, new Set(seen).add(name))
  );
}

function soleTypeAlias(sourceFile: ts.SourceFile, name: string): ts.TypeAliasDeclaration | null {
  const aliases: ts.TypeAliasDeclaration[] = [];
  visit(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      aliases.push(node);
    }
  });
  return aliases.length === 1 ? aliases[0]! : null;
}
