import { canonicalPath, pathIdentityKey } from "./path-identity.js";

import type { AnalysisDiagnostic } from "./parser-diagnostics.js";
import { parserDiagnosticsOf } from "./parser-diagnostics.js";
import path from "node:path";
import { scriptKindForFile } from "./ast.js";
import ts from "typescript";

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export type AnalysisDialect = "javascript" | "javascript-jsx" | "typescript" | "typescript-jsx";

export interface AnalysisFile {
  readonly dialect: AnalysisDialect;
  readonly identityPath: string;
  readonly originalPath: string;
  readonly parserDiagnostics: readonly AnalysisDiagnostic[];
  readonly scriptKind: ts.ScriptKind;
  readonly sourceFile: ts.SourceFile;
}

export class AnalysisProject {
  public readonly files: readonly AnalysisFile[];

  readonly #filesByIdentity: ReadonlyMap<string, AnalysisFile>;

  public constructor(sources: ReadonlyMap<string, string>) {
    const filesByIdentity = new Map<string, AnalysisFile>();
    for (const [fileName, sourceText] of sources) {
      const file = createAnalysisFile(fileName, sourceText);
      const key = pathIdentityKey(file.identityPath);
      const existing = filesByIdentity.get(key);
      if (existing) {
        throw new Error(
          `duplicate analysis file identity: ${existing.originalPath} and ${file.originalPath}`,
        );
      }
      filesByIdentity.set(key, file);
    }
    this.files = [...filesByIdentity.values()].toSorted((left, right) =>
      compareText(left.identityPath, right.identityPath),
    );
    this.#filesByIdentity = filesByIdentity;
  }

  public getFile(fileName: string): AnalysisFile | undefined {
    return this.#filesByIdentity.get(pathIdentityKey(fileName));
  }
}

export function createAnalysisFile(fileName: string, sourceText: string): AnalysisFile {
  if (!isSupportedAnalysisFile(fileName)) {
    throw new Error(`unsupported analysis file extension: ${fileName}`);
  }
  const identityPath = canonicalPath(fileName);
  const scriptKind = scriptKindForFile(identityPath);
  const sourceFile = ts.createSourceFile(
    identityPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  return {
    dialect: dialectForScriptKind(scriptKind),
    identityPath,
    originalPath: fileName,
    parserDiagnostics: parserDiagnosticsOf(sourceFile),
    scriptKind,
    sourceFile,
  };
}

export function isSupportedAnalysisFile(fileName: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

const DIALECT_BY_SCRIPT_KIND = new Map<ts.ScriptKind, AnalysisDialect>([
  [ts.ScriptKind.JS, "javascript"],
  [ts.ScriptKind.JSX, "javascript-jsx"],
  [ts.ScriptKind.TSX, "typescript-jsx"],
]);

function dialectForScriptKind(scriptKind: ts.ScriptKind): AnalysisDialect {
  return DIALECT_BY_SCRIPT_KIND.get(scriptKind) ?? "typescript";
}

export type { AnalysisDiagnostic } from "./parser-diagnostics.js";
