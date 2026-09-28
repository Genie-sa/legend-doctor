import {
  collectBindingNames,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { UseValueDeclaration } from "./model.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

interface SourceBinding {
  readonly count: number;
  readonly stable: boolean;
}

const bindingsBySource = new WeakMap<ts.SourceFile, ReadonlyMap<string, SourceBinding>>();

/** Primitive path evidence is name-based; never carry it across a second runtime binding. */
export function hasStableIndependentBindings(
  use: Pick<UseValueDeclaration, "call" | "observable">,
): boolean {
  const receiver = rootIdentifier(use.observable);
  const hook = rootIdentifier(use.call.expression);
  return Boolean(
    receiver &&
    hook &&
    hasStableSourceBinding(receiver) &&
    hasStableSourceBinding(hook) &&
    hasStableReceiverFactory(receiver),
  );
}

export function hasStableSourceBinding(identifier: ts.Identifier): boolean {
  const binding = sourceBindings(identifier.getSourceFile()).get(identifier.text);
  return binding?.count === 1 && binding.stable;
}

/** Name-keyed facts about one declaration hold only while no other runtime binding shares its name. */
export function hasSoleSourceBinding(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceBindings(sourceFile).get(name)?.count === 1;
}

function hasStableReceiverFactory(receiver: ts.Identifier): boolean {
  let stable = true;
  visit(receiver.getSourceFile(), (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === receiver.text &&
      node.initializer
    ) {
      const value = unwrapTransparentExpression(node.initializer);
      if (ts.isCallExpression(value)) {
        const factory = rootIdentifier(value.expression);
        stable = Boolean(factory && hasStableSourceBinding(factory));
      }
    }
  });
  return stable;
}

function sourceBindings(sourceFile: ts.SourceFile): ReadonlyMap<string, SourceBinding> {
  const cached = bindingsBySource.get(sourceFile);
  if (cached) {
    return cached;
  }
  const bindings = new Map<string, SourceBinding>();
  const record = (name: string, stable: boolean): void => {
    const previous = bindings.get(name);
    bindings.set(name, { count: (previous?.count ?? 0) + 1, stable: !previous && stable });
  };
  visit(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      const names = new Set<string>();
      collectBindingNames(node.name, names);
      const constant =
        ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        Boolean(node.parent.flags & ts.NodeFlags.Const);
      for (const name of names) {
        record(name, constant);
      }
    } else {
      recordOtherBinding(node, record);
    }
  });
  bindingsBySource.set(sourceFile, bindings);
  return bindings;
}

function recordOtherBinding(node: ts.Node, record: (name: string, stable: boolean) => void): void {
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
    record(node.name.text, true);
  } else if (ts.isImportClause(node) && node.name) {
    record(node.name.text, true);
  } else if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    record(node.name.text, false);
  }
}
