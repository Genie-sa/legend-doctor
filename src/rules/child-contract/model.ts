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

export interface ContextConsumerSource {
  readonly file: string;
  readonly hookNames: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

export interface CallbackContractSourceResolver {
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

export interface ChildContractResolver {
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
  componentCallbackPropIsDeferred: (componentName: string, propName: string) => boolean;
  componentCallbackPropIsDeferredAtInvocation: (
    componentName: string,
    propName: string,
    invocation: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ) => boolean;
  componentCallbackPropRunsOnlyInReactEffect: (componentName: string, propName: string) => boolean;
  componentPropIsLeafRenderConsumer: (componentName: string, propName: string) => boolean;
  /** Every source file that reads a React context created or imported here, with its reader hooks. */
  contextConsumers: (contextName: string) => readonly ContextConsumerSource[];
  /** How many `<Context.Provider>` sites the indexed sources render for this context. */
  contextProviderSites: (contextName: string) => number;
  /** Whether a platform-specific sibling (`.native`, `.ios`, `.android`, `.web`) shadows this file. */
  hasPlatformVariant: () => boolean;
  frameworkEventComponent: (componentName: string) => boolean;
  pureProjectionBindings: () => ReadonlySet<string>;
  resolveComponent: (name: string) => ChildComponentSource | null;
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
