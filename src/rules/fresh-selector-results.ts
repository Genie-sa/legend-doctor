import {
  directGetReceiver,
  isUseValueCall,
  mayCallUseValue,
  provenObservablePath,
} from "./observable-reads/observable-paths.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  outermostTransparentParent,
  staticPropertyPath,
  unwrapTransparentExpression,
} from "../core/analysis-ast.js";
import { visit, visitSkippingNestedRuntimeFunctions } from "../core/ast.js";
import { COMPARISON_OPERATORS } from "./observable-reads/selector-expressions.js";
import type { DomainFacts } from "./primitive-projection/projection-domain.js";
import type { LegendPracticeFinding } from "../core/types.js";
import type { RenderOwner } from "./observable-tracking/render-owners.js";
import { broadDomain } from "./primitive-projection/value-domains.js";
import { isConstDeclaration } from "../core/binding-references.js";
import { isSelectorFunction } from "./observable-reads/selector-subscriptions.js";
import { isSynchronous } from "./observable-reads/untracked-render-reads.js";
import { lexicalBinding } from "../core/lexical-bindings.js";
import { observableDomainValues } from "./primitive-projection/projection-domain.js";
import { ownerTracksRelatedPath } from "./primitive-projection/subscription-overlap.js";
import { renderOwnerOf } from "./observable-tracking/render-owners.js";
import { sourceHasRuntimeBinding } from "./state-proofs/binding-lookup.js";
import ts from "typescript";

export interface FreshSelectorScan extends DomainFacts {
  readonly fileName: string;
  readonly observableBindings: ReadonlySet<string>;
}

type Selector = ts.ArrowFunction | ts.FunctionExpression;

/** Builtins that return a new array on every call whatever their input. */
const FRESH_ARRAY_METHODS = new Set(["filter", "flatMap", "map"]);
const FRESH_OBJECT_STATICS = new Set(["entries", "keys", "values"]);

const EQUALITY_EVIDENCE =
  "`useValue` (Legend's `useSelector`) re-runs its selector on each change to an observable it read and re-renders when the result `!==` the last render's result; it has no shallow or custom equality option";

/**
 * A selector that allocates its result on every run re-renders its owner on every tracked change.
 * That costs a render only when a change can leave the contents equal, which the app decides, so
 * every finding is a candidate: a fresh array derived from a tracked read, or a fresh literal whose
 * tracked path reaches it only through comparisons and conditions.
 */
export function findFreshSelectorResults(scan: FreshSelectorScan): LegendPracticeFinding[] {
  const findings: LegendPracticeFinding[] = [];
  if (!mayCallUseValue(scan.imports)) {
    return findings;
  }
  visit(scan.sourceFile, (node) => {
    const finding = ts.isCallExpression(node) ? freshSelectorFinding(node, scan) : null;
    if (finding) {
      findings.push(finding);
    }
  });
  return findings;
}

interface WastedChange {
  /** The builtin that derives a new array, or null for a literal result. */
  readonly method: string | null;
  readonly path: ts.Expression;
}

function freshSelectorFinding(
  call: ts.CallExpression,
  scan: FreshSelectorScan,
): LegendPracticeFinding | null {
  const selector =
    call.arguments.length === 1 ? unwrapTransparentExpression(call.arguments[0]!) : null;
  const owner = renderOwnerOf(call, scan.imports);
  const waste =
    selector &&
    isSelectorFunction(selector) &&
    selector.parameters.length === 0 &&
    isSynchronous(selector) &&
    owner?.hops === 0 &&
    isUseValueCall(call, scan.imports)
      ? wastedChange(selector, scan)
      : null;
  const path = waste && staticPropertyPath(waste.path);
  return owner && waste && path && !ownerTracksRelatedPath({ call, owner, path }, scan.imports)
    ? candidateFinding(call, { owner, waste }, scan)
    : null;
}

function wastedChange(selector: Selector, scan: FreshSelectorScan): WastedChange | null {
  const returned = returnedValues(selector) ?? [];
  const [only] = returned;
  if (returned.length === 1 && only) {
    const derived = derivedArray(only, scan);
    if (derived) {
      return derived;
    }
  }
  const literals =
    returned.length > 0 &&
    returned.every(
      (value) => ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value),
    );
  const path = literals ? lossilyReadPath(selector, scan) : null;
  return path ? { method: null, path } : null;
}

function candidateFinding(
  call: ts.CallExpression,
  { owner, waste }: { readonly owner: RenderOwner; readonly waste: WastedChange },
  scan: FreshSelectorScan,
): LegendPracticeFinding {
  const path = waste.path.getText(scan.sourceFile);
  const rerenders =
    owner.kind === "component"
      ? `\`${owner.name}\` re-renders`
      : `\`${owner.name}\` re-renders its caller`;
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(scan.sourceFile),
  );
  return {
    action: "select-stable-selector-result",
    confidence: "probable",
    disposition: "candidate",
    evidence: [
      EQUALITY_EVIDENCE,
      waste.method
        ? `\`${waste.method}\` returns a new array on every run, derived from \`${path}.get()\`, which tracks every change inside \`${path}\``
        : `the selector returns a new literal on every run, and \`${path}\` reaches it only through comparisons, negations, conditions, or \`typeof\``,
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: waste.method
      ? `\`useValue\` compares the selector's result with \`!==\`, and \`${waste.method}\` returns a new array on every run, so ${rerenders} on every \`${path}\` change, including changes that leave the selected items the same. If such changes happen while it is mounted, select only the primitives the render uses, or render the items with \`<For each={${path}}>\` so a change re-renders only the item it touches.`
      : `\`useValue\` compares the selector's result with \`!==\`, and this selector returns a new literal on every run, so ${rerenders} on every \`${path}\` change, even when the comparisons that read it keep their outcome. If such changes happen, select each field with its own \`useValue\` and build the value in render; a primitive field re-renders only when it changes.`,
    practice: "reactivity",
  };
}

/** Every value the selector returns, or null when a path may fall off the end and return `undefined`. */
function returnedValues(selector: Selector): readonly ts.Expression[] | null {
  if (!ts.isBlock(selector.body)) {
    return conditionalBranches(selector.body);
  }
  const last = selector.body.statements.at(-1);
  const values: ts.Expression[] = [];
  let complete = last !== undefined && ts.isReturnStatement(last);
  visitSkippingNestedRuntimeFunctions(selector.body, (node) => {
    if (ts.isReturnStatement(node)) {
      complete &&= node.expression !== undefined;
      values.push(...(node.expression ? conditionalBranches(node.expression) : []));
    }
  });
  return complete ? values : null;
}

function conditionalBranches(expression: ts.Expression): ts.Expression[] {
  const value = unwrapTransparentExpression(expression);
  return ts.isConditionalExpression(value)
    ? [...conditionalBranches(value.whenTrue), ...conditionalBranches(value.whenFalse)]
    : [value];
}

/** `path$.get().filter(...)` or `Object.keys(path$.get())`. */
function derivedArray(value: ts.Expression, scan: FreshSelectorScan): WastedChange | null {
  if (!ts.isCallExpression(value)) {
    return null;
  }
  const callee = unwrapTransparentExpression(value.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  const isObjectStatic =
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    FRESH_OBJECT_STATICS.has(callee.name.text) &&
    value.arguments.length === 1 &&
    !sourceHasRuntimeBinding(scan.sourceFile, "Object");
  const source = isObjectStatic ? value.arguments[0] : callee.expression;
  const method = isObjectStatic ? `Object.${callee.name.text}` : callee.name.text;
  const path =
    source && (isObjectStatic || FRESH_ARRAY_METHODS.has(method))
      ? trackedPath(source, scan)
      : null;
  return path ? { method, path } : null;
}

function trackedPath(read: ts.Expression, scan: FreshSelectorScan): ts.Expression | null {
  const receiver = directGetReceiver(read);
  return receiver && provenObservablePath(receiver, scan.observableBindings);
}

/**
 * The first tracked path whose every read reaches the result only through lossy operations, and
 * whose declared domain, when known, is wide enough for a change to keep their outcomes.
 */
function lossilyReadPath(selector: Selector, scan: FreshSelectorScan): ts.Expression | null {
  const reads: { call: ts.Expression; key: string; path: ts.Expression }[] = [];
  visit(selector.body, (node) => {
    const path = ts.isCallExpression(node) ? trackedPath(node, scan) : null;
    if (ts.isCallExpression(node) && path) {
      reads.push({ call: node, key: staticPropertyPath(path)?.join(".") ?? "", path });
    }
  });
  const lossy = reads.find(({ key }) =>
    reads.every((read) => read.key !== key || consumedLossily(read.call, selector)),
  );
  const values = lossy ? observableDomainValues(lossy.path, scan) : null;
  return lossy && (!values || broadDomain(values)) ? lossy.path : null;
}

function consumedLossily(expression: ts.Expression, selector: Selector): boolean {
  const node = outermostTransparentParent(expression);
  const { parent } = node;
  return ts.isVariableDeclaration(parent)
    ? isConstDeclaration(parent) &&
        localReferences(parent, selector).every((reference) => consumedLossily(reference, selector))
    : isLossyOperand(node, parent);
}

function isLossyOperand(node: ts.Expression, parent: ts.Node): boolean {
  if (ts.isBinaryExpression(parent)) {
    return COMPARISON_OPERATORS.has(parent.operatorToken.kind);
  }
  if (ts.isPrefixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.ExclamationToken;
  }
  if (ts.isConditionalExpression(parent)) {
    return parent.condition === node;
  }
  return ts.isIfStatement(parent) || ts.isTypeOfExpression(parent);
}

function localReferences(declaration: ts.VariableDeclaration, selector: Selector): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(selector.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node) &&
      selectorLocal(node, selector) === declaration
    ) {
      references.push(node);
    }
  });
  return references;
}

/** The selector's own `const` that the identifier resolves to. */
function selectorLocal(
  identifier: ts.Identifier,
  selector: Selector,
): ts.VariableDeclaration | null {
  const binding = lexicalBinding(identifier);
  const declaration = binding?.kind === "value" ? binding.declaration : null;
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    isConstDeclaration(declaration) &&
    declaration.pos >= selector.body.pos &&
    declaration.end <= selector.body.end
    ? declaration
    : null;
}
