import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import { nodeWithin, visit, visitSkippingNestedRuntimeFunctions } from "../core/ast.js";
import type { StateCandidate } from "../analysis/model.js";
import ts from "typescript";

interface LocalDeclarations {
  readonly callableReactTypes: ReadonlySet<string>;
  readonly types: ReadonlyMap<
    string,
    readonly (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[]
  >;
  readonly values: ReadonlyMap<string, readonly ts.Declaration[]>;
}

const callableStateCache = new WeakMap<StateCandidate, boolean>();
const localDeclarationsCache = new WeakMap<ts.SourceFile, LocalDeclarations>();
const REACT_CALLABLE_TYPE_EXPORTS = new Set([
  "ComponentClass",
  "ComponentType",
  "FC",
  "JSXElementConstructor",
]);

export function stateMayHoldCallable(state: StateCandidate): boolean {
  const cached = callableStateCache.get(state);
  if (cached !== undefined) {
    return cached;
  }
  const sourceFile = state.call.getSourceFile();
  const type = state.call.typeArguments?.[0];
  const callable =
    (type !== undefined && stateTypeMayBeCallable(type, sourceFile)) ||
    lazyInitializerMayReturnCallable(state.call.arguments[0]) ||
    setterMayStoreCallable(state) ||
    stateValueIsUsedAsCallable(state);
  callableStateCache.set(state, callable);
  return callable;
}

export function stateTypeMayBeCallable(
  type: ts.TypeNode,
  sourceFile: ts.SourceFile = type.getSourceFile(),
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) {
    return true;
  }
  if (ts.isTypeReferenceNode(type)) {
    return typeReferenceMayBeCallable(type, sourceFile, seen);
  }
  let callable = false;
  type.forEachChild((child) => {
    if (!callable && ts.isTypeNode(child) && stateTypeMayBeCallable(child, sourceFile, seen)) {
      callable = true;
    }
  });
  return callable;
}

function typeReferenceMayBeCallable(
  type: ts.TypeReferenceNode,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<string>,
): boolean {
  if (type.typeArguments?.some((argument) => stateTypeMayBeCallable(argument, sourceFile, seen))) {
    return true;
  }
  const local = localTypeReferenceCallability(type, sourceFile, seen);
  if (local !== null) {
    return local;
  }
  const name = type.typeName.getText();
  return name === "Function" || localDeclarations(sourceFile).callableReactTypes.has(name);
}

function localTypeReferenceCallability(
  type: ts.TypeReferenceNode,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<string>,
): boolean | null {
  const name = type.typeName.getText();
  if (!ts.isIdentifier(type.typeName) || seen.has(name)) {
    return null;
  }
  const declarations = nearestVisibleDeclarations(
    localDeclarations(sourceFile).types.get(name) ?? [],
    type,
  );
  if (declarations.length > 1) {
    return false;
  }
  const [declaration] = declarations;
  return declaration
    ? declaredTypeMayBeCallable(declaration, sourceFile, new Set(seen).add(name))
    : null;
}

function declaredTypeMayBeCallable(
  declaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
  seen: ReadonlySet<string>,
): boolean {
  if (ts.isTypeAliasDeclaration(declaration)) {
    return stateTypeMayBeCallable(declaration.type, sourceFile, seen);
  }
  return declaration.members.some(
    (member) =>
      ts.isCallSignatureDeclaration(member) ||
      ts.isConstructSignatureDeclaration(member) ||
      ts.isMethodSignature(member) ||
      ((ts.isPropertySignature(member) || ts.isIndexSignatureDeclaration(member)) &&
        member.type !== undefined &&
        stateTypeMayBeCallable(member.type, sourceFile, seen)),
  );
}

function localDeclarations(sourceFile: ts.SourceFile): LocalDeclarations {
  const cached = localDeclarationsCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const callableReactTypes = new Set<string>();
  const types = new Map<string, (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[]>();
  const values = new Map<string, ts.Declaration[]>();
  visit(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      if (isReactModuleImport(node) && node.importClause) {
        collectReactCallableTypeNames(node.importClause, callableReactTypes);
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      appendNamedDeclaration(types, node.name.text, node);
      return;
    }
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      appendNamedDeclaration(values, node.name.text, node);
    }
  });
  const declarations = { callableReactTypes, types, values };
  localDeclarationsCache.set(sourceFile, declarations);
  return declarations;
}

function appendNamedDeclaration<Declaration>(
  index: Map<string, Declaration[]>,
  name: string,
  declaration: Declaration,
): void {
  const matches = index.get(name) ?? [];
  matches.push(declaration);
  index.set(name, matches);
}

function isReactModuleImport(node: ts.ImportDeclaration): boolean {
  return ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "react";
}

function addQualifiedReactTypes(namespace: string, callableReactTypes: Set<string>): void {
  for (const exported of REACT_CALLABLE_TYPE_EXPORTS) {
    callableReactTypes.add(`${namespace}.${exported}`);
  }
}

function collectReactCallableTypeNames(
  importClause: ts.ImportClause,
  callableReactTypes: Set<string>,
): void {
  if (importClause.name) {
    addQualifiedReactTypes(importClause.name.text, callableReactTypes);
  }
  const bindings = importClause.namedBindings;
  if (!bindings) {
    return;
  }
  if (ts.isNamespaceImport(bindings)) {
    addQualifiedReactTypes(bindings.name.text, callableReactTypes);
    return;
  }
  addNamedReactTypes(bindings, callableReactTypes);
}

function addNamedReactTypes(bindings: ts.NamedImports, callableReactTypes: Set<string>): void {
  for (const element of bindings.elements) {
    const exported = element.propertyName?.text ?? element.name.text;
    if (REACT_CALLABLE_TYPE_EXPORTS.has(exported)) {
      callableReactTypes.add(element.name.text);
    }
  }
}

function nearestVisibleDeclarations<Declaration extends ts.Declaration>(
  declarations: readonly Declaration[],
  reference: ts.Node,
): readonly Declaration[] {
  let nearestScope: ts.Node | null = null;
  for (const declaration of declarations) {
    const scope = declarationScope(declaration);
    if (nodeWithin(reference, scope) && (!nearestScope || nodeWithin(scope, nearestScope))) {
      nearestScope = scope;
    }
  }
  return nearestScope === null
    ? []
    : declarations.filter((declaration) => declarationScope(declaration) === nearestScope);
}

function declarationScope(declaration: ts.Declaration): ts.Node {
  for (let node: ts.Node | undefined = declaration.parent; node; node = node.parent) {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      return node;
    }
  }
  return declaration.getSourceFile();
}

function lazyInitializerMayReturnCallable(initializer: ts.Expression | undefined): boolean {
  const value = initializer && unwrapTransparentExpression(initializer);
  return (
    value !== undefined &&
    (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) &&
    callbackMayReturnCallable(value)
  );
}

function setterMayStoreCallable(state: StateCandidate): boolean {
  if (!state.setterName || !state.owner.body) {
    return false;
  }
  let callable = false;
  visit(state.owner.body, (node) => {
    if (
      callable ||
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      node.expression.text !== state.setterName
    ) {
      return;
    }
    const argument = node.arguments[0] && unwrapTransparentExpression(node.arguments[0]);
    callable =
      argument !== undefined &&
      (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
        ? argument.parameters.length === 0 && callbackMayReturnCallable(argument)
        : expressionContainsCallableLiteral(argument));
  });
  return callable;
}

function callbackMayReturnCallable(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  if (!ts.isBlock(callback.body)) {
    return expressionMayBeCallable(callback.body);
  }
  let callable = false;
  visitSkippingNestedRuntimeFunctions(callback.body, (node) => {
    if (
      !callable &&
      ts.isReturnStatement(node) &&
      node.expression &&
      expressionMayBeCallable(node.expression)
    ) {
      callable = true;
    }
  });
  return callable;
}

function expressionMayBeCallable(
  expression: ts.Expression,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isClassExpression(value)) {
    return true;
  }
  if (ts.isIdentifier(value)) {
    return identifierMayBeCallable(value, seen);
  }
  if (ts.isConditionalExpression(value)) {
    return (
      expressionMayBeCallable(value.whenTrue, seen) ||
      expressionMayBeCallable(value.whenFalse, seen)
    );
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return expressionMayBeCallable(value.left, seen) || expressionMayBeCallable(value.right, seen);
  }
  return expressionContainsCallableLiteral(value);
}

function identifierMayBeCallable(value: ts.Identifier, seen: ReadonlySet<string>): boolean {
  if (seen.has(value.text)) {
    return false;
  }
  const declarations = nearestVisibleDeclarations(
    localDeclarations(value.getSourceFile()).values.get(value.text) ?? [],
    value,
  );
  if (declarations.length !== 1) {
    return false;
  }
  const declaration = declarations[0]!;
  if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
    return true;
  }
  const initializer = ts.isVariableDeclaration(declaration) && declaration.initializer;
  return (
    initializer !== false &&
    initializer !== undefined &&
    expressionMayBeCallable(initializer, new Set(seen).add(value.text))
  );
}

function stateValueIsUsedAsCallable(state: StateCandidate): boolean {
  if (!state.owner.body) {
    return false;
  }
  let callable = false;
  visit(state.owner.body, (node) => {
    if (
      callable ||
      !ts.isIdentifier(node) ||
      node.text !== state.valueName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    const { parent } = node;
    callable =
      ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === node) ||
      ((ts.isJsxOpeningElement(parent) ||
        ts.isJsxSelfClosingElement(parent) ||
        ts.isJsxClosingElement(parent)) &&
        parent.tagName === node);
  });
  return callable;
}

function expressionContainsCallableLiteral(expression: ts.Expression): boolean {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isClassExpression(value)) {
    return true;
  }
  if (ts.isConditionalExpression(value)) {
    return (
      expressionContainsCallableLiteral(value.whenTrue) ||
      expressionContainsCallableLiteral(value.whenFalse)
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some(
      (property) =>
        ts.isMethodDeclaration(property) ||
        (ts.isPropertyAssignment(property) &&
          expressionContainsCallableLiteral(property.initializer)),
    );
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) => !ts.isSpreadElement(element) && expressionContainsCallableLiteral(element),
    );
  }
  return false;
}
