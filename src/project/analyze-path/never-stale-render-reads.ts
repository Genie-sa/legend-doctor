import { closedHookConsumers, closedSymbolBindings } from "./hook-consumer-closure.js";
import { collectHookImports, isDirectValueFactory } from "../../core/imports.js";
import { findAncestor, identifiersNamed } from "../../core/ast.js";
import {
  isDeclarationName,
  isNonValueIdentifier,
  rootIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { ClosedBinding } from "./hook-consumer-closure.js";
import type { RenderOwner } from "../../rules/observable-tracking/render-owners.js";
import { exportedDeclaration } from "../source-components/observable-primitive-paths.js";
import { findHookDeclaration } from "./source-declarations.js";
import { isLocallyBound } from "./parent-rerenders.js";
import { isPlainValue } from "../../rules/observable-reads/plain-seed-paths.js";
import { renderOwnerOf } from "../../rules/observable-tracking/render-owners.js";
import ts from "typescript";

const READ_METHODS: ReadonlySet<string> = new Set(["get", "peek"]);
const MAX_HOOK_CALLER_DEPTH = 4;

/** The observable keeps its static seed: every closed-package use of its root is a plain read. */
export function observableIsNeverWritten(
  context: AnalysisContext,
  observable: ts.Expression,
): boolean {
  const root = rootIdentifier(observable);
  const symbol =
    root && !isLocallyBound(root)
      ? context.sourceIndex.observableDeclarationFor(root.getSourceFile().fileName, root.text)
      : null;
  const file = symbol && context.project.getFile(symbol.file);
  const declaration = file && exportedDeclaration(file.sourceFile, symbol.localName);
  const closure =
    declaration && hasStaticSeed(declaration, context.sourceIndex.plainConstantsFor(symbol.file))
      ? closedSymbolBindings(context, symbol, context.sourceIndex.observableDeclarationFor)
      : null;
  return (
    closure?.consumers.every((binding) =>
      references(binding).every((reference) => isPlainRead(reference)),
    ) ?? false
  );
}

/** Every caller renders inside a Legend `observer`, directly or through hooks, so its reads track. */
export function hookCallersAreObserved(
  context: AnalysisContext,
  owner: RenderOwner,
  depth = MAX_HOOK_CALLER_DEPTH,
): boolean {
  if (owner.kind === "component") {
    return owner.tracked;
  }
  const sourceFile = owner.owner.getSourceFile();
  const symbol = context.sourceIndex.hookDeclarationFor(sourceFile.fileName, owner.name);
  const closure =
    depth > 0 && symbol && findHookDeclaration(sourceFile, symbol.localName) === owner.owner
      ? closedHookConsumers(context, symbol)
      : null;
  return (
    closure?.consumers.every((binding) => {
      const imports = collectHookImports(binding.file.sourceFile);
      return references(binding).every((reference) => {
        const call = reference.parent;
        const caller =
          ts.isCallExpression(call) && call.expression === reference
            ? renderOwnerOf(call, imports)
            : null;
        return caller !== null && hookCallersAreObserved(context, caller, depth - 1);
      });
    }) ?? false
  );
}

/** Plain data, or a member of a call's result, optionally with a plain `??` fallback. */
function hasStaticSeed(
  declaration: ts.VariableDeclaration,
  constants: ReadonlySet<string>,
): boolean {
  const call = declaration.initializer;
  const seed =
    call && ts.isCallExpression(call) && call.arguments.length === 1 && isDirectValueFactory(call)
      ? unwrapTransparentExpression(call.arguments[0]!)
      : null;
  const value =
    seed &&
    ts.isBinaryExpression(seed) &&
    seed.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    isPlainValue(seed.right, constants)
      ? unwrapTransparentExpression(seed.left)
      : seed;
  return (
    value !== null &&
    (isPlainValue(value, constants) ||
      ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
        rootIdentifier(value) === null))
  );
}

/** `x$.a.get()` or `x$.peek()`; any other use may write, alias, link, or sync the observable. */
function isPlainRead(reference: ts.Identifier): boolean {
  let access: ts.Expression = reference;
  while (
    (ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent)) &&
    access.parent.expression === access
  ) {
    access = access.parent;
  }
  const call = access.parent;
  return (
    ts.isPropertyAccessExpression(access) &&
    READ_METHODS.has(access.name.text) &&
    ts.isCallExpression(call) &&
    call.expression === access &&
    call.arguments.length === 0
  );
}

/** Runtime uses of a binding: not its declarations, imports, exports by name, or type positions. */
function references({ file, localName }: ClosedBinding): ts.Identifier[] {
  return identifiersNamed(file.sourceFile, localName).filter(
    (reference) =>
      !isDeclarationName(reference) &&
      !isNonValueIdentifier(reference) &&
      !ts.isExportSpecifier(reference.parent) &&
      !findAncestor(reference, ts.isImportDeclaration) &&
      !findAncestor(reference, ts.isTypeNode),
  );
}
