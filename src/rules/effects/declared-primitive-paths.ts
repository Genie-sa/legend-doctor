import {
  declaredTypeMembers,
  primitiveValueType,
  soleTypeDeclaration,
  staticPropertyName,
  unwrapParenthesizedType,
} from "../child-contract/declared-prop-types.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

/**
 * Whether the owner's parameter types declare a dependency path, rooted at the binding
 * `declaration` declares, a primitive or a union of primitives. A pure owner that React reruns
 * after a render-phase update computes such a value again, and the edit's `Object.is` guard finds
 * it equal, `NaN` included.
 */
export function declaresComparablePrimitive(
  dependency: ts.Expression,
  declaration: ts.Node,
  owner: RuntimeFunctionLike,
): boolean {
  const type = declaredPathType(dependency, declaration, owner);
  return type !== null && comparesByValue(type, new Set());
}

function declaredPathType(
  path: ts.Expression,
  declaration: ts.Node,
  owner: RuntimeFunctionLike,
): ts.TypeNode | null {
  const node = unwrapTransparentExpression(path);
  if (ts.isIdentifier(node)) {
    return parameterBindingType(node.text, declaration, owner);
  }
  if (!ts.isPropertyAccessExpression(node)) {
    return null;
  }
  const parent = declaredPathType(node.expression, declaration, owner);
  return parent && memberType(parent, node.name.text);
}

/** A parameter's declared type, or a field a `const` destructures from such a parameter. */
function parameterBindingType(
  name: string,
  declaration: ts.Node,
  owner: RuntimeFunctionLike,
): ts.TypeNode | null {
  if (ts.isParameter(declaration)) {
    return declaration.parent === owner && declaration.type
      ? patternType(declaration.name, name, declaration.type)
      : null;
  }
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isObjectBindingPattern(declaration.name) ||
    !declaration.initializer ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const source = unwrapTransparentExpression(declaration.initializer);
  const binding = ts.isIdentifier(source) ? lexicalBinding(source) : null;
  const sourceType =
    binding?.kind === "value" && ts.isIdentifier(source)
      ? parameterBindingType(source.text, binding.declaration, owner)
      : null;
  return sourceType && patternType(declaration.name, name, sourceType);
}

function patternType(pattern: ts.BindingName, name: string, type: ts.TypeNode): ts.TypeNode | null {
  if (ts.isIdentifier(pattern)) {
    return pattern.text === name ? type : null;
  }
  if (!ts.isObjectBindingPattern(pattern)) {
    return null;
  }
  for (const element of pattern.elements) {
    const found = elementType(element, name, type);
    if (found) {
      return found;
    }
  }
  return null;
}

function elementType(
  element: ts.BindingElement,
  name: string,
  type: ts.TypeNode,
): ts.TypeNode | null {
  const key = element.dotDotDotToken ? null : elementKey(element);
  const fieldType = key === null ? null : memberType(type, key);
  return fieldType && patternType(element.name, name, fieldType);
}

function elementKey(element: ts.BindingElement): string | null {
  if (element.propertyName) {
    return staticPropertyName(element.propertyName);
  }
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

function memberType(type: ts.TypeNode, name: string): ts.TypeNode | null {
  const members = typeMembers(unwrapParenthesizedType(type));
  if (!members) {
    return null;
  }
  const properties = members.filter(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && staticPropertyName(member.name) === name,
  );
  const [property] = properties;
  return properties.length === 1 && property?.type ? property.type : null;
}

function typeMembers(type: ts.TypeNode): ts.NodeArray<ts.TypeElement> | null {
  if (ts.isTypeLiteralNode(type)) {
    return type.members;
  }
  const declaration = localTypeDeclaration(type);
  return declaration ? declaredTypeMembers(declaration) : null;
}

/** The sole non-generic interface or type alias in this file that a bare type reference names. */
function localTypeDeclaration(
  type: ts.TypeNode,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeArguments) {
    return null;
  }
  const declaration = soleTypeDeclaration(type.getSourceFile(), type.typeName.text);
  return declaration && !declaration.typeParameters ? declaration : null;
}

function comparesByValue(type: ts.TypeNode, seen: ReadonlySet<ts.TypeNode>): boolean {
  const current = unwrapParenthesizedType(type);
  if (seen.has(current)) {
    return false;
  }
  const visited = new Set([...seen, current]);
  if (ts.isUnionTypeNode(current)) {
    return current.types.every((member) => comparesByValue(member, visited));
  }
  const declaration = localTypeDeclaration(current);
  if (declaration) {
    return ts.isTypeAliasDeclaration(declaration) && comparesByValue(declaration.type, visited);
  }
  return primitiveValueType(current);
}
