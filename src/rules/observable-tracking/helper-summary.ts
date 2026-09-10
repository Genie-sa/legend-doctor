import {
  collectBindingNames,
  isDeclarationName,
  isNonValueIdentifier,
  staticPropertyPath,
} from "../../core/analysis-ast.js";
import { isRuntimeFunctionLike, nodeWithin, visit } from "../../core/ast.js";
import type { TrackingScan } from "./model.js";
import { provenObservablePath } from "../observable-reads/observable-paths.js";
import ts from "typescript";

type Helper = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

export interface HelperSummary {
  readonly reads: ReadonlySet<string>;
  readonly writes: ReadonlySet<string>;
  readonly boundaries: ReadonlySet<string>;
  readonly calls: readonly ts.CallExpression[];
  readonly complete: boolean;
}

function synchronous(helper: Helper): boolean {
  return (
    !helper.asteriskToken &&
    !helper.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function helperDeclaration(declaration: ts.Node | null): Helper | null {
  if (declaration && ts.isFunctionDeclaration(declaration)) {
    return declaration;
  }
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer;
  }
  return null;
}

function unsupportedControlFlow(node: ts.Node): boolean {
  return (
    ts.isThrowStatement(node) ||
    ts.isOptionalChain(node) ||
    ts.isLabeledStatement(node) ||
    ts.isBreakStatement(node) ||
    ts.isContinueStatement(node) ||
    ts.isWithStatement(node) ||
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isIterationStatement(node, false) ||
    ts.isTryStatement(node) ||
    ts.isConditionalExpression(node) ||
    (ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(node.operatorToken.kind))
  );
}

/** File-local lexical identity proof. Duplicate names deliberately lose precision, never identity. */
export class HelperTrackingContext {
  private readonly bindings = new Map<string, ts.Node[]>();
  public readonly scan: TrackingScan;

  public constructor(scan: TrackingScan) {
    this.scan = scan;
    visit(scan.sourceFile, (node) => this.collectBinding(node));
  }

  private collectBinding(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      const names = new Set<string>();
      collectBindingNames(node.name, names);
      for (const name of names) {
        this.addBinding(name, node);
      }
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportClause(node)) &&
      node.name
    ) {
      this.addBinding(node.name.text, node);
    }
  }

  private addBinding(name: string, node: ts.Node): void {
    this.bindings.set(name, [...(this.bindings.get(name) ?? []), node]);
  }

  public uniqueBinding(name: string, site: ts.Node): ts.Node | null {
    const declarations = this.bindings.get(name);
    if (declarations?.length !== 1) {
      return null;
    }
    const declaration = declarations[0]!;
    let scope: ts.Node = declaration.parent;
    while (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !isRuntimeFunctionLike(scope)) {
      scope = scope.parent;
    }
    // Forward const references need execution-order proof, even when deferred callers may be safe.
    const unavailable = ts.isVariableDeclaration(declaration) && site.getStart() < declaration.end;
    return !unavailable && nodeWithin(site, scope) ? declaration : null;
  }

  public importedName(call: ts.CallExpression, names: ReadonlySet<string>): boolean {
    return (
      ts.isIdentifier(call.expression) &&
      names.has(call.expression.text) &&
      ts.isImportSpecifier(this.uniqueBinding(call.expression.text, call) ?? this.scan.sourceFile)
    );
  }

  public helper(call: ts.CallExpression): Helper | null {
    if (!ts.isIdentifier(call.expression) || call.questionDotToken) {
      return null;
    }
    const name = call.expression.text;
    const helper = helperDeclaration(this.uniqueBinding(name, call));
    if (
      !helper?.body ||
      !synchronous(helper) ||
      helper.parameters.some(
        (parameter) =>
          parameter.initializer || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name),
      )
    ) {
      return null;
    }
    return this.onlyDirectCalls(name) ? helper : null;
  }

  /** Reassignment, escaping references and aliases invalidate a direct-callee contract. */
  private onlyDirectCalls(name: string): boolean {
    let direct = true;
    visit(this.scan.sourceFile, (node) => {
      if (
        !ts.isIdentifier(node) ||
        node.text !== name ||
        isDeclarationName(node) ||
        isNonValueIdentifier(node)
      ) {
        return;
      }
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
        direct = false;
      }
    });
    return direct;
  }

  public summary(owner: Helper): HelperSummary {
    return summarize(this, owner);
  }
}

interface SummaryState {
  readonly context: HelperTrackingContext;
  readonly reads: Set<string>;
  readonly writes: Set<string>;
  readonly boundaries: Set<string>;
  readonly calls: ts.CallExpression[];
  complete: boolean;
}

function summarize(context: HelperTrackingContext, owner: Helper): HelperSummary {
  const state: SummaryState = {
    context,
    reads: new Set(),
    writes: new Set(),
    boundaries: new Set(),
    calls: [],
    complete: synchronous(owner),
  };
  if (owner.body) {
    walk(state, owner.body);
  }
  const { reads, writes, boundaries, calls, complete } = state;
  return { reads, writes, boundaries, calls, complete };
}

function walk(state: SummaryState, node: ts.Node): void {
  if (stopsTraversal(state, node)) {
    return;
  }
  if (ts.isBlock(node)) {
    walkBlock(state, node);
    return;
  }
  if (ts.isCallExpression(node) && walkCall(state, node)) {
    return;
  }
  node.forEachChild((child) => walk(state, child));
}

function stopsTraversal(state: SummaryState, node: ts.Node): boolean {
  if (unsupportedControlFlow(node)) {
    return unresolved(state, "execution flow unresolved");
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return unresolved(state, "class initialization unresolved");
  }
  if (isRuntimeFunctionLike(node)) {
    state.boundaries.add("nested callback body excluded");
    return true;
  }
  if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
    return unresolved(state, "suspension");
  }
  return false;
}

function unresolved(state: SummaryState, boundary: string): true {
  state.complete = false;
  state.boundaries.add(boundary);
  return true;
}

function walkBlock(state: SummaryState, node: ts.Block): void {
  for (const statement of node.statements) {
    walk(state, statement);
    if (endsExecution(statement)) {
      break;
    }
  }
}

function endsExecution(statement: ts.Statement): boolean {
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    (ts.isBlock(statement) && statement.statements.some(endsExecution))
  );
}

function walkCall(state: SummaryState, node: ts.CallExpression): boolean {
  if (walkBatch(state, node)) {
    return true;
  }
  const access = node.expression;
  const receiver =
    ts.isPropertyAccessExpression(access) &&
    !node.questionDotToken &&
    !access.questionDotToken &&
    provenObservablePath(access.expression, state.context.scan.observableBindings);
  if (receiver) {
    collectObservableCall(state, node, { access, receiver });
  } else {
    state.calls.push(node);
  }
  return false;
}

function walkBatch(state: SummaryState, node: ts.CallExpression): boolean {
  if (!state.context.importedName(node, state.context.scan.imports.batch)) {
    return false;
  }
  const [callback] = node.arguments;
  if (
    node.arguments.length !== 1 ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !synchronous(callback) ||
    callback.parameters.length > 0
  ) {
    return false;
  }
  state.boundaries.add("batch preserves synchronous tracking");
  walk(state, callback.body);
  return true;
}

function collectObservableCall(
  state: SummaryState,
  node: ts.CallExpression,
  read: { readonly access: ts.PropertyAccessExpression; readonly receiver: ts.Expression },
): void {
  const { access, receiver } = read;
  const path = staticPropertyPath(receiver)!.join(".");
  const root = path.split(".")[0]!;
  if (!immutableObservableBinding(state.context.uniqueBinding(root, node))) {
    state.complete = false;
  } else if (access.name.text === "get" && node.arguments.length === 0) {
    state.reads.add(path);
  } else if (["set", "assign", "delete", "toggle"].includes(access.name.text)) {
    state.writes.add(path);
  } else if (access.name.text !== "peek") {
    state.complete = false;
  }
}

function immutableObservableBinding(binding: ts.Node | null): boolean {
  return (
    binding !== null &&
    (ts.isImportSpecifier(binding) ||
      ts.isNamespaceImport(binding) ||
      (ts.isVariableDeclaration(binding) &&
        ts.isVariableDeclarationList(binding.parent) &&
        (binding.parent.flags & ts.NodeFlags.Const) !== 0))
  );
}
