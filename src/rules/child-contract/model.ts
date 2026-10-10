import type { ReachResolver } from "../../project/source-components/synchronous-reach.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type ts from "typescript";

export interface ChildComponentSource {
  readonly body: ts.ConciseBody;
  readonly deferredCallbackHooks: ReadonlyMap<string, ReadonlySet<number>>;
  readonly file: string;
  readonly invocation?: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  readonly invocationOwner?: ChildComponentSource;
  readonly owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  readonly reactWrapped?: boolean;
}

/** Resolves a JSX tag name against the imports of the file that renders it. */
export type ComponentSourceResolver = (name: string) => ChildComponentSource | null;

export interface ContextConsumerSource {
  readonly file: string;
  readonly hookNames: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

export interface CallbackContractSourceResolver {
  sourceFiles?: () => readonly ts.SourceFile[];
  callbackPackageVersion?: (file: string, specifier: string) => string | null;
  contextReaderHooks: (
    file: string,
    contextName: string,
  ) => ReadonlyMap<string, ReadonlySet<string>>;
  deferredCallbackHooks: (file: string) => ReadonlyMap<string, ReadonlySet<number>>;
  frameworkEventComponent: (file: string, name: string) => boolean;
  hookCallbackIsDeferred: (file: string, name: string, argumentIndex: number) => boolean;
  resolveComponent: (file: string, name: string) => ChildComponentSource | null;
  resolveHook: (file: string, name: string) => ChildComponentSource | null;
  sourceFile: (file: string) => ts.SourceFile | null;
}

export type HookReturnMember =
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "self" };

export interface HookReturnMembers {
  readonly setter: HookReturnMember | null;
  readonly value: HookReturnMember;
}

export interface HookPresentationConsumer {
  readonly consumerNames: readonly string[];
  readonly derivedBindings: readonly string[];
  readonly renderSites: number;
}

/**
 * Whether the components that render a child subscribe to the same observables: `proven` when
 * every render site rerenders it on each change, `possible` when some site may, `absent` otherwise.
 */
export type ParentRerenderProof = "absent" | "possible" | "proven";

export interface ChildContractResolver {
  /** Resolves imports to the project function bodies they name, as the synchronous reach does. */
  reachResolver?: () => ReachResolver;
  /** Every source-visible caller supplies plain data at this nested prop path; no getter inference from types. */
  componentPropDataPath?: (owner: RuntimeFunctionLike, path: readonly string[]) => boolean;
  componentArrayItemCallbackIsDeferred: (
    componentName: string,
    propName: string,
    callbackProperty: string,
  ) => boolean;
  callbackRegistrationIsDeferred: (
    ownerBinding: string,
    method: string,
    argumentIndex: number,
  ) => boolean;
  callbackPropertyIsDeferred: (
    hookName: string,
    argumentIndex: number,
    property: string,
  ) => boolean;
  hookStateHasKeyedRowConsumer: (
    hookName: string,
    stateProperty: string,
    setterProperty: string,
  ) => boolean;
  hookStateHasSingleLeafConsumer: (hookName: string, members: HookReturnMembers) => boolean;
  hookStatePresentationConsumer: (
    hookName: string,
    members: HookReturnMembers,
    broadOwnerJsx: number,
  ) => HookPresentationConsumer | null;
  componentPropCallbackIsDeferred: (
    componentName: string,
    propName: string,
    callbackProperty: string,
  ) => boolean;
  /** Asked at one call site, whose own props (such as an absent `asChild`) can pin the child's branch. */
  componentCallbackPropIsDeferredAtInvocation: (
    componentName: string,
    propName: string,
    invocation: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ) => boolean;
  componentCallbackPropRunsOnlyInReactEffect: (componentName: string, propName: string) => boolean;
  componentParentRerender: (
    owner: RuntimeFunctionLike,
    paths: readonly ts.Expression[],
  ) => ParentRerenderProof;
  componentPropIsLeafRenderConsumer: (componentName: string, propName: string) => boolean;
  /** No production source in the closed application package can render this component. */
  componentIsUnreferenced: (owner: RuntimeFunctionLike) => boolean;
  /** A source-resolved custom hook the owner's render calls subscribes to this path or an ancestor. */
  customHookSubscribes: (owner: RuntimeFunctionLike, observable: ts.Expression) => boolean;
  /** Every source file that reads a React context created or imported here, with its reader hooks. */
  contextConsumers: (contextName: string) => readonly ContextConsumerSource[];
  /** How many `<Context.Provider>` sites the indexed sources render for this context. */
  contextProviderSites: (contextName: string) => number;
  /** Imported hooks that only return one React context read, so they rerun to the same value. */
  contextReaderBindings: () => ReadonlySet<string>;
  /** Whether a platform-specific sibling (`.native`, `.ios`, `.android`, `.web`) shadows this file. */
  hasPlatformVariant: () => boolean;
  /** Whether this module declares or imports an observable under this name. */
  isObservableBinding: (name: string) => boolean;
  frameworkEventComponent: (componentName: string) => boolean;
  pureProjectionBindings: () => ReadonlySet<string>;
  resolveComponent: ComponentSourceResolver;
  /** Resolves a JSX tag name against the imports of `file`, for components that forward children. */
  resolveComponentIn: (file: string, name: string) => ChildComponentSource | null;
}

export const MAX_TRACKED_NAMES = 8;

export interface TrackedCallbackPath {
  name: string;
  path: readonly string[];
}

export interface CallbackReturnTarget {
  call: ts.CallExpression;
  source: ChildComponentSource;
}

export const MAX_CALLBACK_PATH_DEPTH = 32;

export interface CallbackDeferral {
  readonly sourceInput: (probe: SourceInputProbe) => boolean;
  readonly trackedPath: (
    source: ChildComponentSource,
    tracked: TrackedCallbackPath,
    trace: CallbackTrace,
  ) => boolean;
}

export interface CallbackTrace {
  readonly deferral: CallbackDeferral;
  readonly depth: number;
  readonly resolver: CallbackContractSourceResolver;
  readonly returnTarget: CallbackReturnTarget | null;
  readonly visited: ReadonlySet<string>;
}

export interface SourceInputProbe {
  readonly argumentIndex: number;
  readonly path: readonly string[];
  readonly source: ChildComponentSource;
  readonly trace: CallbackTrace;
}

export interface CallbackReferenceProbe {
  readonly path: readonly string[];
  readonly reference: ts.Identifier;
  readonly source: ChildComponentSource;
  readonly trace: CallbackTrace;
}

export interface CallbackExpressionProbe {
  readonly expression: ts.Expression;
  readonly path: readonly string[];
  readonly source: ChildComponentSource;
  readonly trace: CallbackTrace;
}

export function deeperTrace(
  trace: CallbackTrace,
  returnTarget: CallbackReturnTarget | null,
): CallbackTrace {
  return {
    deferral: trace.deferral,
    depth: trace.depth + 1,
    resolver: trace.resolver,
    returnTarget,
    visited: trace.visited,
  };
}
