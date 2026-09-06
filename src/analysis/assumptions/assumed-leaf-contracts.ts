import type {
  ChildComponentSource,
  ChildContractResolver,
  ContextConsumerSource,
  HookPresentationConsumer,
  HookReturnMembers,
} from "../../rules/child-contract/model.js";
import type ts from "typescript";

/**
 * The project's child-contract resolver with one hypothesis layered on top: the named components
 * render the prop they receive directly. Every other question still goes to the real resolver.
 */
export class AssumedLeafContracts implements ChildContractResolver {
  readonly #assumedLeaves: ReadonlySet<string>;
  readonly #base: ChildContractResolver;

  public constructor(base: ChildContractResolver, assumedLeaves: ReadonlySet<string>) {
    this.#assumedLeaves = assumedLeaves;
    this.#base = base;
  }

  public componentPropIsLeafRenderConsumer(componentName: string, propName: string): boolean {
    return (
      this.#assumedLeaves.has(componentName) ||
      this.#base.componentPropIsLeafRenderConsumer(componentName, propName)
    );
  }

  public componentArrayItemCallbackIsDeferred(
    componentName: string,
    propName: string,
    callbackProperty: string,
  ): boolean {
    return this.#base.componentArrayItemCallbackIsDeferred(
      componentName,
      propName,
      callbackProperty,
    );
  }

  public callbackRegistrationIsDeferred(
    ownerBinding: string,
    method: string,
    argumentIndex: number,
  ): boolean {
    return this.#base.callbackRegistrationIsDeferred(ownerBinding, method, argumentIndex);
  }

  public callbackPropertyIsDeferred(
    hookName: string,
    argumentIndex: number,
    property: string,
  ): boolean {
    return this.#base.callbackPropertyIsDeferred(hookName, argumentIndex, property);
  }

  public hookStateHasKeyedRowConsumer(
    hookName: string,
    stateProperty: string,
    setterProperty: string,
  ): boolean {
    return this.#base.hookStateHasKeyedRowConsumer(hookName, stateProperty, setterProperty);
  }

  public hookStateHasSingleLeafConsumer(hookName: string, members: HookReturnMembers): boolean {
    return this.#base.hookStateHasSingleLeafConsumer(hookName, members);
  }

  public hookStatePresentationConsumer(
    hookName: string,
    members: HookReturnMembers,
    broadOwnerJsx: number,
  ): HookPresentationConsumer | null {
    return this.#base.hookStatePresentationConsumer(hookName, members, broadOwnerJsx);
  }

  public componentPropCallbackIsDeferred(
    componentName: string,
    propName: string,
    callbackProperty: string,
  ): boolean {
    return this.#base.componentPropCallbackIsDeferred(componentName, propName, callbackProperty);
  }

  public componentCallbackPropIsDeferred(componentName: string, propName: string): boolean {
    return this.#base.componentCallbackPropIsDeferred(componentName, propName);
  }

  public componentCallbackPropIsDeferredAtInvocation(
    componentName: string,
    propName: string,
    invocation: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ): boolean {
    return this.#base.componentCallbackPropIsDeferredAtInvocation(
      componentName,
      propName,
      invocation,
    );
  }

  public componentCallbackPropRunsOnlyInReactEffect(
    componentName: string,
    propName: string,
  ): boolean {
    return this.#base.componentCallbackPropRunsOnlyInReactEffect(componentName, propName);
  }

  public contextConsumers(contextName: string): readonly ContextConsumerSource[] {
    return this.#base.contextConsumers(contextName);
  }

  public contextProviderSites(contextName: string): number {
    return this.#base.contextProviderSites(contextName);
  }

  public hasPlatformVariant(): boolean {
    return this.#base.hasPlatformVariant();
  }

  public frameworkEventComponent(componentName: string): boolean {
    return this.#base.frameworkEventComponent(componentName);
  }

  public pureProjectionBindings(): ReadonlySet<string> {
    return this.#base.pureProjectionBindings();
  }

  public resolveComponent(name: string): ChildComponentSource | null {
    return this.#base.resolveComponent(name);
  }
}
