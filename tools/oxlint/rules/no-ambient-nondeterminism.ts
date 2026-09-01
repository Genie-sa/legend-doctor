import { defineRule } from "@oxlint/plugins";
import type { Context, Definition, ESTree, Scope, Variable } from "@oxlint/plugins";

const AMBIENT_ACCESSORS = new Set([
  "Date.now",
  "Math.random",
  "performance.now",
  "crypto.randomUUID",
]);
const AMBIENT_NODE_CRYPTO_IMPORTS = new Set(["randomUUID"]);
const NODE_CRYPTO_SOURCES = new Set(["node:crypto", "crypto"]);
const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "window", "self"]);

type MemberChain = { readonly root: ESTree.IdentifierReference; readonly names: readonly string[] };

function unwrap(node: ESTree.Expression): ESTree.Expression {
  return node.type === "ParenthesizedExpression" ? unwrap(node.expression) : node;
}

function memberChain(node: ESTree.Expression): MemberChain | null {
  const expression = unwrap(node);
  if (expression.type === "Identifier") {
    return { root: expression, names: [expression.name] };
  }
  if (expression.type !== "MemberExpression" || expression.computed) return null;
  const object = memberChain(expression.object);
  if (object === null) return null;
  return { root: object.root, names: [...object.names, expression.property.name] };
}

function accessorOf(chain: MemberChain): string | null {
  const [head, ...rest] = chain.names;
  const names = head !== undefined && GLOBAL_OBJECT_NAMES.has(head) ? rest : chain.names;
  const accessor = names.join(".");
  return AMBIENT_ACCESSORS.has(accessor) ? accessor : null;
}

/**
 * A local binding of the same name is a different value than the global, so it suppresses the
 * report. Implicit globals carry no definitions, which is what separates them from a shadow.
 */
function localBinding(context: Context, node: ESTree.IdentifierReference): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined && variable.defs.length > 0) return variable;
    scope = scope.upper;
  }
  return null;
}

function importedAmbientName(definition: Definition): string | null {
  const declaration = definition.parent;
  if (
    definition.node.type !== "ImportSpecifier" ||
    declaration === null ||
    declaration.type !== "ImportDeclaration" ||
    !NODE_CRYPTO_SOURCES.has(declaration.source.value)
  ) {
    return null;
  }
  const imported = definition.node.imported;
  const name = imported.type === "Identifier" ? imported.name : imported.value;
  return AMBIENT_NODE_CRYPTO_IMPORTS.has(name) ? name : null;
}

function aliasedAccessor(definition: Definition): string | null {
  if (definition.node.type !== "VariableDeclarator" || definition.node.init === null) return null;
  const chain = memberChain(definition.node.init);
  return chain === null ? null : accessorOf(chain);
}

function bindingAccessor(context: Context, node: ESTree.IdentifierReference): string | null {
  const variable = localBinding(context, node);
  if (variable === null) return null;
  for (const definition of variable.defs) {
    const imported = importedAmbientName(definition);
    if (imported !== null) return `${imported}()`;
    const aliased = aliasedAccessor(definition);
    if (aliased !== null) return aliased;
  }
  return null;
}

export const noAmbientNondeterminismRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading ambient time or randomness; a function that consults the wall clock or the entropy pool cannot be reproduced or asserted on.",
    },
    messages: {
      ambientNondeterminism:
        "`{{source}}` reads ambient nondeterminism, so this code cannot be reproduced or tested. Take the value as a parameter — a clock, seed, or id factory supplied by the caller.",
    },
  },
  createOnce(context) {
    const report = (node: ESTree.CallExpression | ESTree.NewExpression, source: string) => {
      context.report({ node, messageId: "ambientNondeterminism", data: { source } });
    };

    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type === "Identifier") {
          const source = bindingAccessor(context, callee);
          if (source !== null) report(node, source);
          return;
        }
        const chain = memberChain(callee);
        if (chain === null || localBinding(context, chain.root) !== null) return;
        const accessor = accessorOf(chain);
        if (accessor !== null) report(node, accessor);
      },

      NewExpression(node) {
        const callee = unwrap(node.callee);
        if (
          callee.type !== "Identifier" ||
          callee.name !== "Date" ||
          node.arguments.length > 0 ||
          localBinding(context, callee) !== null
        ) {
          return;
        }
        report(node, "new Date()");
      },
    };
  },
});
