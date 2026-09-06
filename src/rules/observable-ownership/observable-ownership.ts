import type { LegendFactory, ObservableOwnershipScan } from "./model.js";
import { bindingDeclarationCount, rootIdentifier } from "../../core/analysis-ast.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { nestedObservableArgumentFinding } from "./nested-observable-arguments.js";
import ts from "typescript";
import { writtenComputedInitializerFinding } from "./written-computed-initializers.js";

export type { ObservableOwnershipScan } from "./model.js";

const NAMESPACE_FACTORIES = new Map<string, LegendFactory>([
  ["observable", "observable"],
  ["useObservable", "useObservable"],
]);

export function findObservableOwnershipPractices(
  scan: ObservableOwnershipScan,
): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const factory = legendFactoryCallKind(node, scan.imports);
    if (!factory) {
      return;
    }
    const finding =
      nestedObservableArgumentFinding(node, factory, scan) ??
      (factory === "useObservable" ? writtenComputedInitializerFinding(node, scan) : null);
    if (finding) {
      findings.push(finding);
    }
  });
  return findings;
}

function legendFactoryCallKind(
  call: ts.CallExpression,
  imports: HookImports,
): LegendFactory | null {
  const factory = importedFactoryKind(call.expression, imports);
  if (!factory) {
    return null;
  }
  const root = rootIdentifier(call.expression);
  const owner = findAncestor(call, isRuntimeFunctionLike);
  const shadowed = root !== null && owner !== null && bindingDeclarationCount(owner, root.text) > 0;
  return shadowed ? null : factory;
}

function importedFactoryKind(callee: ts.Expression, imports: HookImports): LegendFactory | null {
  if (ts.isIdentifier(callee)) {
    return localFactoryKind(callee.text, imports);
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return null;
  }
  const factory = NAMESPACE_FACTORIES.get(callee.name.text) ?? null;
  const namespaces =
    factory === "observable" ? imports.legendNamespaces : imports.legendReactNamespaces;
  return factory && namespaces.has(callee.expression.text) ? factory : null;
}

function localFactoryKind(name: string, imports: HookImports): LegendFactory | null {
  if (imports.observable.has(name)) {
    return "observable";
  }
  return imports.useObservable.has(name) ? "useObservable" : null;
}
