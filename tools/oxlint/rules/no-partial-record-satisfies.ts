import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const referenceName = (type: ESTree.TSType): string | null =>
  type.type === "TSTypeReference" && type.typeName.type === "Identifier"
    ? type.typeName.name
    : null;

const typeArguments = (type: ESTree.TSType): ESTree.TSType[] =>
  type.type === "TSTypeReference" ? (type.typeArguments?.params ?? []) : [];

const unwrapType = (type: ESTree.TSType): ESTree.TSType =>
  type.type === "TSParenthesizedType" ? unwrapType(type.typeAnnotation) : type;

const isPartialRecord = (type: ESTree.TSType): boolean => {
  const bare = unwrapType(type);
  if (referenceName(bare) !== "Partial") return false;
  return typeArguments(bare).some((argument) => referenceName(unwrapType(argument)) === "Record");
};

/** `Partial<Record<…>>` still counts when a wrapper such as `Readonly<…>` sits above it. */
const containsPartialRecord = (type: ESTree.TSType): boolean => {
  const bare = unwrapType(type);
  if (isPartialRecord(bare)) return true;
  if (bare.type === "TSUnionType" || bare.type === "TSIntersectionType") {
    return bare.types.some(containsPartialRecord);
  }
  if (bare.type === "TSTypeOperator") return containsPartialRecord(bare.typeAnnotation);
  return typeArguments(bare).some(containsPartialRecord);
};

const unwrapOperand = (expression: ESTree.Expression): ESTree.Expression =>
  expression.type === "TSAsExpression" ||
  expression.type === "TSSatisfiesExpression" ||
  expression.type === "ParenthesizedExpression"
    ? unwrapOperand(expression.expression)
    : expression;

export const noPartialRecordSatisfiesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow checking an object literal against `Partial<Record<K, V>>`; the optional keys turn a missing entry into a silent gap instead of a compile error.",
    },
    messages: {
      partialRecordSatisfies:
        "Do not use `satisfies Partial<Record<K, V>>` on an object literal. Satisfy the total `Record<K, V>` so a new key of `K` fails to compile, or narrow `K` to the subset the literal really covers.",
    },
  },
  createOnce(context) {
    return {
      TSSatisfiesExpression(node) {
        if (unwrapOperand(node.expression).type !== "ObjectExpression") return;
        if (!containsPartialRecord(node.typeAnnotation)) return;
        context.report({ node, messageId: "partialRecordSatisfies" });
      },
    };
  },
});
