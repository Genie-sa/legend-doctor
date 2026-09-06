import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { nodeWithin, visit } from "../../core/ast.js";
import { REACT_EFFECT_HOOKS } from "./import-signals.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "./declaration-shapes.js";

export function isReactContextInitializer(
  expression: ts.Expression,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  const initializer = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(initializer)) {
    return false;
  }
  const callee = initializer.expression;
  return ts.isIdentifier(callee)
    ? factories.has(callee.text)
    : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) &&
        callee.name.text === "createContext";
}

type ReaderHookDeclaration = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

/**
 * A hook that only reads one context, either as `return useContext(X)` or as the guarded idiom
 * `const value = useContext(X); if (<test on value>) throw ...; return value;`.
 */
export function directReactContextReader(
  declaration: ReaderHookDeclaration,
  readers: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): string | null {
  const { body } = declaration;
  if (!body) {
    return null;
  }
  const read = ts.isBlock(body) ? readerBlockRead(body) : unwrapTransparentExpression(body);
  if (!read || !ts.isCallExpression(read) || read.arguments.length !== 1) {
    return null;
  }
  const callee = read.expression;
  const knownReader = ts.isIdentifier(callee)
    ? readers.has(callee.text)
    : ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      (callee.name.text === "use" || callee.name.text === "useContext");
  const context = read.arguments[0] ? unwrapTransparentExpression(read.arguments[0]) : null;
  return knownReader && context && ts.isIdentifier(context) ? context.text : null;
}

function readerBlockRead(body: ts.Block): ts.Expression | null {
  const [first, ...rest] = body.statements;
  if (first && ts.isReturnStatement(first) && first.expression && rest.length === 0) {
    return unwrapTransparentExpression(first.expression);
  }
  const binding =
    first && ts.isVariableStatement(first) && first.declarationList.declarations.length === 1
      ? first.declarationList.declarations[0]
      : null;
  const bindingName = binding?.name;
  if (!binding?.initializer || !bindingName || !ts.isIdentifier(bindingName)) {
    return null;
  }
  return guardedReturnOf(rest, bindingName.text)
    ? unwrapTransparentExpression(binding.initializer)
    : null;
}

/** Zero or more throw guards on the binding, then `return <binding>`. */
function guardedReturnOf(statements: readonly ts.Statement[], bindingName: string): boolean {
  const last = statements.at(-1);
  return (
    last !== undefined &&
    ts.isReturnStatement(last) &&
    last.expression !== undefined &&
    ts.isIdentifier(last.expression) &&
    last.expression.text === bindingName &&
    statements.slice(0, -1).every((guard) => isThrowGuardOn(guard, bindingName))
  );
}

/** `if (<expression mentioning only the binding>) throw ...;` */
function isThrowGuardOn(statement: ts.Statement, bindingName: string): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) {
    return false;
  }
  const thrown = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements.length === 1 && statement.thenStatement.statements[0]
    : statement.thenStatement;
  if (!thrown || !ts.isThrowStatement(thrown)) {
    return false;
  }
  let onlyBinding = true;
  visit(statement.expression, (node) => {
    if (ts.isIdentifier(node) && node.text !== bindingName && !isNonValueIdentifier(node)) {
      onlyBinding = false;
    }
  });
  return onlyBinding;
}

interface ReactEffectNames {
  effectHooks: ReadonlySet<string>;
  reactNamespaces: ReadonlySet<string>;
}

export function deferredCallbackParameterIndices(
  declaration: ts.FunctionDeclaration,
  react: ReactEffectNames,
): ReadonlySet<number> {
  const deferred = new Set<number>();
  if (!declaration.body || declaresReactEffectBinding(declaration, react)) {
    return deferred;
  }
  for (const [index, parameter] of declaration.parameters.entries()) {
    if (
      ts.isIdentifier(parameter.name) &&
      parameterIsEffectDeferred(declaration, parameter.name.text, react)
    ) {
      deferred.add(index);
    }
  }
  return deferred;
}

function declaresReactEffectBinding(
  declaration: ts.FunctionDeclaration,
  react: ReactEffectNames,
): boolean {
  return [...react.effectHooks, ...react.reactNamespaces].some(
    (binding) => bindingDeclarationCount(declaration, binding) > 0,
  );
}

function parameterIsEffectDeferred(
  declaration: ts.FunctionDeclaration,
  parameterName: string,
  react: ReactEffectNames,
): boolean {
  let callbackReference = false;
  let references = 0;
  let safe = true;
  visit(declaration.body!, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== parameterName ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    const effect = enclosingEffectCall(node, declaration, react);
    if (!effect) {
      safe = false;
      return;
    }
    if (effect.arguments[0] && nodeWithin(node, effect.arguments[0])) {
      callbackReference = true;
    }
  });
  return safe && references > 0 && callbackReference;
}

function enclosingEffectCall(
  node: ts.Node,
  boundary: ts.FunctionDeclaration,
  react: ReactEffectNames,
): ts.CallExpression | null {
  for (
    let current: ts.Node | undefined = node.parent;
    current && current !== boundary;
    current = current.parent
  ) {
    if (
      !ts.isCallExpression(current) ||
      !current.arguments.some((argument) => nodeWithin(node, argument))
    ) {
      continue;
    }
    if (
      (ts.isIdentifier(current.expression) && react.effectHooks.has(current.expression.text)) ||
      (ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.expression) &&
        react.reactNamespaces.has(current.expression.expression.text) &&
        REACT_EFFECT_HOOKS.has(current.expression.name.text))
    ) {
      return current;
    }
  }
  return null;
}
