import type {
  IdentityContext,
  IdentityScope,
  NamedBinding,
  PropIdentity,
} from "./identity-model.js";
import {
  PRIMITIVE_OPERATORS,
  STABLE,
  bindingDeclaration,
  defaultedBindingIdentity,
  eitherIdentity,
  fresh,
  freshAllocation,
  isPrimitiveLiteral,
  settled,
  unproven,
} from "./identity-model.js";
import { hookIdentity, hookResultIdentity } from "./hook-identity.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { nodeWithin, visit } from "../../core/ast.js";
import type { LexicalBinding } from "../../core/lexical-bindings.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

type DeclaredBinding = Exclude<LexicalBinding, { kind: "ambient" } | { kind: "import" }>;

const OPERAND_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** The identity a render of the owner gives this expression when none of its inputs changed. */
export function expressionIdentity(
  expression: ts.Expression,
  context: IdentityContext,
): PropIdentity {
  return identityOf(expression, {
    ...context,
    depth: 0,
    evaluate: identityOf,
    parameters: null,
    visiting: new Set(),
  });
}

/** Identifiers in `node` bound in the owner's render scope but declared outside `node` itself. */
export function freeOwnerIdentifiers(
  node: ts.Node,
  owner: RuntimeFunctionLike,
): readonly ts.Identifier[] {
  const free: ts.Identifier[] = [];
  visit(node, (candidate) => {
    if (
      !ts.isIdentifier(candidate) ||
      isNonValueIdentifier(candidate) ||
      isDeclarationName(candidate)
    ) {
      return;
    }
    const declaration = bindingDeclaration(lexicalBinding(candidate));
    if (declaration && nodeWithin(declaration, owner) && !nodeWithin(declaration, node)) {
      free.push(candidate);
    }
  });
  return free;
}

function identityOf(expression: ts.Expression, scope: IdentityScope): PropIdentity {
  const value = unwrapTransparentExpression(expression);
  const allocation = freshAllocation(value);
  if (allocation) {
    return fresh(allocation, value);
  }
  return leafIdentity(value, scope) ?? compositeIdentity(value, scope);
}

function leafIdentity(value: ts.Expression, scope: IdentityScope): PropIdentity | null {
  if (isPrimitiveLiteral(value)) {
    return STABLE;
  }
  if (ts.isIdentifier(value)) {
    return identifierIdentity(value, scope);
  }
  if (ts.isPropertyAccessExpression(value)) {
    return value.name.text === "current"
      ? unproven("a ref's current value, which can change without a render")
      : settled(identityOf(value.expression, scope));
  }
  return ts.isElementAccessExpression(value)
    ? allStable([value.expression, value.argumentExpression], scope)
    : null;
}

function compositeIdentity(value: ts.Expression, scope: IdentityScope): PropIdentity {
  if (ts.isBinaryExpression(value)) {
    return binaryIdentity(value, scope);
  }
  if (ts.isConditionalExpression(value)) {
    const condition = settled(identityOf(value.condition, scope));
    return condition.kind === "stable"
      ? eitherIdentity(identityOf(value.whenTrue, scope), identityOf(value.whenFalse, scope))
      : condition;
  }
  if (ts.isCallExpression(value)) {
    return hookIdentity(value, scope);
  }
  return (
    primitiveOperationIdentity(value, scope) ?? unproven("an expression outside the modeled subset")
  );
}

function primitiveOperationIdentity(
  value: ts.Expression,
  scope: IdentityScope,
): PropIdentity | null {
  if (ts.isTemplateExpression(value)) {
    return allStable(
      value.templateSpans.map((span) => span.expression),
      scope,
    );
  }
  if (ts.isPrefixUnaryExpression(value)) {
    return settled(identityOf(value.operand, scope));
  }
  return ts.isTypeOfExpression(value) || ts.isVoidExpression(value)
    ? settled(identityOf(value.expression, scope))
    : null;
}

function binaryIdentity(value: ts.BinaryExpression, scope: IdentityScope): PropIdentity {
  const operator = value.operatorToken.kind;
  if (PRIMITIVE_OPERATORS.has(operator)) {
    return allStable([value.left, value.right], scope);
  }
  if (OPERAND_OPERATORS.has(operator)) {
    const left = identityOf(value.left, scope);
    return left.kind === "unproven" ? left : eitherIdentity(left, identityOf(value.right, scope));
  }
  return operator === ts.SyntaxKind.CommaToken
    ? identityOf(value.right, scope)
    : unproven("an assignment or bitwise expression");
}

/** A primitive derived from operands keeps its value exactly when every operand does. */
function allStable(expressions: readonly ts.Expression[], scope: IdentityScope): PropIdentity {
  for (const expression of expressions) {
    const identity = settled(identityOf(expression, scope));
    if (identity.kind !== "stable") {
      return identity;
    }
  }
  return STABLE;
}

function identifierIdentity(identifier: ts.Identifier, scope: IdentityScope): PropIdentity {
  const binding = lexicalBinding(identifier);
  if (binding === null || binding.kind === "import" || binding.kind === "ambient") {
    return STABLE;
  }
  return nodeWithin(binding.declaration, scope.owner)
    ? ownerBindingIdentity(identifier.text, binding, scope)
    : outerBindingIdentity(binding.declaration);
}

function ownerBindingIdentity(
  name: string,
  binding: DeclaredBinding,
  scope: IdentityScope,
): PropIdentity {
  const { declaration } = binding;
  if (binding.kind === "function") {
    const memo = ts.isCallExpression(declaration.parent) ? declaration.parent : null;
    return memo ? hookIdentity(memo, scope) : fresh("function", declaration);
  }
  if (ts.isParameter(declaration)) {
    return parameterIdentity(name, declaration, scope);
  }
  return ts.isVariableDeclaration(declaration)
    ? variableIdentity({ name, pattern: declaration.name }, declaration, scope)
    : unproven("a loop or catch binding");
}

function outerBindingIdentity(declaration: ts.Node): PropIdentity {
  if (ts.isVariableDeclaration(declaration)) {
    const isModuleConst =
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isSourceFile(declaration.parent.parent.parent);
    return isModuleConst ? STABLE : unproven("a mutable or enclosing binding");
  }
  return ts.isParameter(declaration) ? unproven("a parameter of an enclosing function") : STABLE;
}

/** A prop keeps its identity on an owner-only render; a hook parameter carries its argument's. */
function parameterIdentity(
  name: string,
  declaration: ts.ParameterDeclaration,
  scope: IdentityScope,
): PropIdentity {
  if (declaration.parent !== scope.owner) {
    return unproven("a parameter of a nested function");
  }
  return scope.parameters
    ? scope.parameters(declaration, name)
    : defaultedBindingIdentity({ name, pattern: declaration.name }, declaration.initializer);
}

function variableIdentity(
  binding: NamedBinding,
  declaration: ts.VariableDeclaration,
  scope: IdentityScope,
): PropIdentity {
  const initializer = constInitializer(declaration);
  if (!initializer || scope.visiting.has(declaration)) {
    return unproven("a mutable or self-referencing binding");
  }
  const nested: IdentityScope = { ...scope, visiting: new Set(scope.visiting).add(declaration) };
  if (ts.isCallExpression(initializer)) {
    return hookResultIdentity(binding, initializer, nested);
  }
  if (ts.isIdentifier(binding.pattern)) {
    return identityOf(initializer, nested);
  }
  const source = settled(identityOf(initializer, nested));
  return source.kind === "stable" ? defaultedBindingIdentity(binding) : source;
}

function constInitializer(declaration: ts.VariableDeclaration): ts.Expression | null {
  const list = declaration.parent;
  const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
  return isConst && declaration.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
}
