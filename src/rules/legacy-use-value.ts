import ts from "typescript";

import { collectBindingNames } from "../analysis-ast.js";
import { visit } from "../ast.js";
import type { HookImports } from "../imports.js";
import type { LegendPracticeFinding } from "../types.js";
import { directObservableSelectorPath } from "./observable-reads.js";

const LEGACY_HOOKS = new Set(["useSelector", "use$"]);

export function findLegacyUseValuePractices(
  sourceFile: ts.SourceFile,
  fileName: string,
  imports: HookImports,
  observableBindings: ReadonlySet<string>
): readonly LegendPracticeFinding[] {
  if (imports.legacyUseValue.size === 0 && imports.legendReactNamespaces.size === 0) {
    return [];
  }
  const shadowed = localBindingNames(sourceFile);
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, node => {
    if (!ts.isCallExpression(node) || !isLegacyHookCall(node, imports, shadowed)) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const current = node.expression.getText(sourceFile);
    const directObservable = node.arguments.length === 1
      ? directObservableSelectorPath(node.arguments[0]!, observableBindings)
      : null;
    const preservedArguments = node.arguments.map(argument => argument.getText(sourceFile)).join(", ");
    const replacement = directObservable
      ? `useValue(${directObservable.getText(sourceFile)})`
      : `useValue(${preservedArguments})`;
    findings.push({
      action: "replace-legacy-use-value",
      confidence: "certain",
      disposition: "change",
      evidence: [
        `\`${current}\` resolves to a legacy hook imported from @legendapp/state/react`,
        "Legend State documents useValue as the replacement for useSelector and use$",
      ],
      location: { column: character + 1, file: fileName, line: line + 1 },
      message: directObservable
        ? `Replace \`${current}(...)\` with \`${replacement}\` and update its ` +
          "@legendapp/state/react import; pass the proven observable path directly."
        : `Replace \`${current}(...)\` with \`${replacement}\` and update its ` +
          "@legendapp/state/react import; preserve the selector arguments.",
      practice: "reactivity",
    });
  });
  return findings;
}

function isLegacyHookCall(
  call: ts.CallExpression,
  imports: HookImports,
  shadowed: ReadonlySet<string>
): boolean {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    return imports.legacyUseValue.has(expression.text) && !shadowed.has(expression.text);
  }
  return ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.legendReactNamespaces.has(expression.expression.text) &&
    !shadowed.has(expression.expression.text) &&
    LEGACY_HOOKS.has(expression.name.text);
}

function localBindingNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  visit(sourceFile, node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      collectBindingNames(node.name, names);
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node)) &&
      node.name
    ) {
      names.add(node.name.text);
    }
  });
  return names;
}
