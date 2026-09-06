import {
  bindingIsUnshadowed,
  constInitializer,
  isImportedReactCall,
} from "./binding-resolution.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { localFunctionBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

interface LifecycleResolution {
  readonly owner: RuntimeFunctionLike;
  readonly imports: HookImports;
  readonly seen: ReadonlySet<string>;
}

type LifecycleCallback = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

export function resolveLifecycleCallback(
  expression: ts.Expression,
  resolution: LifecycleResolution,
): LifecycleCallback | null {
  const value = unwrapTransparentExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value;
  }
  if (!ts.isIdentifier(value) || resolution.seen.has(value.text)) {
    return null;
  }
  return (
    localFunctionBinding(resolution.owner, value.text) ?? resolveLifecycleAlias(value, resolution)
  );
}

function resolveLifecycleAlias(
  value: ts.Identifier,
  resolution: LifecycleResolution,
): LifecycleCallback | null {
  const initializer = constInitializer(resolution.owner, value.text);
  if (initializer === null) {
    return null;
  }
  const next = { ...resolution, seen: new Set(resolution.seen).add(value.text) };
  if (ts.isIdentifier(initializer)) {
    return resolveLifecycleCallback(initializer, next);
  }
  if (
    ts.isCallExpression(initializer) &&
    isImportedReactCall(initializer, resolution.imports, "useCallback") &&
    initializer.arguments[0]
  ) {
    return resolveLifecycleCallback(initializer.arguments[0], next);
  }
  return null;
}

function isAbsentDependencyExpression(value: ts.Expression): boolean {
  return value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value);
}

export function hasNoDependencyArray(call: ts.CallExpression): boolean {
  const [, dependency] = call.arguments;
  if (!dependency) {
    return true;
  }
  const value = unwrapTransparentExpression(dependency);
  if (isAbsentDependencyExpression(value)) {
    return true;
  }
  if (!ts.isIdentifier(value) || value.text !== "undefined") {
    return false;
  }
  return bindingIsUnshadowed(call, value.text);
}

export function isReactEffectCall(call: ts.CallExpression, imports: HookImports): boolean {
  return (
    isImportedReactCall(call, imports, "useEffect") ||
    isImportedReactCall(call, imports, "useLayoutEffect") ||
    isImportedReactCall(call, imports, "useInsertionEffect")
  );
}
