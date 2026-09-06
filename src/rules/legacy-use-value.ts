import type { HookImports } from "../core/imports.js";
import type { InstalledLegendState } from "../project/legend-state-package.js";
import type { LegendPracticeFinding } from "../core/types.js";
import { collectBindingNames } from "../core/analysis-ast.js";
import { directObservableSelectorPath } from "./observable-reads/use-value-inputs.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

const LEGACY_HOOKS = new Set(["useSelector", "use$"]);

export interface LegacyUseValueScan {
  readonly fileName: string;
  readonly imports: HookImports;
  readonly installedLegendState?: InstalledLegendState | null;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

export function findLegacyUseValuePractices({
  fileName,
  imports,
  installedLegendState = null,
  observableBindings,
  sourceFile,
}: LegacyUseValueScan): readonly LegendPracticeFinding[] {
  if (imports.legacyUseValue.size === 0 && imports.legendReactNamespaces.size === 0) {
    return [];
  }
  const shadowed = localBindingNames(sourceFile);
  const findings: LegendPracticeFinding[] = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isLegacyHookCall(node, imports, shadowed)) {
      return;
    }
    findings.push(
      legacyUseValueFinding({
        call: node,
        fileName,
        installedLegendState,
        observableBindings,
        sourceFile,
      }),
    );
  });
  return findings;
}

interface LegacyUseValueCall {
  readonly call: ts.CallExpression;
  readonly fileName: string;
  readonly installedLegendState: InstalledLegendState | null;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

function legacyUseValueFinding(context: LegacyUseValueCall): LegendPracticeFinding {
  const { call, fileName, installedLegendState, observableBindings, sourceFile } = context;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  const current = call.expression.getText(sourceFile);
  const directObservable =
    call.arguments.length === 1
      ? directObservableSelectorPath(call.arguments[0]!, observableBindings)
      : null;
  const preservedArguments = call.arguments
    .map((argument) => argument.getText(sourceFile))
    .join(", ");
  const replacement = directObservable
    ? `useValue(${directObservable.getText(sourceFile)})`
    : `useValue(${preservedArguments})`;
  return {
    action: "replace-legacy-use-value",
    confidence: "certain",
    disposition: installedLegendState?.useValueExport === "alias" ? "style" : "change",
    evidence: [
      `\`${current}\` resolves to a legacy hook imported from @legendapp/state/react`,
      "Legend State documents useValue as the replacement for useSelector and use$",
      ...installedUseValueEvidence(installedLegendState),
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: directObservable
      ? `Replace \`${current}(...)\` with \`${replacement}\` and update its ` +
        "@legendapp/state/react import; pass the proven observable path directly."
      : `Replace \`${current}(...)\` with \`${replacement}\` and update its ` +
        "@legendapp/state/react import; preserve the selector arguments.",
    practice: "reactivity",
  };
}

function installedUseValueEvidence(installed: InstalledLegendState | null): string[] {
  if (!installed) {
    return [];
  }
  if (installed.useValueExport === "alias") {
    return [
      `useValue is an alias of useSelector in the installed @legendapp/state@${installed.version}; ` +
        "this rename is a consistency change with no runtime effect",
    ];
  }
  if (installed.useValueExport === "distinct") {
    return [
      `useValue and useSelector are distinct exports in the installed @legendapp/state@${installed.version}; ` +
        "verify the documented behavior difference before and after replacing",
    ];
  }
  return [
    `the installed @legendapp/state@${installed.version} react type declarations could not be resolved; ` +
      "confirm useValue exists there before replacing",
  ];
}

function isLegacyHookCall(
  call: ts.CallExpression,
  imports: HookImports,
  shadowed: ReadonlySet<string>,
): boolean {
  const { expression } = call;
  if (ts.isIdentifier(expression)) {
    return imports.legacyUseValue.has(expression.text) && !shadowed.has(expression.text);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.legendReactNamespaces.has(expression.expression.text) &&
    !shadowed.has(expression.expression.text) &&
    LEGACY_HOOKS.has(expression.name.text)
  );
}

function localBindingNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  visit(sourceFile, (node) => {
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
