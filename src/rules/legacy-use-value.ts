import { findAncestor, isRuntimeFunctionLike, visit } from "../core/ast.js";
import { isCompilerHookName, isReactCompilerUnit } from "../core/react-compiler-units.js";
import { legendReactImports, namedImportElements } from "../core/use-value-import.js";
import type { HookImports } from "../core/imports.js";
import type { LegendPracticeFinding } from "../core/types.js";
import { collectBindingNames } from "../core/analysis-ast.js";
import { directObservableSelectorPath } from "./observable-reads/use-value-inputs.js";
import { legacyUseValueEdits } from "./legacy-use-value-edits.js";
import ts from "typescript";
import { withEdits } from "../core/text-edits.js";

const LEGACY_HOOKS = new Set(["useSelector", "use$"]);

export interface LegacyUseValueScan {
  readonly fileName: string;
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  /** The project's React Compiler config covers this file. */
  readonly reactCompiler: boolean;
  readonly sourceFile: ts.SourceFile;
}

export function findLegacyUseValuePractices({
  fileName,
  imports,
  observableBindings,
  reactCompiler,
  sourceFile,
}: LegacyUseValueScan): readonly LegendPracticeFinding[] {
  if (imports.legacyUseValue.size === 0 && imports.legendReactNamespaces.size === 0) {
    return [];
  }
  const shadowed = localBindingNames(sourceFile);
  const calls: ts.CallExpression[] = [];
  visit(sourceFile, (node) => {
    if (ts.isCallExpression(node) && isLegacyHookCall(node, imports, shadowed)) {
      calls.push(node);
    }
  });
  const edits = legacyUseValueEdits({
    calls,
    observableBindings,
    source: { fileName, sourceFile },
  });
  return calls.map((call) =>
    withEdits(
      legacyUseValueFinding({
        call,
        compilerMemoizes: reactCompiler && compilerMemoizesCall(call),
        fileName,
        observableBindings,
        sourceFile,
      }),
      edits.get(call) ?? null,
    ),
  );
}

interface LegacyUseValueCall {
  readonly call: ts.CallExpression;
  /** The React Compiler compiles the calling component or hook and does not treat the callee as a hook. */
  readonly compilerMemoizes: boolean;
  readonly fileName: string;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

function legacyUseValueFinding(context: LegacyUseValueCall): LegendPracticeFinding {
  const { call, compilerMemoizes, fileName, observableBindings, sourceFile } = context;
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
  const instruction = directObservable
    ? `Replace \`${current}(...)\` with \`${replacement}\` and update its ` +
      "@legendapp/state/react import; pass the proven observable path directly."
    : `Replace \`${current}(...)\` with \`${replacement}\` and update its ` +
      "@legendapp/state/react import; preserve the selector arguments.";
  return {
    action: "replace-legacy-use-value",
    confidence: "certain",
    disposition: compilerMemoizes ? "change" : "style",
    evidence: [
      `\`${current}\` resolves to a legacy hook imported from @legendapp/state/react`,
      "Legend State deprecates useSelector and use$ in favor of useValue and will remove them in a later version",
      compilerMemoizes
        ? `the React Compiler compiles the calling component or hook and gives hook semantics only to callees named /^use[A-Z0-9]/, which \`${current}\` is not, so it can cache this call's result instead of running the subscription on every render`
        : "useValue is an alias of useSelector, so this rename is a consistency change with no runtime effect",
    ],
    location: { column: character + 1, file: fileName, line: line + 1 },
    message: compilerMemoizes
      ? `${instruction} The React Compiler does not treat \`${current}\` as a hook, so it can memoize the call and render a stale value; it never memoizes \`useValue\`.`
      : instruction,
    practice: "reactivity",
  };
}

function compilerMemoizesCall(call: ts.CallExpression): boolean {
  const caller = findAncestor(call, isRuntimeFunctionLike);
  return caller !== null && !compilerTreatsAsHook(call) && isReactCompilerUnit(caller);
}

/** The Compiler types an imported binding as a hook when its imported or its local name passes the test. */
function compilerTreatsAsHook(call: ts.CallExpression): boolean {
  const { expression } = call;
  if (ts.isPropertyAccessExpression(expression)) {
    return isCompilerHookName(expression.name.text);
  }
  if (!ts.isIdentifier(expression) || isCompilerHookName(expression.text)) {
    return true;
  }
  const local = expression.text;
  return legendReactImports(call.getSourceFile())
    .flatMap((clause) => namedImportElements(clause))
    .some(
      (specifier) =>
        specifier.name.text === local &&
        isCompilerHookName((specifier.propertyName ?? specifier.name).text),
    );
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
