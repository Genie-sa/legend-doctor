// Vendored from stella (https://github.com/stella/stella, Apache-2.0, see
// ./LICENSE) and modified: the plugin wrapper was replaced with a `rules`
// export, and the `Bun.file()` receiver carve-out was removed because Bun is
// not a runtime or a dependency of this Node CLI.
//
// Forbid `.catch(() => <literal>)` — the sanctioned way to drop a rejection.
//
// A `.catch(() => null)` satisfies every floating-promise check while
// discarding the rejection: a transient failure becomes indistinguishable from
// a legitimate empty result.
//
// Flagged: a `.catch(...)` callback whose whole body is a literal-ish value
// (`undefined`, `null`, a boolean/string/number, an empty object/array, an
// empty template) or an empty block.
//
//   promise.catch(() => null);
//   promise.catch(() => undefined);
//   promise.catch(() => {});
//   promise.catch(() => { /* fire-and-forget */ });
//   promise.catch(() => "");
//
// Allowed receivers (`ALLOWED_RECEIVER_METHODS`) — two classes where the
// fallback is the whole point of the call and the rejection carries no
// information the caller does not already have:
//
//   - Response body consumption (`json`, `text`, `arrayBuffer`, `blob`,
//     `bytes`, `formData`). The caller is reading a body it already knows may
//     be absent or malformed, usually to enrich an error it is about to
//     report; the fallback IS the handling.
//   - Resource teardown (`cancel`, `close`, `abort`). Cancelling a stream
//     reader or closing a handle during unwind cannot be retried or reported
//     usefully, and letting it reject would mask the original failure.
//
//   await reader.cancel().catch(() => undefined);
//   const detail = await response.text().catch(() => "");
//
// Everything else must handle the rejection: capture it, surface it, or
// propagate it. A `.catch` callback with a real body — logging, capture, state
// reset — is untouched by this rule.

import { isAstNode, isIdentifier, type AstNode } from "./utils.ts";

const ALLOWED_RECEIVER_METHODS = new Set([
  // Response body consumption.
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
  "json",
  "text",
  // Resource teardown.
  "abort",
  "cancel",
  "close",
]);

const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

const unwrap = (node: unknown): AstNode | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (
    node.type === "ChainExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return unwrap(node.expression);
  }
  return node;
};

// A value carrying no information about the failure it stands in for.
const isLiteralValue = (node: unknown): boolean => {
  const value = unwrap(node);
  if (value === null) {
    return false;
  }
  switch (value.type) {
    case "Literal":
      return true;
    case "Identifier":
      return isIdentifier(value, "undefined");
    case "ObjectExpression":
      return Array.isArray(value.properties) && value.properties.length === 0;
    case "ArrayExpression":
      return Array.isArray(value.elements) && value.elements.length === 0;
    case "TemplateLiteral":
      return Array.isArray(value.expressions) && value.expressions.length === 0;
    case "UnaryExpression":
      // `-1`, `+0`: still a bare constant.
      return isLiteralValue(value.argument);
    default:
      return false;
  }
};

// True when the callback does nothing but yield a constant.
const swallowsRejection = (handler: AstNode): boolean => {
  const body = unwrap(handler.body);
  if (body === null) {
    return false;
  }
  if (body.type !== "BlockStatement") {
    return isLiteralValue(body);
  }
  const statements = Array.isArray(body.body) ? body.body : [];
  if (statements.length === 0) {
    return true;
  }
  if (statements.length > 1) {
    return false;
  }
  const [only] = statements;
  if (!isAstNode(only) || only.type !== "ReturnStatement") {
    return false;
  }
  return only.argument === null || isLiteralValue(only.argument);
};

// The method whose result the `.catch` is attached to, e.g. `cancel` for
// `reader.cancel().catch(...)`. Null when the receiver is not a method call.
const receiverMethodName = (calleeObject: unknown): string | null => {
  const receiver = unwrap(calleeObject);
  if (receiver === null || receiver.type !== "CallExpression") {
    return null;
  }
  const callee = unwrap(receiver.callee);
  if (
    callee === null ||
    callee.type !== "MemberExpression" ||
    callee.computed !== false ||
    !isIdentifier(callee.property)
  ) {
    return null;
  }
  return callee.property.name;
};

export const rules = {
    "no-swallowed-rejection": {
      meta: {
        type: "problem",
        messages: {
          swallowedRejection:
            "This `.catch` discards the rejection and returns a constant, so a transient failure is indistinguishable from a real result. Log or capture the error and return the fallback, or surface the rejection to the caller.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = unwrap(node.callee);
            if (
              callee === null ||
              callee.type !== "MemberExpression" ||
              callee.computed !== false ||
              !isIdentifier(callee.property, "catch")
            ) {
              return;
            }

            const [handler] = Array.isArray(node.arguments)
              ? node.arguments
              : [];
            if (
              !isAstNode(handler) ||
              !FUNCTION_NODE_TYPES.has(handler.type) ||
              !swallowsRejection(handler)
            ) {
              return;
            }

            const method = receiverMethodName(callee.object);
            if (method !== null && ALLOWED_RECEIVER_METHODS.has(method)) {
              return;
            }

            context.report({ node: handler, messageId: "swallowedRejection" });
          },
        };
      },
    },
};
