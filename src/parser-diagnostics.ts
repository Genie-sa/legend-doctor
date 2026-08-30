import ts from "typescript";

interface AnalysisDiagnostic {
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
const diagnosticCategory = (category: ts.DiagnosticCategory): AnalysisDiagnostic["category"] => {
    if (category === ts.DiagnosticCategory.Error) {
      return "error";
    }
    if (category === ts.DiagnosticCategory.Warning) {
      return "warning";
    }
    if (category === ts.DiagnosticCategory.Suggestion) {
      return "suggestion";
    }
    return "message";
  },
  parserDiagnosticsOf = (sourceFile: ts.SourceFile): readonly AnalysisDiagnostic[] => {
    if (!Object.hasOwn(sourceFile, "parseDiagnostics")) {
      throw new Error("The installed TypeScript parser does not expose parser diagnostics");
    }
    // SAFETY: Object.hasOwn above establishes the TypeScript 5.9 parser-diagnostics property.
    const sourceWithDiagnostics = sourceFile as SourceFileWithParseDiagnostics;
    return [...sourceWithDiagnostics.parseDiagnostics].map((diagnostic) => ({
      category: diagnosticCategory(diagnostic.category),
      code: diagnostic.code,
      file: sourceFile.fileName,
      length: diagnostic.length ?? null,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      start: diagnostic.start ?? null,
    }));
  };

export { type AnalysisDiagnostic, parserDiagnosticsOf };
