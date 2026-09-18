import type { DerivedMemo, ObservableMemoInput } from "./derived-memos.js";
import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import { hasPureRenderOwner } from "./migration-owner.js";
import ts from "typescript";

/** Separate semantic safety from a witnessed many-to-one projection. No helper summaries are assumed. */
export function migrationProofGap(memo: DerivedMemo, imports: HookImports): string | null {
  const expression = callbackExpression(memo);
  const inputs = new Set(memo.inputs.map((input) => input.localName));
  if (!expression || !isTotalExpression(expression, inputs)) {
    return "callback purity and complete dependencies are unproven; calls, property reads, coercion, and arbitrary statements can add tracking, effects, or throws";
  }
  const domain =
    memo.inputs.length === 1 ? stableInputDomain(memo.inputs[0]!, memo, imports) : null;
  if (!domain) {
    return "stable observable identity and a broad string or number input domain are unproven";
  }
  if (!hasPureRenderOwner(memo)) {
    return "owner render/commit equivalence is unproven; effects, refs, child components, observer wrappers, and exported or escaped owners need source review";
  }
  return hasEqualityBenefit(expression, memo.inputs[0]!.localName, domain)
    ? null
    : "no many-to-one equality benefit is proven; primitive output alone does not establish a saved render";
}

function callbackExpression(memo: DerivedMemo): ts.Expression | undefined {
  const { body } = memo.callback;
  if (!ts.isBlock(body)) {
    return body;
  }
  return body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!)
    ? body.statements[0]!.expression
    : undefined;
}

function hasEqualityBenefit(expression: ts.Expression, inputName: string, domain: Domain): boolean {
  const comparison = unwrapTransparentExpression(expression);
  if (ts.isBinaryExpression(comparison) && isStrictComparison(comparison)) {
    const left = unwrapTransparentExpression(comparison.left);
    const right = unwrapTransparentExpression(comparison.right);
    if (
      (ts.isIdentifier(left) && left.text === inputName && literalDomain(right) === domain) ||
      (ts.isIdentifier(right) && right.text === inputName && literalDomain(left) === domain)
    ) {
      return true;
    }
  }
  return false;
}

function isStrictComparison(expression: ts.BinaryExpression): boolean {
  return (
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

/** Strict equality does not invoke coercion, getters, or user code, even for unexpected operand values. */
function isTotalExpression(expression: ts.Expression, inputs: ReadonlySet<string>): boolean {
  const value = unwrapTransparentExpression(expression);
  if (
    literalDomain(value) ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(value)) {
    return inputs.has(value.text);
  }
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    return isTotalExpression(value.operand, inputs);
  }
  return (
    ts.isBinaryExpression(value) &&
    isStrictComparison(value) &&
    isTotalExpression(value.left, inputs) &&
    isTotalExpression(value.right, inputs)
  );
}

type Domain = "string" | "number";

function literalDomain(expression: ts.Expression): Domain | null {
  if (ts.isStringLiteralLike(expression)) {
    return "string";
  }
  if (ts.isNumericLiteral(expression)) {
    return "number";
  }
  return null;
}

/** Only module const factories have a mount-stable identity here; props and local factories need a separate proof. */
function stableInputDomain(
  input: ObservableMemoInput,
  memo: DerivedMemo,
  imports: HookImports,
): Domain | null {
  let root = input.observable;
  const path: string[] = [];
  while (ts.isPropertyAccessExpression(root)) {
    path.unshift(root.name.text);
    root = root.expression;
  }
  if (!ts.isIdentifier(root) || !unshadowedRoot(root.text, memo)) {
    return null;
  }
  const declaration = moduleDeclaration(root);
  return declaration ? declarationDomain(declaration, path, imports) : null;
}

function unshadowedRoot(name: string, memo: DerivedMemo): boolean {
  for (let scope = memo.owner; ;) {
    if (bindingDeclarationCount(scope, name) !== 0) {
      return false;
    }
    const outer = findAncestor(scope, isRuntimeFunctionLike);
    if (!outer) {
      break;
    }
    scope = outer;
  }
  return true;
}

function moduleDeclaration(root: ts.Identifier): ts.VariableDeclaration | undefined {
  return root
    .getSourceFile()
    .statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((node) => ts.isIdentifier(node.name) && node.name.text === root.text);
}

function declarationDomain(
  declaration: ts.VariableDeclaration,
  path: readonly string[],
  imports: HookImports,
): Domain | null {
  if (
    !declaration.initializer ||
    declaration.type ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return null;
  }
  const call = unwrapTransparentExpression(declaration.initializer);
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isObservableFactory(call.expression, imports)
  ) {
    return null;
  }
  // Assertions and explicit narrow/unknown generics cannot establish the broad inferred domain.
  if (declaration.initializer !== call) {
    return null;
  }
  return call.typeArguments?.length
    ? explicitDomain(call, path)
    : initialDomain(call.arguments[0]!, path);
}

function explicitDomain(call: ts.CallExpression, path: readonly string[]): Domain | null {
  const type = call.typeArguments![0]!;
  if (path.length > 0 || call.typeArguments!.length !== 1) {
    return null;
  }
  if (type.kind !== ts.SyntaxKind.StringKeyword && type.kind !== ts.SyntaxKind.NumberKeyword) {
    return null;
  }
  return type.kind === ts.SyntaxKind.StringKeyword ? "string" : "number";
}

function initialDomain(initial: ts.Expression, path: readonly string[]): Domain | null {
  let value = initial;
  for (const member of path) {
    // Avoid accessors, computed keys, spreads, duplicate members, and prototype setters.
    if (
      !ts.isObjectLiteralExpression(value) ||
      !value.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          property.name.text !== "__proto__",
      )
    ) {
      return null;
    }
    const matches = value.properties.filter(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === member,
    );
    if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0]!)) {
      return null;
    }
    value = matches[0]!.initializer;
  }
  return literalDomain(value);
}

function isObservableFactory(callee: ts.Expression, imports: HookImports): boolean {
  return (
    (ts.isIdentifier(callee) && imports.observable.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      imports.legendNamespaces.has(callee.expression.text) &&
      callee.name.text === "observable")
  );
}
