import {
  ANY_MEMBER,
  ARRAY_MUTATORS,
} from "../../project/source-components/observable-in-place-writes.js";
import {
  RESERVED_OBSERVABLE_MEMBERS,
  isUseValueCall,
} from "../observable-reads/observable-paths.js";
import { findAncestor, identifiersNamed, isRuntimeFunctionLike } from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  outermostTransparentParent,
} from "../../core/analysis-ast.js";
import { collectHookImports } from "../../core/imports.js";
import { isPathPrefix } from "./write-conflicts.js";
import { plainSeedPaths } from "../observable-reads/plain-seed-paths.js";
import ts from "typescript";

const WRITES = new Set([...ARRAY_MUTATORS, "add", "assign", "clear", "delete", "set", "toggle"]);
const FALLBACKS = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]);

/** The observable member path an in-place write keeps, and the clone write it replaces. */
export interface InPlaceContainer {
  readonly path: readonly string[];
  readonly replaced: ts.Node;
}

export type ReadersIgnoreIdentity = (localName: string, container: InPlaceContainer) => boolean;

/**
 * Whether the observable `name` declares the container as plain data, so no link or computed
 * redirects a write, and every reference reads below the container, writes without an updater
 * other than the replaced one, or uses a raw value of the container or an ancestor only through
 * members, spreads, destructuring, or a `useValue` result used the same way. An in-place
 * write keeps those values' identity, so any other use, such as a memo or effect dependency, a
 * prop, an argument, or an escaped observable, could leave a reader stale.
 */
export function readersIgnoreIdentity(
  sourceFile: ts.SourceFile,
  name: string,
  container: InPlaceContainer,
): boolean {
  return identifiersNamed(sourceFile, name).every((reference) => {
    const { parent } = reference;
    if (ts.isVariableDeclaration(parent) && parent.name === reference) {
      return plainSeedPaths(parent).has(container.path.join("."));
    }
    return !isValueReference(reference) || observableIgnoresIdentity(reference, [], container);
  });
}

function observableIgnoresIdentity(
  observable: ts.Expression,
  path: readonly string[],
  container: InPlaceContainer,
): boolean {
  const access = memberAccess(observable);
  if (access && !RESERVED_OBSERVABLE_MEMBERS.has(access.member)) {
    return observableIgnoresIdentity(access.node, [...path, access.member], container);
  }
  const call = access?.node.parent;
  if (!holdsContainer(path, container)) {
    return true;
  }
  if (!access || !call || !ts.isCallExpression(call) || call.expression !== access.node) {
    const tracked = access ? null : useValueOf(observable);
    return tracked !== null && valueIgnoresIdentity(tracked, path, container);
  }
  return access.member === "get" || access.member === "peek"
    ? valueIgnoresIdentity(call, path, container)
    : WRITES.has(access.member) &&
        (call === container.replaced || !call.arguments.some(isRuntimeFunctionLike));
}

function valueIgnoresIdentity(
  value: ts.Expression,
  path: readonly string[],
  container: InPlaceContainer,
): boolean {
  if (!holdsContainer(path, container)) {
    return true;
  }
  const access = memberAccess(value);
  if (access) {
    return valueIgnoresIdentity(access.node, [...path, access.member], container);
  }
  const outer = outermostTransparentParent(value);
  const flows = flowsInto(outer);
  return flows
    ? flows.every((next) => valueIgnoresIdentity(next, path, container))
    : consumesMembers(outer.parent) && !holdsContainer([...path, ANY_MEMBER], container);
}

/** Where a value flows unchanged: a variable's references, a fallback, or a selector's `useValue`. */
function flowsInto(value: ts.Expression): readonly ts.Expression[] | null {
  const { parent } = value;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const owner = findAncestor(parent, isRuntimeFunctionLike) ?? parent.getSourceFile();
    return identifiersNamed(owner, parent.name.text).filter((reference) =>
      isValueReference(reference),
    );
  }
  if (ts.isBinaryExpression(parent) && parent.left === value) {
    return FALLBACKS.has(parent.operatorToken.kind) ? [parent] : null;
  }
  const tracked = ts.isArrowFunction(parent) ? useValueOf(parent) : null;
  return tracked && [tracked];
}

/** Spreads and destructuring read only the members of a value, never the value itself. */
function consumesMembers(node: ts.Node): boolean {
  return ts.isSpreadElement(node) || ts.isSpreadAssignment(node) || ts.isVariableDeclaration(node);
}

function holdsContainer(path: readonly string[], container: InPlaceContainer): boolean {
  return path.length <= container.path.length && isPathPrefix(path, container.path);
}

function memberAccess(object: ts.Expression): { member: string; node: ts.Expression } | null {
  const outer = outermostTransparentParent(object);
  const { parent } = outer;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
    return { member: parent.name.text, node: parent };
  }
  if (!ts.isElementAccessExpression(parent) || parent.expression !== outer) {
    return null;
  }
  const key = parent.argumentExpression;
  const member = ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : ANY_MEMBER;
  return { member, node: parent };
}

/** The `useValue` call that tracks this observable or selector and returns its raw value. */
function useValueOf(argument: ts.Expression): ts.CallExpression | null {
  const outer = outermostTransparentParent(argument);
  const call = outer.parent;
  return ts.isCallExpression(call) &&
    call.arguments[0] === outer &&
    isUseValueCall(call, collectHookImports(call.getSourceFile()))
    ? call
    : null;
}

function isValueReference(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return !(
    isDeclarationName(identifier) ||
    isNonValueIdentifier(identifier) ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isTypeQueryNode(parent)
  );
}
