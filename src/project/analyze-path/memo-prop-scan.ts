import type { DisabledRule, LegendPracticeFinding } from "../../core/types.js";
import {
  MEMO_PROPS_COMPILER_GATE,
  findMemoPropPractices,
} from "../../rules/memo-props/memo-props.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { AnalysisFile } from "../analysis-project.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { findHookDeclaration } from "./source-declarations.js";
import path from "node:path";
import { recordDisabledRules } from "./disabled-rules.js";
import ts from "typescript";

interface MemoPropEntry {
  readonly analysisFile: AnalysisFile;
  readonly file: string;
  readonly reportFileName: string;
}

interface MemoPropPass {
  readonly accumulator: { readonly disabledRules: Map<string, DisabledRule> };
  readonly analysisRoot: string;
  readonly compiledFiles: ReadonlySet<string>;
  readonly context: AnalysisContext;
}

/** Memo-busting props in a JSX file, unless the React Compiler already memoizes its render. */
export function memoPropFindings(
  entry: MemoPropEntry,
  pass: MemoPropPass,
): readonly LegendPracticeFinding[] {
  const { sourceFile } = entry.analysisFile;
  if (sourceFile.languageVariant !== ts.LanguageVariant.JSX) {
    return [];
  }
  if (pass.compiledFiles.has(entry.file)) {
    recordDisabledRules(pass.accumulator.disabledRules, [MEMO_PROPS_COMPILER_GATE]);
    return [];
  }
  return findMemoPropPractices({
    fileName: entry.reportFileName,
    memoizedComponentFor: (localName) => {
      const component = pass.context.sourceIndex.memoizedComponentFor(entry.file, localName);
      return component && { ...component, file: path.relative(pass.analysisRoot, component.file) };
    },
    resolveHook: (call) => projectHookDeclaration(call, pass.context),
    sourceFile,
  });
}

function projectHookDeclaration(
  call: ts.CallExpression,
  context: AnalysisContext,
): RuntimeFunctionLike | null {
  if (!ts.isIdentifier(call.expression)) {
    return null;
  }
  const resolved = context.sourceIndex.hookDeclarationFor(
    call.getSourceFile().fileName,
    call.expression.text,
  );
  const analysisFile = resolved ? context.project.getFile(resolved.file) : null;
  return resolved && analysisFile
    ? findHookDeclaration(analysisFile.sourceFile, resolved.localName)
    : null;
}
