import ts from "typescript";

import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../analysis-ast.js";
import { nodeWithin, visit, visitSkippingNestedRuntimeFunctions } from "../ast.js";
import type { StateCandidate } from "../analyze-source.js";

interface LocalDeclarations {
  readonly callableReactTypes: ReadonlySet<string>;
  readonly types: ReadonlyMap<
    string,
    readonly (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[]
  >;
  readonly values: ReadonlyMap<string, readonly ts.Declaration[]>;
}

const callableStateCache = new WeakMap<StateCandidate, boolean>(),
  localDeclarationsCache = new WeakMap<ts.SourceFile, LocalDeclarations>(),
  REACT_CALLABLE_TYPE_EXPORTS = new Set([
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
  const sourceFile = state.call.getSourceFile(),
    type = state.call.typeArguments?.[0],
    callable =
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
    const name = type.typeName.getText();
    if (
      type.typeArguments?.some((argument) => stateTypeMayBeCallable(argument, sourceFile, seen))
    ) {
      return true;
    }
    const locals = localDeclarations(sourceFile);
    if (ts.isIdentifier(type.typeName) && !seen.has(name)) {
      const declarations = nearestVisibleDeclarations(locals.types.get(name) ?? [], type);
      if (declarations.length > 1) {
        return false;
      }
      const declaration = declarations[0];
      if (declaration) {
        const nextSeen = new Set(seen).add(name);
        if (ts.isTypeAliasDeclaration(declaration)) {
          return stateTypeMayBeCallable(declaration.type, sourceFile, nextSeen);
        }
        return declaration.members.some(
          (member) =>
            ts.isCallSignatureDeclaration(member) ||
            ts.isConstructSignatureDeclaration(member) ||
            ts.isMethodSignature(member) ||
            ((ts.isPropertySignature(member) || ts.isIndexSignatureDeclaration(member)) &&
              member.type !== undefined &&
              stateTypeMayBeCallable(member.type, sourceFile, nextSeen)),
        );
      }
    }
    return name === "Function" || locals.callableReactTypes.has(name);
  }
  let callable = false;
  type.forEachChild((child) => {
    if (!callable && ts.isTypeNode(child) && stateTypeMayBeCallable(child, sourceFile, seen)) {
      callable = true;
    }
  });
  return callable;
}

function localDeclarations(sourceFile: ts.SourceFile): LocalDeclarations {
  const cached = localDeclarationsCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const callableReactTypes = new Set<string>(),
    types = new Map<string, (ts.TypeAliasDeclaration | ts.InterfaceDeclaration)[]>(),
    values = new Map<string, ts.Declaration[]>();
  visit(sourceFile, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "react" &&
      node.importClause
    ) {
      const addQualifiedTypes = (namespace: string): void => {
        for (const exported of REACT_CALLABLE_TYPE_EXPORTS) {
          callableReactTypes.add(`${namespace}.${exported}`);
        }
      };
      if (node.importClause.name) {
        addQualifiedTypes(node.importClause.name.text);
      }
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        addQualifiedTypes(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const exported = element.propertyName?.text ?? element.name.text;
          if (REACT_CALLABLE_TYPE_EXPORTS.has(exported)) {
            callableReactTypes.add(element.name.text);
          }
        }
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const matches = types.get(node.name.text) ?? [];
      matches.push(node);
      types.set(node.name.text, matches);
      return;
    }
    if (
      !ts.isVariableDeclaration(node) &&
      !ts.isFunctionDeclaration(node) &&
      !ts.isClassDeclaration(node)
    ) {
      return;
    }
    if (!node.name || !ts.isIdentifier(node.name)) {
      return;
    }
    const matches = values.get(node.name.text) ?? [];
    matches.push(node);
    values.set(node.name.text, matches);
  });
  const declarations = { callableReactTypes, types, values };
  localDeclarationsCache.set(sourceFile, declarations);
  return declarations;
}

function nearestVisibleDeclarations<Declaration extends ts.Declaration>(
  declarations: readonly Declaration[],
  reference: ts.Node,
): readonly Declaration[] {
  let nearestScope: ts.Node | null = null;
  const matches: Declaration[] = [];
  for (const declaration of declarations) {
    const scope = declarationScope(declaration);
    if (!nodeWithin(reference, scope)) {
      continue;
    }
    if (!nearestScope || nodeWithin(scope, nearestScope)) {
      if (scope !== nearestScope) {
        matches.length = 0;
      }
      nearestScope = scope;
      matches.push(declaration);
    } else if (scope === nearestScope) {
      matches.push(declaration);
    }
  }
  return matches;
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
