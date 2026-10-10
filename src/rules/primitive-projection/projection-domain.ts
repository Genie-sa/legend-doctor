import type { DomainValues, ValueSource } from "./value-domains.js";
import { declarationSource, sourceDomainValues, typeSource } from "./value-domains.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import { staticPropertyPath, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { HookImports } from "../../core/imports.js";
import type { ObservableContextReader } from "../../project/source-components/observable-contexts.js";
import { declaredObservablePropType } from "../../practices/observable-prop-types.js";
import { hasSoleSourceBinding } from "../observable-reads/independent-subscription-bindings.js";
import { isConstDeclaration } from "../../core/binding-references.js";
import { staticPropertyName } from "../child-contract/declared-prop-types.js";
import ts from "typescript";

export interface DomainFacts {
  readonly contextReaders: ReadonlyMap<string, ObservableContextReader>;
  /** Exported declarations of the observables this file imports, keyed by local name. */
  readonly importedDeclarations: ReadonlyMap<string, ts.VariableDeclaration>;
  readonly imports: HookImports;
  readonly sourceFile: ts.SourceFile;
}

type DeclarationName = ts.Identifier & {
  readonly parent:
    | ts.BindingElement
    | ts.ImportClause
    | ts.ImportSpecifier
    | ts.ParameterDeclaration
    | ts.VariableDeclaration;
};

const MAX_ALIAS_DEPTH = 4;

/**
 * The value source of an observable path, from its sole declaration: an imported or local
 * `observable(...)`/`useObservable(...)`, an `Observable<T>` annotation, a typed prop, or a member
 * of a context value whose declared type names it `Observable<T>`.
 */
export function observableValueSource(path: ts.Expression, facts: DomainFacts): ValueSource | null {
  return pathSource(staticPropertyPath(path), facts, 0);
}

export function observableDomainValues(
  path: ts.Expression,
  facts: DomainFacts,
): DomainValues | null {
  const source = observableValueSource(path, facts);
  return source ? sourceDomainValues(source) : null;
}

function pathSource(
  path: readonly string[] | null,
  facts: DomainFacts,
  depth: number,
): ValueSource | null {
  const [root, ...members] = path ?? [];
  const name =
    root !== undefined && depth <= MAX_ALIAS_DEPTH && hasSoleSourceBinding(facts.sourceFile, root)
      ? soleDeclarationName(facts.sourceFile, root)
      : null;
  return name ? declarationNameSource(name, members, { depth, facts }) : null;
}

interface AliasScope {
  readonly depth: number;
  readonly facts: DomainFacts;
}

function declarationNameSource(
  name: DeclarationName,
  members: readonly string[],
  scope: AliasScope,
): ValueSource | null {
  const { parent } = name;
  const { facts } = scope;
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent)) {
    const declaration = facts.importedDeclarations.get(name.text);
    return declaration ? declarationSource(declaration, members) : null;
  }
  if (ts.isBindingElement(parent)) {
    return declaredSource(bindingElementType(parent, facts), members);
  }
  return ts.isParameter(parent)
    ? declaredSource(annotatedType(parent.type, facts.imports.observableTypes), members)
    : variableSource(parent, members, scope);
}

function variableSource(
  declaration: ts.VariableDeclaration,
  members: readonly string[],
  { depth, facts }: AliasScope,
): ValueSource | null {
  if (declaration.type) {
    return declaredSource(annotatedType(declaration.type, facts.imports.observableTypes), members);
  }
  const initializer =
    declaration.initializer && isConstDeclaration(declaration)
      ? unwrapTransparentExpression(declaration.initializer)
      : null;
  if (!initializer || ts.isCallExpression(initializer)) {
    return initializer ? declarationSource(declaration, members) : null;
  }
  const propType = ts.isPropertyAccessExpression(initializer)
    ? typedPropType(initializer.expression, initializer.name.text, facts)
    : null;
  if (propType) {
    return declaredSource(propType, members);
  }
  const alias = staticPropertyPath(initializer);
  return alias ? pathSource([...alias, ...members], facts, depth + 1) : null;
}

function bindingElementType(element: ts.BindingElement, facts: DomainFacts): ts.TypeNode | null {
  const pattern = element.parent;
  const propName = element.propertyName
    ? staticPropertyName(element.propertyName)
    : element.name.getText();
  if (
    element.dotDotDotToken ||
    element.initializer ||
    propName === null ||
    !ts.isObjectBindingPattern(pattern)
  ) {
    return null;
  }
  const holder = pattern.parent;
  return ts.isParameter(holder)
    ? parameterPropType(holder, propName, facts)
    : destructuredSourceType(holder, propName, facts);
}

function parameterPropType(
  parameter: ts.ParameterDeclaration,
  propName: string,
  facts: DomainFacts,
): ts.TypeNode | null {
  const { observableTypes } = facts.imports;
  return parameter.type
    ? observableArgument(
        declaredObservablePropType(parameter.type, propName, observableTypes),
        observableTypes,
      )
    : null;
}

function destructuredSourceType(
  holder: ts.BindingElement | ts.VariableDeclaration,
  propName: string,
  facts: DomainFacts,
): ts.TypeNode | null {
  const source =
    ts.isVariableDeclaration(holder) && holder.initializer
      ? unwrapTransparentExpression(holder.initializer)
      : null;
  if (source && ts.isIdentifier(source)) {
    return typedPropType(source, propName, facts);
  }
  return source && ts.isCallExpression(source) ? contextMemberType(source, propName, facts) : null;
}

function contextMemberType(
  call: ts.CallExpression,
  propName: string,
  facts: DomainFacts,
): ts.TypeNode | null {
  const callee = unwrapTransparentExpression(call.expression);
  const reader = ts.isIdentifier(callee) ? facts.contextReaders.get(callee.text) : undefined;
  return reader?.kind === "hook" &&
    ts.isIdentifier(callee) &&
    hasSoleSourceBinding(facts.sourceFile, callee.text)
    ? observableArgument(
        declaredObservablePropType(reader.value, propName, reader.observableTypes),
        reader.observableTypes,
      )
    : null;
}

/** `props.value$` or `const { value$ } = props` from a typed, never reassigned props parameter. */
function typedPropType(
  props: ts.Expression,
  propName: string,
  facts: DomainFacts,
): ts.TypeNode | null {
  if (!ts.isIdentifier(props)) {
    return null;
  }
  const owner = findAncestor(props, isRuntimeFunctionLike);
  const parameter = owner?.parameters.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === props.text,
  );
  return parameter?.type && hasSoleSourceBinding(facts.sourceFile, props.text)
    ? observableArgument(
        declaredObservablePropType(parameter.type, propName, facts.imports.observableTypes),
        facts.imports.observableTypes,
      )
    : null;
}

function annotatedType(
  type: ts.TypeNode | undefined,
  observableTypes: ReadonlySet<string>,
): ts.TypeNode | null {
  return type ? observableArgument(type, observableTypes) : null;
}

/** `Observable<T>` (or another Legend observable type with one argument) to `T`. */
function observableArgument(
  type: ts.TypeNode | null,
  observableTypes: ReadonlySet<string>,
): ts.TypeNode | null {
  if (
    !type ||
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName) ||
    !observableTypes.has(type.typeName.text) ||
    type.typeArguments?.length !== 1
  ) {
    return null;
  }
  return type.typeArguments[0] ?? null;
}

function declaredSource(type: ts.TypeNode | null, members: readonly string[]): ValueSource | null {
  return type ? typeSource(type, members) : null;
}

function soleDeclarationName(sourceFile: ts.SourceFile, name: string): DeclarationName | null {
  const names: DeclarationName[] = [];
  visit(sourceFile, (node) => {
    if (ts.isIdentifier(node) && node.text === name && isDeclarationName(node)) {
      names.push(node);
    }
  });
  const [sole] = names;
  return names.length === 1 && sole ? sole : null;
}

function isDeclarationName(node: ts.Identifier): node is DeclarationName {
  const { parent } = node;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isParameter(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent)) &&
    parent.name === node
  );
}
