import { defineRule } from "@oxlint/plugins";
import type { Context, Definition, ESTree, Scope, Variable } from "@oxlint/plugins";

const PATH_MODULE_SOURCES = new Set([
  "path",
  "node:path",
  "path/posix",
  "path/win32",
  "node:path/posix",
  "node:path/win32",
]);
const PATH_BUILDING_FUNCTIONS = new Set(["resolve", "normalize", "join"]);
const TRAILING_SEPARATOR = /[/\\]$/u;

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

function importSource(definition: Definition): string | null {
  const declaration = definition.parent;
  if (declaration === null || declaration.type !== "ImportDeclaration") return null;
  return PATH_MODULE_SOURCES.has(declaration.source.value) ? declaration.source.value : null;
}

/**
 * The provenance gate: only a binding that node:path itself produced counts. A local object that
 * merely owns a `resolve` method, or a plain string variable named `path`, must not qualify.
 */
function isPathNamespace(context: Context, node: ESTree.IdentifierReference): boolean {
  const variable = localBinding(context, node);
  if (variable === null) return false;
  return variable.defs.some(
    (definition) =>
      importSource(definition) !== null &&
      (definition.node.type === "ImportDefaultSpecifier" ||
        definition.node.type === "ImportNamespaceSpecifier"),
  );
}

function pathMemberName(context: Context, node: ESTree.IdentifierReference): string | null {
  const variable = localBinding(context, node);
  if (variable === null) return null;
  for (const definition of variable.defs) {
    if (importSource(definition) === null || definition.node.type !== "ImportSpecifier") continue;
    const imported = definition.node.imported;
    return imported.type === "Identifier" ? imported.name : imported.value;
  }
  return null;
}

function pathMemberOf(context: Context, node: ESTree.Expression): string | null {
  const expression = unwrap(node);
  if (expression.type === "Identifier") return pathMemberName(context, expression);
  if (expression.type !== "MemberExpression" || expression.computed) return null;
  const object = unwrap(expression.object);
  if (object.type !== "Identifier" || !isPathNamespace(context, object)) return null;
  return expression.property.name;
}

function isPathBuildingCall(context: Context, node: ESTree.Expression): boolean {
  const expression = unwrap(node);
  if (expression.type !== "CallExpression") return false;
  const member = pathMemberOf(context, expression.callee);
  return member !== null && PATH_BUILDING_FUNCTIONS.has(member);
}

function isPathDerived(context: Context, node: ESTree.Expression): boolean {
  const expression = unwrap(node);
  if (isPathBuildingCall(context, expression)) return true;
  if (expression.type !== "Identifier") return false;
  const variable = localBinding(context, expression);
  return (
    variable !== null &&
    variable.defs.some(
      (definition) =>
        definition.node.type === "VariableDeclarator" &&
        definition.node.init !== null &&
        isPathBuildingCall(context, definition.node.init),
    )
  );
}

function isSeparator(context: Context, node: ESTree.Expression): boolean {
  return pathMemberOf(context, node) === "sep";
}

/** A prefix that ends at a separator cannot match a sibling: `/safe/root-backup` fails it. */
function endsAtBoundary(context: Context, node: ESTree.Expression): boolean {
  const expression = unwrap(node);
  if (isSeparator(context, expression)) return true;
  if (expression.type === "Literal") {
    return typeof expression.value === "string" && TRAILING_SEPARATOR.test(expression.value);
  }
  if (expression.type === "BinaryExpression" && expression.operator === "+") {
    return endsAtBoundary(context, expression.right);
  }
  if (expression.type !== "TemplateLiteral") return false;
  const tail = expression.quasis.at(-1);
  const cooked = tail?.value.cooked ?? tail?.value.raw ?? "";
  if (cooked !== "") return TRAILING_SEPARATOR.test(cooked);
  const last = expression.expressions.at(-1);
  return last !== undefined && isSeparator(context, last);
}

export const noPathPrefixContainmentRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow proving filesystem containment with a bare string prefix; `startsWith` accepts sibling paths that share the prefix.",
    },
    messages: {
      prefixContainment:
        "A string prefix does not prove containment: `/safe/root-backup` passes `startsWith('/safe/root')`. Compare `path.relative(root, candidate)` and reject results that are absolute or start with `..`, or terminate the prefix with `path.sep`.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.name !== "startsWith" ||
          node.arguments.length !== 1
        ) {
          return;
        }
        const [prefix] = node.arguments;
        if (prefix === undefined || prefix.type === "SpreadElement") return;
        if (!isPathDerived(context, callee.object)) return;
        if (endsAtBoundary(context, prefix)) return;
        context.report({ node, messageId: "prefixContainment" });
      },
    };
  },
});
