import ts from "typescript";

export interface AnalysisDiagnostic {
  readonly category: "error" | "message" | "suggestion" | "warning";
  readonly code: number;
  readonly file: string;
  readonly length: number | null;
  readonly message: string;
  readonly start: number | null;
}

interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
}

/**
 * TypeScript 5.9 exposes parser-recovery diagnostics on SourceFile but does not
 * include the property in its public declaration. Keep that version-sensitive
 * access isolated here so the cached AST remains the single parse authority.
 */
export function parserDiagnosticsOf(sourceFile: ts.SourceFile): readonly AnalysisDiagnostic[] {
  if (!("parseDiagnostics" in sourceFile)) {
    throw new Error("The installed TypeScript parser does not expose parser diagnostics");
  }
  return [...(sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics].map((diagnostic) => ({
    category: diagnosticCategory(diagnostic.category),
    code: diagnostic.code,
    file: sourceFile.fileName,
    length: diagnostic.length ?? null,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    start: diagnostic.start ?? null,
  }));
}

function diagnosticCategory(category: ts.DiagnosticCategory): AnalysisDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error: {
      return "error";
    }
    case ts.DiagnosticCategory.Warning: {
      return "warning";
    }
    case ts.DiagnosticCategory.Suggestion: {
      return "suggestion";
    }
    default: {
      return "message";
    }
  }
}
