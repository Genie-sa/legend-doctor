import type {
  AnalysisCoverageOutcome,
  AnalysisCoverageStages,
  AnalysisCoverageTarget,
} from "../analysis-coverage.js";
import type { AnalysisDiagnostic, AnalysisFile } from "../analysis-project.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateFlowCoverage } from "../state-flow/model.js";
import type { StateFlowIndex } from "../state-flow/state-flow.js";
import { isRuntimeFunctionLike } from "../../core/ast.js";
import ts from "typescript";

export interface FunctionCoverageEntry {
  node: RuntimeFunctionLike;
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>;
}

export function functionCoverageEntries(
  file: AnalysisFile,
  reportFileName: string,
): FunctionCoverageEntry[] {
  const entries: FunctionCoverageEntry[] = [];
  const { sourceFile } = file;
  const visit = (node: ts.Node): void => {
    if (isRuntimeFunctionLike(node) && node.body) {
      entries.push({
        node,
        target: {
          end: node.end,
          file: reportFileName,
          kind: "function",
          name: runtimeFunctionName(node),
          start: node.getStart(sourceFile),
        },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

function runtimeFunctionName(node: RuntimeFunctionLike): string | null {
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (node.name) {
    return node.name.getText(node.getSourceFile());
  }
  const { parent } = node;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
}

function outcome(
  status: AnalysisCoverageOutcome["status"],
  code: string,
  message: string,
): AnalysisCoverageOutcome {
  return { reason: { code, message }, status };
}

interface FileCoverageInputs {
  context: AnalysisContext;
  file: AnalysisFile;
  functionEntries: readonly FunctionCoverageEntry[];
  stateFlow: StateFlowIndex;
}

interface FunctionCoverageInputs {
  context: AnalysisContext;
  file: AnalysisFile;
  node: RuntimeFunctionLike;
  stateFlow: StateFlowIndex;
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>;
}

export function analyzedFileCoverage(inputs: FileCoverageInputs): AnalysisCoverageStages {
  const { context, file, functionEntries, stateFlow } = inputs;
  const recovered = file.parserDiagnostics.length > 0;
  return {
    detector: recovered
      ? outcome(
          "unknown",
          "detector-recovery-uncertain",
          "Detectors ran, but results in recovered source regions are not trusted as complete.",
        )
      : outcome(
          "analyzed",
          "detectors-complete",
          "All current source detectors ran on the cached AST.",
        ),
    lowering: boundedFlowCoverage(
      recovered ? "unknown" : aggregateStateFlowCoverage(functionEntries, stateFlow),
      "file",
    ),
    parser: recovered
      ? outcome("analyzed", "parser-recovered", "The parser recovered with reported diagnostics.")
      : outcome("analyzed", "parser-complete", "The source parsed without recovery diagnostics."),
    semantic: semanticCoverage(file, context),
  };
}

export function analyzedFunctionCoverage(inputs: FunctionCoverageInputs): AnalysisCoverageStages {
  const { context, file, node, stateFlow, target } = inputs;
  const recovered = file.parserDiagnostics.some((diagnostic) =>
    diagnosticAffectsTarget(diagnostic, target),
  );
  const fileRecovered = file.parserDiagnostics.length > 0;
  return {
    detector: fileRecovered
      ? outcome(
          "unknown",
          "detector-recovery-uncertain",
          "Detectors ran, but file-wide facts from recovered source make function results uncertain.",
        )
      : outcome(
          "analyzed",
          "detectors-complete",
          "All current source detectors ran on this cached function AST.",
        ),
    lowering: boundedFlowCoverage(recovered ? "unknown" : stateFlow.coverageFor(node), "function"),
    parser: recovered
      ? outcome(
          "analyzed",
          "parser-recovered-in-function",
          "The parser recovered within this function range.",
        )
      : outcome(
          "analyzed",
          "parser-complete",
          "No parser recovery diagnostic overlaps this function.",
        ),
    semantic: semanticCoverage(file, context),
  };
}

function aggregateStateFlowCoverage(
  entries: readonly FunctionCoverageEntry[],
  stateFlow: StateFlowIndex,
): StateFlowCoverage {
  const outcomes = new Set(entries.map((entry) => stateFlow.coverageFor(entry.node)));
  if (outcomes.has("unknown")) {
    return "unknown";
  }
  return outcomes.has("complete") ? "complete" : "not-requested";
}

function boundedFlowCoverage(
  coverage: StateFlowCoverage,
  scope: "file" | "function",
): AnalysisCoverageOutcome {
  if (coverage === "complete") {
    return outcome(
      "analyzed",
      "bounded-flow-complete",
      `Every requested bounded state-flow proof in this ${scope} completed.`,
    );
  }
  if (coverage === "unknown") {
    return outcome(
      "unknown",
      "bounded-flow-uncertain",
      `At least one bounded state-flow proof in this ${scope} encountered unsupported or recovered control flow.`,
    );
  }
  return outcome(
    "skipped",
    "bounded-flow-not-requested",
    `No detector requested a bounded state-flow proof in this ${scope}.`,
  );
}

function diagnosticAffectsTarget(
  diagnostic: AnalysisDiagnostic,
  target: Extract<AnalysisCoverageTarget, { kind: "function" }>,
): boolean {
  if (diagnostic.start === null || diagnostic.length === null) {
    return true;
  }
  if (diagnostic.length === 0) {
    return diagnostic.start >= target.start && diagnostic.start <= target.end;
  }
  const end = diagnostic.start + diagnostic.length;
  return diagnostic.start < target.end && end > target.start;
}

function semanticCoverage(file: AnalysisFile, context: AnalysisContext): AnalysisCoverageOutcome {
  if (context.semanticContext?.getSourceFile(file)) {
    return outcome(
      "analyzed",
      "semantic-complete",
      "Semantic facts are available from the selected tsconfig shard.",
    );
  }
  if (context.semanticContext) {
    return outcome(
      "unknown",
      "semantic-file-not-owned",
      "The selected semantic shard does not own this file.",
    );
  }
  return context.semanticDiagnostics.length > 0
    ? outcome(
        "unknown",
        "semantic-unavailable",
        "The requested semantic context could not be created.",
      )
    : outcome("skipped", "semantic-not-requested", "Semantic project analysis was not requested.");
}

export function unsupportedFileCoverage(): AnalysisCoverageStages {
  return {
    detector: outcome(
      "unsupported",
      "unsupported-extension",
      "This file extension is not supported.",
    ),
    lowering: outcome(
      "unsupported",
      "unsupported-extension",
      "This file extension is not supported.",
    ),
    parser: outcome(
      "unsupported",
      "unsupported-extension",
      "This file extension is not supported.",
    ),
    semantic: outcome(
      "unsupported",
      "unsupported-extension",
      "This file extension is not supported.",
    ),
  };
}
