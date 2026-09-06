import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import {
  findAncestorUntil,
  nearestNestedFunction,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isJsxNode } from "../../rules/state-proofs/callback-sites.js";
import ts from "typescript";
import { uniqueReturnedExpression } from "../return-call-sites.js";

const READ_ONLY_COLLECTION_METHODS = new Set([
  "at",
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toReversed",
  "toSorted",
  "toSpliced",
  "values",
]);

const RENDER_COLLECTION_WORK_METHODS = new Set([
  "concat",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toReversed",
  "toSorted",
  "toSpliced",
]);

export function collectionBindingIsReadOnly(
  declaration: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  return bindingReferences(owner, declaration.text, declaration).every((reference) => {
    const access = reference.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== reference) {
      return false;
    }
    if (access.name.text === "length" || access.name.text === "size") {
      return true;
    }
    return (
      READ_ONLY_COLLECTION_METHODS.has(access.name.text) &&
      ts.isCallExpression(access.parent) &&
      access.parent.expression === access
    );
  });
}

export function staticPropertyChainStartsAt(
  expression: ts.Expression,
  root: ts.Identifier,
): boolean {
  let current = unwrapTransparentExpression(expression);
  while (ts.isPropertyAccessExpression(current)) {
    current = unwrapTransparentExpression(current.expression);
  }
  return ts.isIdentifier(current) && current.text === root.text;
}

export function commonContainingRepeatedRender(
  nodes: readonly ts.Node[],
  owner: RuntimeFunctionLike,
): ts.CallExpression | null {
  const [first] = nodes;
  if (!first) {
    return null;
  }
  for (
    let current: ts.Node | undefined = first;
    current && current !== owner;
    current = current.parent
  ) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["map", "flatMap"].includes(current.expression.name.text) &&
      nodes.every((node) => nodeWithin(node, current))
    ) {
      return current;
    }
  }
  return null;
}

export function repeatedRenderBinding(
  repeated: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const declaration = repeated.parent;
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer === repeated &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    bindingDeclarationCount(owner, declaration.name.text) === 1
    ? declaration.name
    : null;
}

export function directReturnedJsxSlot(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): ts.Identifier | null {
  const expression = findAncestorUntil(reference, ts.isJsxExpression, owner);
  const returned = uniqueReturnedExpression(owner);
  return expression?.expression &&
    (ts.isJsxElement(expression.parent) || ts.isJsxFragment(expression.parent)) &&
    unwrapTransparentExpression(expression.expression) === reference &&
    returned &&
    nodeWithin(expression, returned) &&
    nearestNestedFunction(reference, owner) === null
    ? reference
    : null;
}

export function renderCollectionWorkOutside(
  owner: RuntimeFunctionLike,
  repeated: ts.CallExpression,
  movedFilter: ts.CallExpression,
): number {
  const { body } = owner;
  if (!body || !ts.isBlock(body)) {
    return 0;
  }
  let count = 0;
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (
      ts.isCallExpression(node) &&
      isUnconditionalOwnerLevelCall(node, { body, movedFilter, owner, repeated }) &&
      isCollectionWorkCall(node)
    ) {
      count += 1;
    }
  });
  return count;
}

interface OwnerLevelCallScope {
  readonly body: ts.Block;
  readonly movedFilter: ts.CallExpression;
  readonly owner: RuntimeFunctionLike;
  readonly repeated: ts.CallExpression;
}

function isUnconditionalOwnerLevelCall(
  node: ts.CallExpression,
  { body, movedFilter, owner, repeated }: OwnerLevelCallScope,
): boolean {
  const declaration = findAncestorUntil(node, ts.isVariableDeclaration, owner);
  const statement = declaration?.parent.parent;
  return (
    node !== movedFilter &&
    node.questionDotToken === undefined &&
    !nodeWithin(node, repeated) &&
    node.getStart() < repeated.getStart() &&
    declaration !== null &&
    statement !== undefined &&
    ts.isVariableStatement(statement) &&
    statement.parent === body &&
    !isConditionallyEvaluatedWithin(node, declaration)
  );
}

function isCollectionWorkCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) {
    return false;
  }
  if (RENDER_COLLECTION_WORK_METHODS.has(callee.name.text)) {
    return true;
  }
  const receiver = unwrapTransparentExpression(callee.expression);
  return callee.name.text === "from" && ts.isIdentifier(receiver) && receiver.text === "Array";
}

function isConditionallyEvaluatedWithin(node: ts.Node, boundary: ts.Node): boolean {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (
      ts.isConditionalExpression(current) ||
      (ts.isBinaryExpression(current) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(current.operatorToken.kind)) ||
      (ts.isCallExpression(current) && current.questionDotToken !== undefined) ||
      (ts.isPropertyAccessExpression(current) && current.questionDotToken !== undefined)
    ) {
      return true;
    }
  }
  return false;
}

export function bindingReferences(
  owner: RuntimeFunctionLike,
  name: string,
  declaration: ts.Identifier,
): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  visit(owner.body, (node) => {
    if (
      ts.isIdentifier(node) &&
      node !== declaration &&
      node.text === name &&
      !isDeclarationName(node) &&
      !isNonValueIdentifier(node)
    ) {
      references.push(node);
    }
  });
  return references;
}

export function isReadOnlyFilteredResultReference(
  reference: ts.Identifier,
  owner: RuntimeFunctionLike,
): boolean {
  const access = reference.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== reference) {
    return false;
  }
  if (access.name.text === "length") {
    return Boolean(findAncestorUntil(access, isJsxNode, owner));
  }
  if (access.name.text !== "map" || !ts.isCallExpression(access.parent)) {
    return false;
  }
  const [callback] = access.parent.arguments;
  return (
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    Boolean(findAncestorUntil(access, isJsxNode, owner))
  );
}
