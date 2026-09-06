import type { SemanticContextDiagnosticCode, SemanticContextResult } from "./model.js";
import { canonicalPath, pathIdentityKey } from "../../core/path-identity.js";
import type { AnalysisFile } from "../analysis-project.js";
import ts from "typescript";

export function createIdentityPreservingProgram(
  parsedConfig: ts.ParsedCommandLine,
  files: readonly AnalysisFile[],
): ts.Program {
  const programOptions: ts.CreateProgramOptions = {
    configFileParsingDiagnostics: parsedConfig.errors,
    host: createIdentityPreservingHost(parsedConfig.options, files),
    options: parsedConfig.options,
    rootNames: uniqueCanonicalPaths(parsedConfig.fileNames),
  };
  if (parsedConfig.projectReferences) {
    return ts.createProgram({
      ...programOptions,
      projectReferences: parsedConfig.projectReferences,
    });
  }
  return ts.createProgram(programOptions);
}

/** Reports the first way the Program failed to adopt the cached analysis files, if any. */
export function identityFailure(
  program: ts.Program,
  files: readonly AnalysisFile[],
): SemanticContextResult | null {
  const unconfiguredFiles = files.filter((file) => !program.getSourceFile(file.identityPath));
  if (unconfiguredFiles.length > 0) {
    return fileDiagnostics(
      unconfiguredFiles,
      "file-not-in-config",
      "The analysis file is not owned by the selected tsconfig. Create one semantic context per tsconfig shard.",
    );
  }
  const mismatches = files.filter(
    (file) => program.getSourceFile(file.identityPath) !== file.sourceFile,
  );
  if (mismatches.length > 0) {
    return fileDiagnostics(
      mismatches,
      "source-file-identity-mismatch",
      "The semantic Program did not retain the cached SourceFile for this analysis file.",
    );
  }
  return null;
}

function fileDiagnostics(
  files: readonly AnalysisFile[],
  code: SemanticContextDiagnosticCode,
  message: string,
): SemanticContextResult {
  return {
    context: null,
    diagnostics: files.map((file) => ({
      category: "error",
      code,
      fileName: file.originalPath,
      message,
    })),
  };
}

function createIdentityPreservingHost(
  options: ts.CompilerOptions,
  files: readonly AnalysisFile[],
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const filesByPath = new Map(files.map((file) => [pathIdentityKey(file.identityPath), file]));
  const defaultGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName): boolean =>
    filesByPath.has(pathIdentityKey(fileName)) || ts.sys.fileExists(fileName);
  host.readFile = (fileName): string | undefined =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile.text ?? ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, ...rest): ts.SourceFile | undefined =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile ??
    defaultGetSourceFile(fileName, ...rest);
  host.getSourceFileByPath = (fileName, _path, ...rest): ts.SourceFile | undefined =>
    filesByPath.get(pathIdentityKey(fileName))?.sourceFile ??
    defaultGetSourceFile(fileName, ...rest);
  return host;
}

function uniqueCanonicalPaths(fileNames: readonly string[]): string[] {
  const byCanonicalPath = new Map<string, string>();
  for (const fileName of fileNames) {
    byCanonicalPath.set(pathIdentityKey(fileName), canonicalPath(fileName));
  }
  return [...byCanonicalPath.values()];
}
