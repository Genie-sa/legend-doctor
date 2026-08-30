import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

/**
 * `@oxlint/plugins` narrows `optional` to `false` on binding patterns, but the parser sets it to
 * `true` for `a?: T`, so the flag has to be compared rather than assumed absent.
 */
function isOptionalParameter(parameter: ESTree.ParamPattern): boolean {
  if (parameter.type === "TSParameterProperty") return isOptionalParameter(parameter.parameter);
  return parameter.optional === true;
}

export const noOptionalFunctionParametersRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow optional function parameters; a `?` parameter lets call sites silently omit an input the implementation still has to handle.",
    },
    messages: {
      optionalParameter:
        "Do not declare an optional parameter. Require the argument with an explicit `| undefined` union so every call site decides the value.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        if (!isOptionalParameter(parameter)) continue;
        context.report({ node: parameter, messageId: "optionalParameter" });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
