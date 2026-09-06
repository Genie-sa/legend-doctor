import type { HookReturnMember } from "../child-contract/model.js";
import ts from "typescript";

export function consumerBindingName(
  pattern: ts.BindingName,
  member: HookReturnMember,
): string | "unsupported" | null {
  if (member.kind === "self") {
    return ts.isIdentifier(pattern) ? pattern.text : "unsupported";
  }
  if (member.kind === "index") {
    return ts.isArrayBindingPattern(pattern)
      ? elementBindingName(pattern.elements[member.index])
      : "unsupported";
  }
  if (!ts.isObjectBindingPattern(pattern)) {
    return "unsupported";
  }
  if (pattern.elements.some((element) => element.dotDotDotToken)) {
    return "unsupported";
  }
  const element = pattern.elements.find(
    (candidate) => bindingSourceName(candidate) === member.name,
  );
  return element ? elementBindingName(element) : null;
}

function elementBindingName(
  element: ts.ArrayBindingElement | undefined,
): string | "unsupported" | null {
  if (!element || ts.isOmittedExpression(element)) {
    return null;
  }
  return !element.dotDotDotToken && !element.initializer && ts.isIdentifier(element.name)
    ? element.name.text
    : "unsupported";
}

function bindingSourceName(element: ts.BindingElement): string | null {
  const source = element.propertyName ?? element.name;
  return ts.isIdentifier(source) ? source.text : null;
}
