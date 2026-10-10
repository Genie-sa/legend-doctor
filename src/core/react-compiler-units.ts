import type { RuntimeFunctionLike } from "./ast.js";
import ts from "typescript";
import { visitSkippingNestedRuntimeFunctions } from "./ast.js";

/**
 * Mirrors babel-plugin-react-compiler 1.0 under its default options: `compilationMode: "infer"`,
 * the default opt-in and opt-out directives, and the default ESLint suppression rules
 * (`Entrypoint/Program.ts`, `Entrypoint/Suppression.ts`, `HIR/Environment.ts`).
 */
const COMPILER_HOOK_NAME = /^use[A-Z0-9]/u;
const COMPONENT_NAME = /^[A-Z]/u;
const OPT_IN_DIRECTIVES: ReadonlySet<string> = new Set(["use forget", "use memo"]);
const OPT_OUT_DIRECTIVES: ReadonlySet<string> = new Set(["use no forget", "use no memo"]);
const BLOCK_SUPPRESSION = /eslint-disable\s[^\n]*react-hooks\/(?:exhaustive-deps|rules-of-hooks)/u;
const NEXT_LINE_SUPPRESSION =
  /eslint-disable-next-line\s[^\n]*react-hooks\/(?:exhaustive-deps|rules-of-hooks)/u;
const REACT_WRAPPERS: ReadonlySet<string> = new Set(["forwardRef", "memo"]);
const NON_PROPS_ANNOTATIONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ArrayType,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.ConstructorType,
  ts.SyntaxKind.FunctionType,
  ts.SyntaxKind.LiteralType,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.TupleType,
]);
const NON_NODE_RETURNS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.ObjectLiteralExpression,
]);

interface HookRuleSuppression {
  readonly end: number;
  readonly kind: "file" | "next-line";
  readonly pos: number;
}

const suppressionsBySource = new WeakMap<ts.SourceFile, readonly HookRuleSuppression[]>();

type CompilerFunction = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
type CompilerFunctionName =
  | ts.ElementAccessExpression
  | ts.Identifier
  | ts.PropertyAccessExpression;

/** The Compiler gives a callee hook semantics, and so never memoizes its call, only by this name test. */
export function isCompilerHookName(name: string): boolean {
  return COMPILER_HOOK_NAME.test(name);
}

/**
 * The React Compiler compiles `fn` as its own unit, so it memoizes calls in `fn`'s body that
 * it does not treat as hooks. Requires the file itself to be compiled by the project's config.
 */
export function isReactCompilerUnit(fn: RuntimeFunctionLike): boolean {
  return (
    isCompilerFunction(fn) &&
    fn.body !== undefined &&
    isCompileCandidate(fn) &&
    !insideCompileBoundary(fn) &&
    !hasDirective(fn.getSourceFile().statements, OPT_OUT_DIRECTIVES) &&
    !(ts.isBlock(fn.body) && hasDirective(fn.body.statements, OPT_OUT_DIRECTIVES)) &&
    !hasHookRuleSuppression(fn)
  );
}

function isCompilerFunction(node: ts.Node): node is CompilerFunction {
  return (
    ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
  );
}

/** The Compiler skips class bodies and compiles the outermost candidate, lowering the ones inside it. */
function insideCompileBoundary(fn: CompilerFunction): boolean {
  for (let current = fn.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isClassLike(current) || (isCompilerFunction(current) && isCompileCandidate(current))) {
      return true;
    }
  }
  return false;
}

function isCompileCandidate(fn: CompilerFunction): boolean {
  if (fn.body && ts.isBlock(fn.body) && hasDirective(fn.body.statements, OPT_IN_DIRECTIVES)) {
    return true;
  }
  const name = compilerFunctionName(fn);
  if (name && ts.isIdentifier(name) && COMPONENT_NAME.test(name.text)) {
    return callsHooksOrCreatesJsx(fn) && hasComponentParameters(fn) && !returnsNonNode(fn);
  }
  if (name && isHookReference(name)) {
    return callsHooksOrCreatesJsx(fn);
  }
  return !ts.isFunctionDeclaration(fn) && isReactWrapperCallback(fn) && callsHooksOrCreatesJsx(fn);
}

function hasDirective(
  statements: readonly ts.Statement[],
  directives: ReadonlySet<string>,
): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (directives.has(statement.expression.text)) {
      return true;
    }
  }
  return false;
}

/** Babel drops parentheses, so the name comes from the first non-parenthesized parent. */
function compilerFunctionName(fn: CompilerFunction): CompilerFunctionName | null {
  if (ts.isFunctionDeclaration(fn)) {
    return fn.name ?? null;
  }
  const value = outermostParenthesized(fn);
  const { parent } = value;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === value
  ) {
    return isAssignableName(parent.left) ? parent.left : null;
  }
  return initializedName(parent, value);
}

/** A variable, property, or default-value binding that `value` initializes. */
function initializedName(parent: ts.Node, value: ts.Expression): ts.Identifier | null {
  const named =
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent);
  return named && parent.initializer === value && ts.isIdentifier(parent.name) ? parent.name : null;
}

function isAssignableName(expression: ts.Expression): expression is CompilerFunctionName {
  return (
    ts.isIdentifier(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  );
}

function outermostParenthesized(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** `useThing` or `Namespace.useThing`: the Compiler's syntactic hook test for names and callees. */
function isHookReference(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return isCompilerHookName(expression.text);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    isCompilerHookName(expression.name.text) &&
    ts.isIdentifier(expression.expression) &&
    COMPONENT_NAME.test(expression.expression.text)
  );
}

function isReactWrapperCallback(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const { parent } = outermostParenthesized(fn);
  if (!ts.isCallExpression(parent)) {
    return false;
  }
  const callee = unwrapParentheses(parent.expression);
  if (ts.isIdentifier(callee)) {
    return REACT_WRAPPERS.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "React" &&
    REACT_WRAPPERS.has(callee.name.text)
  );
}

function callsHooksOrCreatesJsx(fn: CompilerFunction): boolean {
  let found = false;
  visitSkippingNestedRuntimeFunctions(fn, (node) => {
    found ||=
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node) ||
      (ts.isCallExpression(node) &&
        !ts.isOptionalChain(node) &&
        isHookReference(unwrapParentheses(node.expression)));
  });
  return found;
}

function hasComponentParameters(fn: CompilerFunction): boolean {
  const [props, ref, ...rest] = fn.parameters;
  if (!props) {
    return true;
  }
  const annotation = props.initializer ? undefined : props.type;
  if (rest.length > 0 || (annotation && isNonPropsAnnotation(annotation))) {
    return false;
  }
  if (!ref) {
    return !props.dotDotDotToken;
  }
  return (
    !ref.dotDotDotToken &&
    !ref.initializer &&
    ts.isIdentifier(ref.name) &&
    /ref|Ref/u.test(ref.name.text)
  );
}

function isNonPropsAnnotation(annotation: ts.TypeNode): boolean {
  return (
    NON_PROPS_ANNOTATIONS.has(annotation.kind) &&
    !(ts.isLiteralTypeNode(annotation) && annotation.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

/** The last `return` the Compiler visits decides, after an expression body. */
function returnsNonNode(fn: CompilerFunction): boolean {
  let nonNode = fn.body !== undefined && !ts.isBlock(fn.body) && isNonNode(fn.body);
  visitSkippingNestedRuntimeFunctions(fn, (node) => {
    if (ts.isReturnStatement(node)) {
      nonNode = isNonNode(node.expression);
    }
  });
  return nonNode;
}

function isNonNode(expression: ts.Expression | undefined): boolean {
  return expression === undefined || NON_NODE_RETURNS.has(unwrapParentheses(expression).kind);
}

/**
 * The Compiler refuses a function covered by an ESLint comment for a React hook rule: a
 * next-line comment inside it, or a block `eslint-disable` anywhere in the file, which the
 * Compiler never pairs with its `eslint-enable`.
 */
function hasHookRuleSuppression(fn: CompilerFunction): boolean {
  const sourceFile = fn.getSourceFile();
  const start = fn.getStart(sourceFile);
  return hookRuleSuppressions(sourceFile).some(
    (comment) => comment.kind === "file" || (comment.pos > start && comment.end < fn.end),
  );
}

function hookRuleSuppressions(sourceFile: ts.SourceFile): readonly HookRuleSuppression[] {
  const cached = suppressionsBySource.get(sourceFile);
  if (cached) {
    return cached;
  }
  const { text } = sourceFile;
  const comments = new Map<number, ts.CommentRange>();
  const collect = (position: number): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, position) ?? []),
      ...(ts.getTrailingCommentRanges(text, position) ?? []),
    ]) {
      comments.set(comment.pos, comment);
    }
  };
  ts.forEachChild(sourceFile, function walk(node: ts.Node): void {
    collect(node.pos);
    collect(node.end);
    ts.forEachChild(node, walk);
  });
  const suppressions = [...comments.values()].flatMap((comment): HookRuleSuppression[] => {
    const body = text.slice(comment.pos, comment.end);
    if (BLOCK_SUPPRESSION.test(body)) {
      return [{ end: comment.end, kind: "file", pos: comment.pos }];
    }
    return NEXT_LINE_SUPPRESSION.test(body)
      ? [{ end: comment.end, kind: "next-line", pos: comment.pos }]
      : [];
  });
  suppressionsBySource.set(sourceFile, suppressions);
  return suppressions;
}
