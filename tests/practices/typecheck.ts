import path from "node:path";
import ts from "typescript";

/** The compiled output root, so module resolution walks up to the installed Legend State and React types. */
const FIXTURE_DIRECTORY = path.resolve(import.meta.dirname, "../..");

const OPTIONS: ts.CompilerOptions = {
  exactOptionalPropertyTypes: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  noUncheckedIndexedAccess: true,
  noUnusedLocals: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  types: [],
};

const baseHost = ts.createCompilerHost(OPTIONS, true);
const libraryFiles = new Map<string, ts.SourceFile | undefined>();
const programs: ts.Program[] = [];

function libraryFile(
  fileName: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile | undefined {
  if (!libraryFiles.has(fileName)) {
    libraryFiles.set(fileName, baseHost.getSourceFile(fileName, languageVersion));
  }
  return libraryFiles.get(fileName);
}

function fixtureHost(fileName: string, sourceText: string): ts.CompilerHost {
  return {
    ...baseHost,
    fileExists: (candidate) => candidate === fileName || baseHost.fileExists(candidate),
    getSourceFile: (candidate, languageVersion) =>
      candidate === fileName
        ? ts.createSourceFile(candidate, sourceText, languageVersion, true, ts.ScriptKind.TSX)
        : libraryFile(candidate, languageVersion),
    readFile: (candidate) => (candidate === fileName ? sourceText : baseHost.readFile(candidate)),
  };
}

/**
 * Parses and typechecks one in-memory module against the repository's installed `@legendapp/state`
 * and React types, returning every syntactic and semantic diagnostic as readable text.
 */
export function typecheckDiagnostics(
  sourceText: string,
  name = "verified-edit-fixture.tsx",
): string[] {
  const fileName = path.join(FIXTURE_DIRECTORY, name);
  const program = ts.createProgram(
    [fileName],
    OPTIONS,
    fixtureHost(fileName, sourceText),
    programs.pop(),
  );
  programs.push(program);
  const sourceFile = program.getSourceFile(fileName);
  return [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
