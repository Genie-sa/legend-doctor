import {
  RESERVED_OBSERVABLE_MEMBERS,
  directObservableReadPath,
  outermostTransparentParent,
} from "../observable-reads/observable-paths.js";
import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import {
  findAncestor,
  isRuntimeFunctionLike,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableOwnershipScan } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { callLocation } from "./model.js";
import ts from "typescript";

type ComputeFunction = ts.ArrowFunction | ts.FunctionExpression;

interface TrackedRead {
  readonly call: ts.CallExpression;
  readonly path: ts.Expression;
}

interface ComputedDeclaration {
  readonly binding: ts.Identifier;
  readonly initializer: ComputeFunction;
  readonly owner: RuntimeFunctionLike;
}

interface WrittenComputed extends ComputedDeclaration {
  readonly reads: readonly TrackedRead[];
  readonly writes: readonly ts.CallExpression[];
}

const OBSERVABLE_WRITE_MEMBERS = new Set(["assign", "delete", "push", "set", "splice", "toggle"]);
const LINK_FACTORIES = new Set(["linked", "synced"]);

export function writtenComputedInitializerFinding(
  call: ts.CallExpression,
  scan: ObservableOwnershipScan,
): LegendPracticeFinding | null {
  const computed = writtenComputed(call, scan);
  if (!computed) {
    return null;
  }
  const { sourceFile } = scan;
  const paths = [...new Set(computed.reads.map((read) => read.path.getText(sourceFile)))];
  const writeLines = describeLines(computed.writes, sourceFile);
  return {
    action: "snapshot-computed-initializer",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${paths.join(", ")} is read with a tracked get() inside the useObservable initializer function, so the hook creates a computed observable`,
      `${computed.binding.text} is written at ${writeLines}; a computed observable replaces a written value on its next recomputation`,
    ],
    location: callLocation(call, scan),
    message: `${replacementInstruction(call, computed, scan)}; the function initializer creates a computed observable that recomputes from ${paths.join(" and ")} and replaces the writes at ${writeLines}. If the value is meant to stay derived, delete those writes instead.`,
    practice: "ownership",
  };
}

function replacementInstruction(
  call: ts.CallExpression,
  computed: WrittenComputed,
  scan: ObservableOwnershipScan,
): string {
  const { sourceFile } = scan;
  const callee = call.expression.getText(sourceFile);
  const { body } = computed.initializer;
  if (ts.isBlock(body)) {
    return `Replace the function initializer of \`${callee}\` with a plain initial value whose observable reads use \`.peek()\``;
  }
  const snapshot = withPeekReads(body, computed.reads, sourceFile);
  const current = call.arguments[0]!.getText(sourceFile);
  return `Replace \`${callee}(${current})\` with \`${callee}(${snapshot})\``;
}

function withPeekReads(
  body: ts.Expression,
  reads: readonly TrackedRead[],
  sourceFile: ts.SourceFile,
): string {
  const { text } = sourceFile;
  const names = reads
    .flatMap((read) =>
      ts.isPropertyAccessExpression(read.call.expression) ? [read.call.expression.name] : [],
    )
    .toSorted((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
  let result = "";
  let cursor = body.getStart(sourceFile);
  for (const name of names) {
    result += `${text.slice(cursor, name.getStart(sourceFile))}peek`;
    cursor = name.getEnd();
  }
  return result + text.slice(cursor, body.getEnd());
}

function writtenComputed(
  call: ts.CallExpression,
  scan: ObservableOwnershipScan,
): WrittenComputed | null {
  const declaration = computedDeclaration(call);
  if (!declaration) {
    return null;
  }
  const { binding, initializer, owner } = declaration;
  const reads = trackedObservableReads(initializer.body, scan.observableBindings);
  if (reads.length === 0 || containsLinkFactoryCall(initializer.body, scan.imports)) {
    return null;
  }
  const writes = observableWritesRootedAt(owner, binding.text);
  return writes.length > 0 ? { ...declaration, reads, writes } : null;
}

function computedDeclaration(call: ts.CallExpression): ComputedDeclaration | null {
  if (call.arguments.length !== 1) {
    return null;
  }
  const initializer = unwrapTransparentExpression(call.arguments[0]!);
  const binding = declaredBinding(call);
  const owner = findAncestor(call, isRuntimeFunctionLike);
  if (
    !isPlainComputeFunction(initializer) ||
    !binding ||
    !owner ||
    bindingDeclarationCount(owner, binding.text) !== 1
  ) {
    return null;
  }
  return { binding, initializer, owner };
}

function isPlainComputeFunction(expression: ts.Expression): expression is ComputeFunction {
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) {
    return false;
  }
  const isAsync = expression.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
  );
  return expression.parameters.length === 0 && !isAsync && !expression.asteriskToken;
}

function trackedObservableReads(
  body: ts.ConciseBody,
  observableBindings: ReadonlySet<string>,
): TrackedRead[] {
  const reads: TrackedRead[] = [];
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (!ts.isCallExpression(node)) {
      return;
    }
    const path = directObservableReadPath(node, observableBindings);
    if (path) {
      reads.push({ call: node, path });
    }
  });
  return reads;
}

function containsLinkFactoryCall(body: ts.ConciseBody, imports: HookImports): boolean {
  let found = false;
  visit(body, (node) => {
    if (ts.isCallExpression(node) && isLinkFactoryCallee(node.expression, imports)) {
      found = true;
    }
  });
  return found;
}

function isLinkFactoryCallee(callee: ts.Expression, imports: HookImports): boolean {
  if (ts.isIdentifier(callee)) {
    return imports.linked.has(callee.text) || imports.synced.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    imports.legendNamespaces.has(callee.expression.text) &&
    LINK_FACTORIES.has(callee.name.text)
  );
}

function declaredBinding(call: ts.CallExpression): ts.Identifier | null {
  const declaration = outermostTransparentParent(call).parent;
  return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
    ? declaration.name
    : null;
}

function observableWritesRootedAt(owner: RuntimeFunctionLike, name: string): ts.CallExpression[] {
  const writes: ts.CallExpression[] = [];
  visit(owner.body, (node) => {
    if (ts.isCallExpression(node) && writesObservableRootedAt(node, name)) {
      writes.push(node);
    }
  });
  return writes;
}

function writesObservableRootedAt(call: ts.CallExpression, name: string): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !OBSERVABLE_WRITE_MEMBERS.has(callee.name.text)) {
    return false;
  }
  let current = unwrapTransparentExpression(callee.expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (
      ts.isPropertyAccessExpression(current) &&
      RESERVED_OBSERVABLE_MEMBERS.has(current.name.text)
    ) {
      return false;
    }
    current = unwrapTransparentExpression(current.expression);
  }
  return ts.isIdentifier(current) && current.text === name;
}

function describeLines(writes: readonly ts.CallExpression[], sourceFile: ts.SourceFile): string {
  const lines = [
    ...new Set(
      writes.map(
        (write) => sourceFile.getLineAndCharacterOfPosition(write.getStart(sourceFile)).line + 1,
      ),
    ),
  ];
  if (lines.length === 1) {
    return `line ${lines[0]}`;
  }
  const head = lines.slice(0, -1).join(", ");
  return `lines ${head} and ${lines.at(-1)}`;
}
