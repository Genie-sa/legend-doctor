import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
  outermostTransparentParent,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { collectHookImports, isImportedHookCall } from "../../core/imports.js";
import { findAncestorUntil, identifiersNamed, isRuntimeFunctionLike } from "../../core/ast.js";
import type { ChildComponentSource } from "./model.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { boundPropIdentifier } from "./prop-bindings.js";
import ts from "typescript";

/** Whether a component invokes this callback prop only from host event props, without deferring it. */
export type ComponentPropHostDispatch = (componentName: string, propName: string) => boolean;

interface HostEventTrace {
  readonly active: Set<ts.Node>;
  readonly componentProp: ComponentPropHostDispatch;
  readonly imports: HookImports;
  readonly proven: Map<ts.Node, boolean>;
}

const EVENT_PROP = /^on[A-Z]/u;
const INTRINSIC_TAG = /^[a-z]/u;
const NATIVE_COMPONENT_MODULE = "react-native";
const NATIVE_COMPONENT_FACTORY = "requireNativeComponent";
const DEPENDENCY_LIST_HOOKS = ["useCallback", "useEffect", "useLayoutEffect", "useMemo"] as const;

/**
 * React DOM and the React Native renderer dispatch every host event prop inside `batchedUpdates`,
 * so updates scheduled synchronously by the handler, even on a legacy root, commit in one render.
 * Proves `node` runs only there: its function is reachable solely through host event props,
 * unchanged callback aliases, `useCallback`, forwarding child props, or calls from such a
 * function, and nothing on the way can suspend before `node`.
 */
export function runsOnlyInHostEvents(
  node: ts.Node,
  componentProp: ComponentPropHostDispatch,
): boolean {
  return nodeRunsOnlyInHostEvents(node, hostEventTrace(node.getSourceFile(), componentProp));
}

export interface ComponentPropQuery {
  /** Proofs by file, component, and prop; a pending entry reads false, so a forwarding cycle fails. */
  readonly cache: Map<string, boolean>;
  readonly componentName: string;
  readonly file: string;
  readonly isHostElementComponent: (file: string, name: string) => boolean;
  readonly propName: string;
  readonly resolveComponent: (file: string, name: string) => ChildComponentSource | null;
}

/** Whether a component's callback prop reaches only host event props of what it renders. */
export function componentPropRunsOnlyInHostEvents(query: ComponentPropQuery): boolean {
  return (
    query.isHostElementComponent(query.file, query.componentName) ||
    forwardedPropRunsOnlyInHostEvents(query)
  );
}

function forwardedPropRunsOnlyInHostEvents(query: ComponentPropQuery): boolean {
  const key = `${query.file}\0${query.componentName}\0${query.propName}`;
  const hit = query.cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  query.cache.set(key, false);
  const source = query.resolveComponent(query.file, query.componentName);
  const bound = source ? boundPropIdentifier(source.owner, query.propName, true) : null;
  const proven =
    source !== null &&
    bound !== null &&
    bindingRunsOnlyInHostEvents(
      bound,
      hostEventTrace(source.owner.getSourceFile(), (componentName, propName) =>
        componentPropRunsOnlyInHostEvents({ ...query, componentName, file: source.file, propName }),
      ),
    );
  query.cache.set(key, proven);
  return proven;
}

function hostEventTrace(
  sourceFile: ts.SourceFile,
  componentProp: ComponentPropHostDispatch,
): HostEventTrace {
  return {
    active: new Set(),
    componentProp,
    imports: collectHookImports(sourceFile),
    proven: new Map(),
  };
}

/** Memoizes each proof and fails a cycle, which never reaches an event prop. */
function provenOnce(node: ts.Node, trace: HostEventTrace, prove: () => boolean): boolean {
  const known = trace.proven.get(node);
  if (known !== undefined) {
    return known;
  }
  if (trace.active.has(node)) {
    return false;
  }
  trace.active.add(node);
  const proven = prove();
  trace.active.delete(node);
  trace.proven.set(node, proven);
  return proven;
}

function nodeRunsOnlyInHostEvents(node: ts.Node, trace: HostEventTrace): boolean {
  const owner = findAncestorUntil(node, isRuntimeFunctionLike, node.getSourceFile());
  return (
    owner !== null && !suspendsBefore(node, owner) && functionRunsOnlyInHostEvents(owner, trace)
  );
}

function functionRunsOnlyInHostEvents(owner: RuntimeFunctionLike, trace: HostEventTrace): boolean {
  return provenOnce(owner, trace, () => {
    if (ts.isFunctionDeclaration(owner)) {
      return owner.name !== undefined && bindingRunsOnlyInHostEvents(owner.name, trace);
    }
    return (
      (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
      valueRunsOnlyInHostEvents(owner, trace)
    );
  });
}

function valueRunsOnlyInHostEvents(value: ts.Expression, trace: HostEventTrace): boolean {
  const expression = outermostTransparentParent(value);
  const { parent } = expression;
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    return attributeDispatchesHostEvent(parent.parent, trace);
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
    return ts.isIdentifier(parent.name) && bindingRunsOnlyInHostEvents(parent.name, trace);
  }
  if (ts.isCallExpression(parent)) {
    return callOperandRunsOnlyInHostEvents(parent, expression, trace);
  }
  return ts.isArrayLiteralExpression(parent) && isHookDependencyList(parent, trace.imports);
}

/** A called value runs where the call does; `useCallback` returns its callback unchanged. */
function callOperandRunsOnlyInHostEvents(
  call: ts.CallExpression,
  operand: ts.Expression,
  trace: HostEventTrace,
): boolean {
  if (call.expression === operand) {
    return nodeRunsOnlyInHostEvents(call, trace);
  }
  return (
    call.arguments[0] === operand &&
    isImportedHookCall({
      call,
      canonicalName: "useCallback",
      localNames: trace.imports.useCallback,
      namespaceNames: trace.imports.reactNamespaces,
    }) &&
    valueRunsOnlyInHostEvents(call, trace)
  );
}

function bindingRunsOnlyInHostEvents(name: ts.Identifier, trace: HostEventTrace): boolean {
  return provenOnce(name, trace, () => {
    const scope = bindingScope(name);
    if (!scope) {
      return false;
    }
    const references = identifiersNamed(scope, name.text).filter(
      (identifier) => !isDeclarationName(identifier) && !isNonValueIdentifier(identifier),
    );
    return (
      references.length > 0 &&
      references.every((reference) => valueRunsOnlyInHostEvents(reference, trace))
    );
  });
}

/** The only scope that can reference this declaration, or null when the name is ambiguous or exported. */
function bindingScope(name: ts.Identifier): RuntimeFunctionLike | ts.SourceFile | null {
  const sourceFile = name.getSourceFile();
  const declaration = ts.isFunctionDeclaration(name.parent) ? name.parent.parent : name.parent;
  const owner = findAncestorUntil(declaration, isRuntimeFunctionLike, sourceFile);
  if (owner) {
    return bindingDeclarationCount(owner, name.text) === 1 ? owner : null;
  }
  return !isExportedDeclaration(name) && moduleDeclarationCount(sourceFile, name.text) === 1
    ? sourceFile
    : null;
}

function isExportedDeclaration(name: ts.Identifier): boolean {
  const statement = ts.isFunctionDeclaration(name.parent)
    ? name.parent
    : findAncestorUntil(name, ts.isVariableStatement, name.getSourceFile());
  return (
    statement !== null &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function moduleDeclarationCount(sourceFile: ts.SourceFile, name: string): number {
  return identifiersNamed(sourceFile, name).filter(
    (identifier) =>
      isDeclarationName(identifier) ||
      ts.isImportClause(identifier.parent) ||
      ts.isNamespaceImport(identifier.parent) ||
      (ts.isImportSpecifier(identifier.parent) && identifier.parent.name === identifier),
  ).length;
}

function attributeDispatchesHostEvent(attribute: ts.JsxAttribute, trace: HostEventTrace): boolean {
  if (!ts.isIdentifier(attribute.name) || !EVENT_PROP.test(attribute.name.text)) {
    return false;
  }
  const { tagName } = attribute.parent.parent;
  if (!ts.isIdentifier(tagName)) {
    return false;
  }
  return (
    isIntrinsicTag(tagName) ||
    isNativeHostComponent(tagName) ||
    trace.componentProp(tagName.text, attribute.name.text)
  );
}

/** JSX compiles a lowercase tag to a host element string, whatever bindings are in scope. */
function isIntrinsicTag(tagName: ts.Identifier): boolean {
  return INTRINSIC_TAG.test(tagName.text);
}

/** A module constant created by React Native's `requireNativeComponent` renders a host view. */
function isNativeHostComponent(tagName: ts.Identifier): boolean {
  const sourceFile = tagName.getSourceFile();
  if (moduleDeclarationCount(sourceFile, tagName.text) !== 1) {
    return false;
  }
  return sourceFile.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== ts.NodeFlags.None &&
      statement.declarationList.declarations.some((declaration) => {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== tagName.text) {
          return false;
        }
        const initializer = declaration.initializer
          ? unwrapTransparentExpression(declaration.initializer)
          : null;
        return (
          initializer !== null &&
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          importsNativeComponentFactory(sourceFile, initializer.expression.text)
        );
      }),
  );
}

function importsNativeComponentFactory(sourceFile: ts.SourceFile, localName: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== NATIVE_COMPONENT_MODULE ||
      statement.importClause?.isTypeOnly
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          element.name.text === localName &&
          (element.propertyName?.text ?? element.name.text) === NATIVE_COMPONENT_FACTORY,
      )
    );
  });
}

function isHookDependencyList(list: ts.ArrayLiteralExpression, imports: HookImports): boolean {
  const call = list.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[1] === list &&
    DEPENDENCY_LIST_HOOKS.some((hook) =>
      isImportedHookCall({
        call,
        canonicalName: hook,
        localNames: imports[hook],
        namespaceNames: imports.reactNamespaces,
      }),
    )
  );
}

/** An async or generator owner may resume `node` after the event returns. */
function suspendsBefore(node: ts.Node, owner: RuntimeFunctionLike): boolean {
  const isAsync =
    (ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Async) !== ts.ModifierFlags.None;
  if ((!isAsync && !owner.asteriskToken) || !owner.body) {
    return false;
  }
  if (findAncestorUntil(node, isIterationStatement, owner)) {
    return true;
  }
  const start = node.getStart();
  let suspends = false;
  const visitOwnerNode = (child: ts.Node): void => {
    if (suspends || isRuntimeFunctionLike(child) || child.getStart() >= start) {
      return;
    }
    suspends =
      ts.isAwaitExpression(child) ||
      ts.isYieldExpression(child) ||
      (ts.isForOfStatement(child) && child.awaitModifier !== undefined);
    ts.forEachChild(child, visitOwnerNode);
  };
  visitOwnerNode(owner.body);
  return suspends;
}

function isIterationStatement(node: ts.Node): node is ts.IterationStatement {
  return ts.isIterationStatement(node, false);
}
