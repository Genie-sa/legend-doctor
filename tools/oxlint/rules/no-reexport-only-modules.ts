import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * A re-export forwards another module's bindings in a single statement: `export * from`,
 * `export * as ns from`, and `export { x } from` (value or type-only). A bare `export { x }`
 * is excluded because it publishes local bindings and names no source module, so a module
 * built only from those still owns what it exports.
 */
function isReexport(statement: ESTree.Directive | ESTree.Statement): boolean {
  return (
    statement.type === "ExportAllDeclaration" ||
    (statement.type === "ExportNamedDeclaration" && statement.source !== null)
  );
}

/**
 * Original implementation of the barrel-module ban popularized by
 * typeonce-dev/ai-automation (that repository is unlicensed, so its
 * source is not vendored here).
 */
export const noReexportOnlyModulesRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow modules whose only responsibility is re-exporting other modules.",
    },
    messages: {
      reexportOnly:
        "This module only re-exports other modules. Import from the owning module directly, or add this intentional public entrypoint as an exact lint override.",
    },
  },
  createOnce(context) {
    return {
      Program(program) {
        if (program.body.length === 0 || !program.body.every(isReexport)) return;
        context.report({ node: program, messageId: "reexportOnly" });
      },
    };
  },
});
