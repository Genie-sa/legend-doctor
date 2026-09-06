import type { NarrowCandidate, ObservableReadScan, RawValueReadScan } from "./model.js";
import {
  RESERVED_OBSERVABLE_MEMBERS,
  isUseValueCall,
  isValueReferenceTo,
  provenObservablePath,
} from "./observable-paths.js";
import { bindingDeclarationCount, isDeclarationName } from "../../core/analysis-ast.js";
import {
  commonPathPrefix,
  optionalAccessPreservesSuffix,
  rawValuePathHasOptionalAccess,
  staticRawValuePath,
} from "./raw-value-paths.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { splitLeavesFinding } from "./split-leaves.js";
import ts from "typescript";

export function narrowUseValueFinding(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const call = declaration.initializer;
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isUseValueCall(call, scan.imports)
  ) {
    return null;
  }
  const observable = provenObservablePath(call.arguments[0]!, scan.observableBindings);
  if (!observable) {
    return null;
  }
  if (ts.isObjectBindingPattern(declaration.name)) {
    return narrowBindingPatternFinding({ declaration, observable }, declaration.name, scan);
  }
  return ts.isIdentifier(declaration.name)
    ? narrowIdentifierFinding({ declaration, observable }, declaration.name.text, scan)
    : null;
}

function narrowBindingPatternFinding(
  candidate: NarrowCandidate,
  binding: ts.ObjectBindingPattern,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const [element] = binding.elements;
  const property =
    element && !ts.isOmittedExpression(element)
      ? (element.propertyName?.getText(scan.sourceFile) ?? element.name.getText(scan.sourceFile))
      : null;
  if (
    property &&
    consumesEveryKnownField(candidate.observable, [[property]], scan.observableKeys)
  ) {
    return null;
  }
  return narrowObjectBindingFinding(candidate, binding, scan);
}

function rawValueReads(
  candidate: NarrowCandidate,
  localName: string,
  owner: RuntimeFunctionLike,
): RawValueReadScan | null {
  const paths: (readonly string[])[] = [];
  const optionalReferences: ts.Identifier[] = [];
  let unsafe = false;
  visit(owner.body, (node) => {
    if (unsafe || !isValueReferenceTo(node, localName, candidate.declaration.name)) {
      return;
    }
    const path = isDeclarationName(node) ? null : staticRawValuePath(node);
    if (!path) {
      unsafe = true;
      return;
    }
    if (rawValuePathHasOptionalAccess(node)) {
      optionalReferences.push(node);
    }
    paths.push(path);
  });
  return unsafe || paths.length === 0
    ? null
    : { candidate, localName, optionalReferences, owner, paths };
}

function commonReadPathPrefix(paths: readonly (readonly string[])[]): readonly string[] {
  let common = paths[0] ?? [];
  for (const path of paths.slice(1)) {
    common = commonPathPrefix(common, path);
  }
  return common;
}

function narrowIdentifierFinding(
  candidate: NarrowCandidate,
  localName: string,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const owner = findAncestor(candidate.declaration, isRuntimeFunctionLike);
  if (!owner?.body || bindingDeclarationCount(owner, localName) !== 1) {
    return null;
  }
  const reads = rawValueReads(candidate, localName, owner);
  if (
    reads === null ||
    consumesEveryKnownField(candidate.observable, reads.paths, scan.observableKeys)
  ) {
    return null;
  }
  const commonPath = commonReadPathPrefix(reads.paths);
  if (commonPath.length === 0) {
    return reads.optionalReferences.length > 0 ? null : splitLeavesFinding(reads, scan);
  }
  return narrowCommonPathFinding(reads, commonPath, scan);
}

function narrowCommonPathFinding(
  reads: RawValueReadScan,
  commonPath: readonly string[],
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  if (
    reads.optionalReferences.some(
      (reference) => !optionalAccessPreservesSuffix(reference, commonPath.length),
    )
  ) {
    return null;
  }
  return narrowFinding(
    {
      declaration: reads.candidate.declaration,
      destructured: false,
      localName: reads.localName,
      observable: reads.candidate.observable,
      property: commonPath.join("."),
      reads: reads.paths.length,
    },
    scan,
  );
}

function consumesEveryKnownField(
  observable: ts.Expression,
  paths: readonly (readonly string[])[],
  observableKeys: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!ts.isIdentifier(observable) || paths.some((path) => path.length !== 1)) {
    return false;
  }
  const knownKeys = observableKeys.get(observable.text);
  if (!knownKeys || knownKeys.size === 0) {
    return false;
  }
  const consumed = new Set(paths.map((path) => path[0]!));
  return consumed.size === knownKeys.size && [...knownKeys].every((key) => consumed.has(key));
}

interface NarrowInstruction {
  readonly declaration: ts.VariableDeclaration;
  readonly observable: ts.Expression;
  readonly property: string;
  readonly localName: string;
  readonly reads: number;
  readonly destructured: boolean;
}

function narrowObjectBindingFinding(
  candidate: NarrowCandidate,
  binding: ts.ObjectBindingPattern,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const { elements } = binding;
  const [element] = elements;
  if (
    elements.length !== 1 ||
    !element ||
    element.dotDotDotToken ||
    element.initializer ||
    !ts.isIdentifier(element.name) ||
    (element.propertyName && !ts.isIdentifier(element.propertyName))
  ) {
    return null;
  }
  const property = element.propertyName?.text ?? element.name.text;
  if (RESERVED_OBSERVABLE_MEMBERS.has(property)) {
    return null;
  }
  return narrowFinding(
    {
      declaration: candidate.declaration,
      destructured: true,
      localName: element.name.text,
      observable: candidate.observable,
      property,
      reads: 1,
    },
    scan,
  );
}

function narrowFinding(
  instruction: NarrowInstruction,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    instruction.declaration.getStart(scan.sourceFile),
  );
  const parentPath = instruction.observable.getText(scan.sourceFile);
  const leafPath = `${parentPath}.${instruction.property}`;
  const message = instruction.destructured
    ? `Replace the single-property destructure with \`const ${instruction.localName} = useValue(${leafPath})\``
    : `Narrow \`${instruction.localName}\` from \`useValue(${parentPath})\` to \`useValue(${leafPath})\`; bind the leaf value directly and replace the \`${instruction.localName}.${instruction.property}\` reads`;
  return {
    action: "narrow-use-value-subscription",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `the value from ${parentPath} is read only through the static \`${instruction.property}\` property`,
      `${leafPath} is a proven Legend observable path and has ${instruction.reads} raw-value read${instruction.reads === 1 ? "" : "s"}`,
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `${message} so sibling observable fields no longer invalidate this component.`,
    practice: "reactivity",
  };
}
