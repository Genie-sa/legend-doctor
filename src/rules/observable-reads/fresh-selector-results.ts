import {
  directObservableReadPath,
  isTrackingHookCall,
  outermostTransparentParent,
} from "./observable-paths.js";
import {
  isEvaluationInert,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { ObservableReadScan } from "./model.js";
import ts from "typescript";

type ResultMember =
  | { readonly kind: "inert"; readonly expression: ts.Expression }
  | { readonly kind: "read"; readonly observable: ts.Expression };

interface SplitBinding {
  readonly local: string;
  readonly member: ResultMember;
}

interface SplitResult {
  readonly bindings: readonly SplitBinding[];
  readonly declaration: ts.VariableDeclaration;
  readonly literal: "array" | "object";
}

/**
 * A fully retained literal result can be written as direct subscriptions. Removing the
 * aggregate allocation is style: destructuring does not make each member a fresh value,
 * and source alone does not prove fewer owner renders or lower total subscription cost.
 */
export function splitUseValueResultFinding(
  call: ts.CallExpression,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const split = splitResult(call, scan);
  return split ? splitFinding(call, split, scan) : null;
}

function splitResult(call: ts.CallExpression, scan: ObservableReadScan): SplitResult | null {
  const result = conciseSelectorResult(call, scan);
  const declaration = outermostTransparentParent(call).parent;
  if (
    !result ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return literalSplit(result, declaration, scan.observableBindings);
}

function literalSplit(
  result: ts.Expression,
  declaration: ts.VariableDeclaration,
  observableBindings: ReadonlySet<string>,
): SplitResult | null {
  if (ts.isObjectLiteralExpression(result) && ts.isObjectBindingPattern(declaration.name)) {
    const bindings = objectBindings(result, declaration.name, observableBindings);
    return bindings ? { bindings, declaration, literal: "object" } : null;
  }
  if (ts.isArrayLiteralExpression(result) && ts.isArrayBindingPattern(declaration.name)) {
    const bindings = arrayBindings(result, declaration.name, observableBindings);
    return bindings ? { bindings, declaration, literal: "array" } : null;
  }
  return null;
}

function conciseSelectorResult(
  call: ts.CallExpression,
  scan: ObservableReadScan,
): ts.Expression | null {
  if (!isTrackingHookCall(call, scan.imports) || call.arguments.length !== 1) {
    return null;
  }
  const selector = unwrapTransparentExpression(call.arguments[0]!);
  if (
    (!ts.isArrowFunction(selector) && !ts.isFunctionExpression(selector)) ||
    selector.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    selector.parameters.length > 0 ||
    ts.isBlock(selector.body)
  ) {
    return null;
  }
  return unwrapTransparentExpression(selector.body);
}

function objectBindings(
  literal: ts.ObjectLiteralExpression,
  pattern: ts.ObjectBindingPattern,
  observableBindings: ReadonlySet<string>,
): readonly SplitBinding[] | null {
  const members = objectMembers(literal, observableBindings);
  if (!members) {
    return null;
  }
  if (!retainsMemberEvaluation(pattern, members)) {
    return null;
  }
  const bindings = pattern.elements.map((element) => objectBinding(element, members));
  const resolved = bindings.filter((binding) => binding !== null);
  return resolved.length === bindings.length && hasObservableRead(resolved) ? resolved : null;
}

function retainsMemberEvaluation(
  pattern: ts.ObjectBindingPattern,
  members: ReadonlyMap<string, ResultMember>,
): boolean {
  const keys = pattern.elements.map(destructuredKey);
  const retained = new Set(keys);
  const evaluationOrder = [...members.keys()].filter((key) => retained.has(key));
  return (
    retained.size === keys.length &&
    keys.every((key, index) => key === evaluationOrder[index]) &&
    [...members].every(([key, member]) => member.kind !== "read" || retained.has(key))
  );
}

function objectBinding(
  element: ts.BindingElement,
  members: ReadonlyMap<string, ResultMember>,
): SplitBinding | null {
  const key = destructuredKey(element);
  const member = key === null ? undefined : members.get(key);
  return member && ts.isIdentifier(element.name) ? { local: element.name.text, member } : null;
}

function objectMembers(
  literal: ts.ObjectLiteralExpression,
  observableBindings: ReadonlySet<string>,
): ReadonlyMap<string, ResultMember> | null {
  const members = new Map<string, ResultMember>();
  for (const property of literal.properties) {
    const entry = objectMember(property, observableBindings);
    if (!entry || members.has(entry[0])) {
      return null;
    }
    members.set(entry[0], entry[1]);
  }
  return members;
}

function objectMember(
  property: ts.ObjectLiteralElementLike,
  observableBindings: ReadonlySet<string>,
): readonly [string, ResultMember] | null {
  if (ts.isShorthandPropertyAssignment(property)) {
    return observableBindings.has(property.name.text)
      ? null
      : [property.name.text, { expression: property.name, kind: "inert" }];
  }
  if (
    !ts.isPropertyAssignment(property) ||
    (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) ||
    property.name.text === "__proto__"
  ) {
    return null;
  }
  const member = resultMember(property.initializer, observableBindings);
  return member ? [property.name.text, member] : null;
}

function destructuredKey(element: ts.BindingElement): string | null {
  if (element.dotDotDotToken || element.initializer) {
    return null;
  }
  const { propertyName } = element;
  if (propertyName === undefined) {
    return ts.isIdentifier(element.name) ? element.name.text : null;
  }
  return ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)
    ? propertyName.text
    : null;
}

function arrayBindings(
  literal: ts.ArrayLiteralExpression,
  pattern: ts.ArrayBindingPattern,
  observableBindings: ReadonlySet<string>,
): readonly SplitBinding[] | null {
  if (
    pattern.elements.length > literal.elements.length ||
    !arrayReadsRetained(literal, pattern, observableBindings)
  ) {
    return null;
  }
  const kept = pattern.elements
    .map((element, index) => [element, literal.elements[index]] as const)
    .filter(([element]) => !ts.isOmittedExpression(element));
  const bindings = kept.map(([element, value]) =>
    ts.isOmittedExpression(element) ? null : arrayBinding(element, value, observableBindings),
  );
  const resolved = bindings.filter((binding) => binding !== null);
  return resolved.length === bindings.length && hasObservableRead(resolved) ? resolved : null;
}

function arrayReadsRetained(
  literal: ts.ArrayLiteralExpression,
  pattern: ts.ArrayBindingPattern,
  observableBindings: ReadonlySet<string>,
): boolean {
  // Unbound slots still execute inside the original selector and may establish dependencies.
  return literal.elements.every((expression, index) => {
    const member = resultMember(expression, observableBindings);
    const binding = pattern.elements[index];
    return (
      member !== null &&
      (member.kind === "inert" || (binding !== undefined && !ts.isOmittedExpression(binding)))
    );
  });
}

function arrayBinding(
  element: ts.BindingElement,
  value: ts.Expression | undefined,
  observableBindings: ReadonlySet<string>,
): SplitBinding | null {
  const member = value && resultMember(value, observableBindings);
  if (!member || element.dotDotDotToken || element.initializer || !ts.isIdentifier(element.name)) {
    return null;
  }
  return { local: element.name.text, member };
}

function resultMember(
  expression: ts.Expression,
  observableBindings: ReadonlySet<string>,
): ResultMember | null {
  if (ts.isSpreadElement(expression) || ts.isOmittedExpression(expression)) {
    return null;
  }
  const observable = directObservableReadPath(expression, observableBindings);
  if (observable) {
    return { kind: "read", observable };
  }
  const root = rootIdentifier(expression);
  if (root && observableBindings.has(root.text)) {
    return null;
  }
  return isEvaluationInert(expression) ? { expression, kind: "inert" } : null;
}

function hasObservableRead(bindings: readonly SplitBinding[]): boolean {
  return bindings.some((binding) => binding.member.kind === "read");
}

function declarationText(declaration: ts.VariableDeclaration, sourceFile: ts.SourceFile): string {
  const list = declaration.parent;
  const keyword = ts.isVariableDeclarationList(list) ? `${declarationKeyword(list)} ` : "";
  return `${keyword}${declaration.getText(sourceFile)}`;
}

function declarationKeyword(list: ts.VariableDeclarationList): string {
  if ((list.flags & ts.NodeFlags.Const) !== 0) {
    return "const";
  }
  return (list.flags & ts.NodeFlags.Let) === 0 ? "var" : "let";
}

function splitFinding(
  call: ts.CallExpression,
  split: SplitResult,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { sourceFile } = scan;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  const hook = call.expression.getText(sourceFile);
  const replacement = split.bindings
    .map(({ local, member }) =>
      member.kind === "read"
        ? `const ${local} = ${hook}(${member.observable.getText(sourceFile)})`
        : `const ${local} = ${member.expression.getText(sourceFile)}`,
    )
    .join("; ");
  const reads = split.bindings.filter((binding) => binding.member.kind === "read").length;
  return {
    action: "split-use-value-result",
    confidence: "certain",
    disposition: "style",
    evidence: [
      `${reads} destructured member${reads === 1 ? "" : "s"} of the selector result ${reads === 1 ? "is" : "are"} a direct observable read`,
      `every observable read in the ${split.literal} literal is retained by a destructured binding`,
      "removes the aggregate result allocation but does not prove fewer renders or lower total subscription cost",
      "direct inputs inside observer can change subscription ownership; identical selector execution is not claimed",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Replace \`${declarationText(split.declaration, sourceFile)}\` with \`${replacement}\`; the selector returns a new ${split.literal} on every tracked change. Direct subscriptions remove that aggregate allocation; no render or lifecycle saving is proven.`,
    practice: "reactivity",
  };
}
