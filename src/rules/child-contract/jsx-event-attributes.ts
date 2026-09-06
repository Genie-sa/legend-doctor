import type { CallbackTrace, ChildComponentSource } from "./model.js";
import {
  atJsxInvocation,
  jsxAttributeDirectlyCarries,
  jsxOwnerIsDeferredEventTarget,
  jsxOwnerTarget,
} from "./jsx-owner.js";
import { climbTransparentExpression } from "./carried-values.js";
import { deeperTrace } from "./model.js";
import ts from "typescript";

export function jsxAttributeCarriesCallbackIdentity(
  attribute: ts.JsxAttribute,
  callback: ts.Expression,
): boolean {
  let value = climbTransparentExpression(callback);
  if (
    ts.isConditionalExpression(value.parent) &&
    (value.parent.whenTrue === value || value.parent.whenFalse === value)
  ) {
    value = value.parent;
  }
  return jsxAttributeDirectlyCarries(attribute, value);
}

export function jsxEventAttributeIsDeferred(
  attribute: ts.JsxAttribute,
  source: ChildComponentSource,
  trace: CallbackTrace,
): boolean {
  const { resolver } = trace;
  if (jsxOwnerIsDeferredEventTarget(attribute, source)) {
    return true;
  }
  const target = jsxOwnerTarget(attribute);
  if (target && resolver.frameworkEventComponent(source.file, target)) {
    return true;
  }
  const child = target ? resolver.resolveComponent(source.file, target) : null;
  return (
    child !== null &&
    trace.deferral.sourceInput({
      argumentIndex: 0,
      path: [attribute.name.getText()],
      source: atJsxInvocation(child, attribute, source),
      trace: deeperTrace(trace, null),
    })
  );
}
