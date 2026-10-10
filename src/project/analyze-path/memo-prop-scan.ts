import type { AnalysisContext } from "./analysis-context.js";
import type { AnalysisFile } from "../analysis-project.js";
import type { ReportedPracticeFinding } from "../../core/types.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { findHookDeclaration } from "./source-declarations.js";
import { findMemoPropPractices } from "../../rules/memo-props/memo-props.js";
import { identifyPracticeFindings } from "../../report/finding-ids.js";
import path from "node:path";
import ts from "typescript";

interface MemoPropEntry {
  readonly analysisFile: AnalysisFile;
  readonly file: string;
  readonly reportFileName: string;
}

interface MemoPropPass {
  readonly analysisRoot: string;
  readonly compiledFiles: ReadonlySet<string>;
  readonly context: AnalysisContext;
}

export function memoPropFindings(
  entry: MemoPropEntry,
  pass: MemoPropPass,
): readonly ReportedPracticeFinding[] {
  const { sourceFile } = entry.analysisFile;
  if (sourceFile.languageVariant !== ts.LanguageVariant.JSX) {
    return [];
  }
  const practices = findMemoPropPractices({
    fileName: entry.reportFileName,
    memoizedComponentFor: (localName) => {
      const component = pass.context.sourceIndex.memoizedComponentFor(entry.file, localName);
      return component && { ...component, file: path.relative(pass.analysisRoot, component.file) };
    },
    reactCompiler: pass.compiledFiles.has(entry.file),
    resolveHook: (call) => projectHookDeclaration(call, pass.context),
    sourceFile,
  });
  return identifyPracticeFindings(practices, sourceFile);
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
