import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree, Scope, Variable } from "@oxlint/plugins";

const EXEMPT_DIRECTORY = /(?:^|[\\/])(?:tests|scripts)[\\/]/u;
const EXEMPT_FILE = /\.(?:test|spec)\.[^.\\/]+$/u;
const UNCOMMITTED_TYPES = new Set(["TSUnknownKeyword", "TSAnyKeyword", "TSNeverKeyword"]);

function unwrap(node: ESTree.Expression): ESTree.Expression {
  return node.type === "ParenthesizedExpression" ? unwrap(node.expression) : node;
}

function localBinding(context: Context, node: ESTree.IdentifierReference): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined && variable.defs.length > 0) return variable;
    scope = scope.upper;
  }
  return null;
}

/** Tests and one-off scripts sit outside the production boundary this rule defends. */
function isProductionFile(filename: string): boolean {
  return !EXEMPT_DIRECTORY.test(filename) && !EXEMPT_FILE.test(filename);
}

/** A type the code commits to. `unknown` and friends keep the obligation to validate visible. */
function isDomainType(type: ESTree.TSType): boolean {
  if (UNCOMMITTED_TYPES.has(type.type)) return false;
  return !(
    type.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    type.typeName.name === "const"
  );
}

function isJsonProducingCall(context: Context, node: ESTree.CallExpression): boolean {
  const callee = unwrap(node.callee);
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  if (callee.property.name === "json" && node.arguments.length === 0) return true;
  const object = unwrap(callee.object);
  return (
    callee.property.name === "parse" &&
    object.type === "Identifier" &&
    object.name === "JSON" &&
    localBinding(context, object) === null
  );
}

function isJsonSourced(context: Context, node: ESTree.Expression): boolean {
  const expression = unwrap(node);
  if (expression.type === "AwaitExpression") return isJsonSourced(context, expression.argument);
  if (expression.type === "TSAsExpression" || expression.type === "TSNonNullExpression") {
    return isJsonSourced(context, expression.expression);
  }
  if (expression.type === "CallExpression") return isJsonProducingCall(context, expression);
  if (expression.type !== "Identifier") return false;
  const variable = localBinding(context, expression);
  return (
    variable !== null &&
    variable.defs.some(
      (definition) =>
        definition.node.type === "VariableDeclarator" &&
        definition.node.id.type === "Identifier" &&
        definition.node.init !== null &&
        isJsonSourced(context, definition.node.init),
    )
  );
}

function enclosingReturnType(node: ESTree.ReturnStatement): ESTree.TSType | null {
  let current: ESTree.Node = node.parent;
  for (;;) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    ) {
      return current.returnType?.typeAnnotation ?? null;
    }
    if (current.type === "Program") return null;
    current = current.parent;
  }
}

/** True when `node` names a binding destructured out of an unvalidated JSON cast. */
function isDestructuredFromJsonCast(context: Context, node: ESTree.IdentifierReference): boolean {
  const variable = localBinding(context, node);
  if (variable === null) return false;
  return variable.defs.some((definition) => {
    if (definition.node.type !== "VariableDeclarator" || definition.node.init === null)
      return false;
    const { id, init } = definition.node;
    if (id.type !== "ObjectPattern" && id.type !== "ArrayPattern") return false;
    const initializer = unwrap(init);
    return initializer.type === "TSAsExpression" && isJsonSourced(context, initializer.expression);
  });
}

export const noUnvalidatedJsonDomainCastRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow asserting unvalidated JSON into a domain type; the parser proves nothing about the shape the assertion claims.",
    },
    messages: {
      unvalidatedCast:
        "Parsed JSON is untrusted input, so this assertion claims a shape nothing checked. Validate the value at the boundary with a schema or a type-guard and use the validated result.",
      unvalidatedReturn:
        "This return value comes out of an unvalidated JSON cast, so the declared return type is unproven. Validate the parsed payload before returning any part of it.",
    },
  },
  createOnce(context) {
    const checkCast = (node: ESTree.TSAsExpression | ESTree.TSTypeAssertion) => {
      if (!isProductionFile(context.filename)) return;
      if (!isDomainType(node.typeAnnotation)) return;
      if (!isJsonSourced(context, node.expression)) return;
      context.report({ node, messageId: "unvalidatedCast" });
    };

    return {
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,

      ReturnStatement(node) {
        if (!isProductionFile(context.filename)) return;
        const argument = node.argument === null ? null : unwrap(node.argument);
        if (argument === null || argument.type !== "Identifier") return;
        const returnType = enclosingReturnType(node);
        if (returnType === null || !isDomainType(returnType)) return;
        if (!isDestructuredFromJsonCast(context, argument)) return;
        context.report({ node, messageId: "unvalidatedReturn" });
      },
    };
  },
});
