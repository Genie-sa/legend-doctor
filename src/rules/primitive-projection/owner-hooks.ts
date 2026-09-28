import type { HookImports } from "../../core/imports.js";
import type { RenderFunction } from "../observable-tracking/render-owners.js";
import { isUseValueCall } from "../observable-reads/observable-paths.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";

export interface OwnerHookScan {
  readonly imports: HookImports;
  readonly sourceFile: ts.SourceFile;
  readonly stableContextRead: (localName: string) => boolean;
}

const HOOK_NAME = /^use(?:[A-Z0-9]|$)/u;

/** React hooks that read no context and no store outside the owner. */
const OWNER_LOCAL_REACT_HOOKS: ReadonlySet<string> = new Set([
  "useCallback",
  "useDebugValue",
  "useDeferredValue",
  "useEffect",
  "useId",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
  "useReducer",
  "useRef",
  "useState",
  "useTransition",
]);

const REACT_CONTEXT_READS: ReadonlySet<string> = new Set(["use", "useContext"]);

/** Legend hooks that create or observe state without rendering their caller. */
const NON_RENDERING_LEGEND_HOOKS: ReadonlySet<string> = new Set([
  "useComputed",
  "useMount",
  "useObservable",
  "useObserve",
  "useObserveEffect",
  "useUnmount",
]);

/**
 * Some hook the owner calls has render sources the analysis cannot see. A custom hook could
 * subscribe to the same path, read a context its provider renders on that path, or run an effect
 * on every render; any of these keeps the renders the projection claims to remove. Known hooks are
 * React's owner-local hooks, Legend's selector and non-rendering hooks, and context reads whose
 * value is proven never to change.
 */
export function callsUnprovenHook(owner: RenderFunction, scan: OwnerHookScan): boolean {
  const reactHooks = reactHookImports(scan.sourceFile);
  let unproven = !owner.body;
  visitSkippingNestedRuntimeFunctions(owner.body ?? owner, (node) => {
    unproven ||= ts.isCallExpression(node) && !isProvenHookCall(node, reactHooks, scan);
  });
  return unproven;
}

function isProvenHookCall(
  call: ts.CallExpression,
  reactHooks: ReadonlyMap<string, string>,
  scan: OwnerHookScan,
): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return (
      !HOOK_NAME.test(callee.text) ||
      isUseValueCall(call, scan.imports) ||
      isNonRenderingLegendHook(callee.text, scan.imports) ||
      isProvenReactHook(call, reactHooks.get(callee.text), scan) ||
      (call.arguments.length === 0 && scan.stableContextRead(callee.text))
    );
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return true;
  }
  const namespace = callee.expression.text;
  const member = callee.name.text;
  return (
    !HOOK_NAME.test(member) ||
    isUseValueCall(call, scan.imports) ||
    (scan.imports.legendReactNamespaces.has(namespace) && NON_RENDERING_LEGEND_HOOKS.has(member)) ||
    (scan.imports.reactNamespaces.has(namespace) && isProvenReactHook(call, member, scan))
  );
}

function isNonRenderingLegendHook(localName: string, imports: HookImports): boolean {
  return (
    imports.useObservable.has(localName) ||
    imports.useMount.has(localName) ||
    imports.useUnmount.has(localName) ||
    imports.useObserveEffect.has(localName) ||
    imports.useComputed.has(localName) ||
    imports.legendReactions.has(localName)
  );
}

function isProvenReactHook(
  call: ts.CallExpression,
  canonicalName: string | undefined,
  scan: OwnerHookScan,
): boolean {
  if (canonicalName === undefined) {
    return false;
  }
  if (OWNER_LOCAL_REACT_HOOKS.has(canonicalName)) {
    return true;
  }
  const [context, ...rest] = call.arguments;
  const contextName = context ? unwrapTransparentExpression(context) : null;
  return (
    REACT_CONTEXT_READS.has(canonicalName) &&
    rest.length === 0 &&
    contextName !== null &&
    ts.isIdentifier(contextName) &&
    scan.stableContextRead(contextName.text)
  );
}

/** Local name to exported name for each value imported by name from `react`. */
function reactHookImports(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const hooks = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "react" ||
      statement.importClause?.isTypeOnly ||
      !bindings ||
      !ts.isNamedImports(bindings)
    ) {
      continue;
    }
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        hooks.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  return hooks;
}
