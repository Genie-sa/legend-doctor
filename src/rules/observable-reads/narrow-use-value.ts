import type { LegendPracticeFinding, TextEdit } from "../../core/types.js";
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
import { replaceCommentFreeNode, replaceNode, withEdits } from "../../core/text-edits.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { SiblingWrite } from "./sibling-writes.js";
import { independentSiblingWrite } from "./sibling-writes.js";
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
    consumesEveryKnownField(candidate.observable, [[property]], scan.observableFields.keys)
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
    consumesEveryKnownField(candidate.observable, reads.paths, scan.observableFields.keys)
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
  const sibling = independentSiblingWrite(reads.candidate.observable, commonPath, scan);
  return sibling
    ? narrowFinding(
        {
          declaration: reads.candidate.declaration,
          destructured: false,
          localName: reads.localName,
          observable: reads.candidate.observable,
          property: commonPath.join("."),
          reads: reads.paths.length,
          sibling,
        },
        scan,
      )
    : null;
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
  readonly sibling: SiblingWrite;
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
  const sibling = RESERVED_OBSERVABLE_MEMBERS.has(property)
    ? null
    : independentSiblingWrite(candidate.observable, [property], scan);
  if (!sibling) {
    return null;
  }
  const localName = element.name.text;
  return withEdits(
    narrowFinding(
      {
        declaration: candidate.declaration,
        destructured: true,
        localName,
        observable: candidate.observable,
        property,
        reads: 1,
        sibling,
      },
      scan,
    ),
    destructuredNarrowEdits({ binding, candidate, localName, property }, scan),
  );
}

interface DestructuredNarrow {
  readonly binding: ts.ObjectBindingPattern;
  readonly candidate: NarrowCandidate;
  readonly localName: string;
  readonly property: string;
}

/** `const { a: b } = useValue(x$)` becomes `const b = useValue(x$.a)` when no annotation, type argument, or comment ties the shapes. */
function destructuredNarrowEdits(
  narrow: DestructuredNarrow,
  scan: ObservableReadScan,
): readonly TextEdit[] | null {
  const { declaration, observable } = narrow.candidate;
  const call = declaration.initializer;
  if (
    declaration.type ||
    !call ||
    !ts.isCallExpression(call) ||
    call.typeArguments ||
    call.arguments[0] !== observable
  ) {
    return null;
  }
  const binding = replaceCommentFreeNode(scan, narrow.binding, narrow.localName);
  const path = `${observable.getText(scan.sourceFile)}.${narrow.property}`;
  return binding ? [binding, replaceNode(scan, observable, path)] : null;
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
      `\`${instruction.sibling.path}\` is written at ${instruction.sibling.site} without touching \`${leafPath}\`, so that write rerenders this owner today`,
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `${message} so sibling observable fields no longer invalidate this component.`,
    practice: "reactivity",
  };
}
