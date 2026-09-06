import type {
  CallbackContractSourceResolver,
  ChildComponentSource,
  ChildContractResolver,
  ContextConsumerSource,
  HookPresentationConsumer,
  HookReturnMembers,
} from "../../rules/child-contract/model.js";
import type {
  SourceHookDeclaration,
  SourceHookResolver,
} from "../../rules/source-callback-contract/model.js";
import { findComponentDeclaration, findHookDeclaration } from "./source-declarations.js";
import { findHookPresentationConsumer, hasSingleLeafConsumer } from "./hook-consumers.js";
import {
  propCallbackIsDeferred,
  propCallbackRunsOnlyInReactEffect,
  propDefersArrayItemCallback,
  propIsLeafRenderConsumer,
  propObjectCallbackIsDeferred,
} from "../../rules/child-contract/child-contract.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { SourceIndex } from "../source-components/source-components.js";
import { importedHookConsumers } from "./hook-consumer-index.js";
import { keyedCursorConsumerResult } from "../../rules/hook-keyed-cursor-contract/hook-keyed-cursor-contract.js";
import { sourceHookDefersCallback } from "../../rules/source-callback-contract/source-callback-contract.js";
import type ts from "typescript";

function cached(cache: Map<string, boolean>, key: string, compute: () => boolean): boolean {
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const value = compute();
  cache.set(key, value);
  return value;
}

const PLATFORM_VARIANTS = ["", ".native", ".ios", ".android", ".web"] as const;

class ChildContracts implements ChildContractResolver {
  private readonly arrayItemCallbackContracts = new Map<string, boolean>();
  private readonly callbackContracts = new Map<string, boolean>();
  private readonly componentCallbackContracts = new Map<string, boolean>();
  private readonly componentEffectCallbackContracts = new Map<string, boolean>();
  private readonly componentInvocationCallbackContracts = new Map<string, boolean>();
  private readonly componentSources = new Map<string, ChildComponentSource | null>();
  private readonly hookDeclarations = new Map<string, SourceHookDeclaration | null>();
  private readonly keyedCursorContracts = new Map<string, boolean>();
  private readonly leafConsumerContracts = new Map<string, boolean>();
  private readonly presentationConsumerContracts = new Map<
    string,
    HookPresentationConsumer | null
  >();
  private readonly leafRenderContracts = new Map<string, boolean>();
  private readonly context: AnalysisContext;
  private readonly importerFile: string;
  private deferredRegistrations: ReturnType<
    SourceIndex["deferredCallbackRegistrationsFor"]
  > | null = null;

  private readonly hookResolver: SourceHookResolver = {
    resolveHook: (file, name) => this.resolveHookDeclaration(file, name),
  };

  private readonly callbackSources: CallbackContractSourceResolver = {
    contextReaderHooks: (file, contextName) =>
      this.context.sourceIndex.contextReaderHooksFor(file, contextName),
    deferredCallbackHooks: (file) => this.context.sourceIndex.deferredCallbackHooksFor(file),
    frameworkEventComponent: (file, name) =>
      this.context.sourceIndex.frameworkEventComponentFor(file, name),
    hookCallbackIsDeferred: (file, name, argumentIndex) =>
      this.hookDefersCallback(file, name, argumentIndex),
    resolveComponent: (file, name) => this.resolveComponentSource(file, name),
    resolveHook: (file, name) => this.hookComponentSource(file, name),
    sourceFile: (file) => this.context.project.getFile(file)?.sourceFile ?? null,
  };

  public constructor(context: AnalysisContext, importerFile: string) {
    this.context = context;
    this.importerFile = importerFile;
  }

  public callbackPropertyIsDeferred(
    hookName: string,
    argumentIndex: number,
    property: string,
  ): boolean {
    return cached(this.callbackContracts, `${hookName}\0${argumentIndex}\0${property}`, () => {
      const source = this.resolveHookDeclaration(this.importerFile, hookName);
      return (
        source !== null &&
        sourceHookDefersCallback({ source, argumentIndex, property, resolver: this.hookResolver })
      );
    });
  }

  public callbackRegistrationIsDeferred(
    ownerBinding: string,
    method: string,
    argumentIndex: number,
  ): boolean {
    this.deferredRegistrations ??= this.context.sourceIndex.deferredCallbackRegistrationsFor(
      this.importerFile,
    );
    return this.deferredRegistrations.get(ownerBinding)?.get(method)?.has(argumentIndex) ?? false;
  }

  public componentArrayItemCallbackIsDeferred(
    componentName: string,
    propName: string,
    callbackProperty: string,
  ): boolean {
    return cached(
      this.arrayItemCallbackContracts,
      `${componentName}\0${propName}\0${callbackProperty}`,
      () => {
        const source = this.resolveComponentSource(this.importerFile, componentName);
        return (
          source !== null &&
          propDefersArrayItemCallback({
            source,
            propName,
            callbackProp: callbackProperty,
            resolver: this.callbackSources,
          })
        );
      },
    );
  }

  public componentCallbackPropIsDeferred(componentName: string, propName: string): boolean {
    return cached(this.componentCallbackContracts, `${componentName}\0${propName}\0`, () => {
      const source = this.resolveComponentSource(this.importerFile, componentName);
      return source !== null && propCallbackIsDeferred(source, propName, this.callbackSources);
    });
  }

  public componentCallbackPropIsDeferredAtInvocation(
    componentName: string,
    propName: string,
    invocation: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  ): boolean {
    return cached(
      this.componentInvocationCallbackContracts,
      `${componentName}\0${propName}\0${invocation.pos}`,
      () => {
        const source = this.resolveComponentSource(this.importerFile, componentName);
        return (
          source !== null &&
          propCallbackIsDeferred({ ...source, invocation }, propName, this.callbackSources)
        );
      },
    );
  }

  public componentCallbackPropRunsOnlyInReactEffect(
    componentName: string,
    propName: string,
  ): boolean {
    return cached(this.componentEffectCallbackContracts, `${componentName}\0${propName}`, () => {
      const source = this.resolveComponentSource(this.importerFile, componentName);
      return source !== null && propCallbackRunsOnlyInReactEffect(source, propName);
    });
  }

  public componentPropCallbackIsDeferred(
    componentName: string,
    propName: string,
    callbackProperty: string,
  ): boolean {
    return cached(
      this.componentCallbackContracts,
      `${componentName}\0${propName}\0${callbackProperty}`,
      () => {
        const source = this.resolveComponentSource(this.importerFile, componentName);
        return (
          source !== null &&
          propObjectCallbackIsDeferred({
            source,
            propName,
            callbackProperty,
            resolver: this.callbackSources,
          })
        );
      },
    );
  }

  public componentPropIsLeafRenderConsumer(componentName: string, propName: string): boolean {
    return cached(this.leafRenderContracts, `${componentName}\0${propName}`, () => {
      const source = this.resolveComponentSource(this.importerFile, componentName);
      return (
        source !== null &&
        propIsLeafRenderConsumer(source, propName, (file, name) =>
          this.resolveComponentSource(file, name),
        )
      );
    });
  }

  public contextConsumers(contextName: string): readonly ContextConsumerSource[] {
    const consumers: ContextConsumerSource[] = [];
    for (const [file, hookNames] of this.context.sourceIndex.contextReaderHooksFor(
      this.importerFile,
      contextName,
    )) {
      const sourceFile = this.context.project.getFile(file)?.sourceFile;
      if (sourceFile) {
        consumers.push({ file, hookNames, sourceFile });
      }
    }
    return consumers;
  }

  public contextProviderSites(contextName: string): number {
    return this.context.sourceIndex.contextProviderSitesFor(this.importerFile, contextName);
  }

  public hasPlatformVariant(): boolean {
    const match =
      /^(?<base>.*?)(?:\.(?:native|ios|android|web))?\.(?<extension>[cm]?[jt]sx?)$/u.exec(
        this.importerFile,
      );
    if (!match?.groups) {
      return false;
    }
    const { base, extension } = match.groups;
    return PLATFORM_VARIANTS.some((variant) => {
      const candidate = `${base}${variant}.${extension}`;
      return (
        candidate !== this.importerFile && this.context.project.getFile(candidate) !== undefined
      );
    });
  }

  public frameworkEventComponent(componentName: string): boolean {
    return this.context.sourceIndex.frameworkEventComponentFor(this.importerFile, componentName);
  }

  public hookStateHasKeyedRowConsumer(
    hookName: string,
    stateProperty: string,
    setterProperty: string,
  ): boolean {
    return cached(
      this.keyedCursorContracts,
      `${hookName}\0${stateProperty}\0${setterProperty}`,
      () => this.hasSingleKeyedRowConsumer(hookName, stateProperty, setterProperty),
    );
  }

  public hookStateHasSingleLeafConsumer(hookName: string, members: HookReturnMembers): boolean {
    return cached(this.leafConsumerContracts, `${hookName}\0${JSON.stringify(members)}`, () =>
      hasSingleLeafConsumer({
        context: this.context,
        hookName,
        importerFile: this.importerFile,
        members,
      }),
    );
  }

  public hookStatePresentationConsumer(
    hookName: string,
    members: HookReturnMembers,
    broadOwnerJsx: number,
  ): HookPresentationConsumer | null {
    const key = `${hookName}\0${JSON.stringify(members)}\0${broadOwnerJsx}`;
    if (this.presentationConsumerContracts.has(key)) {
      return this.presentationConsumerContracts.get(key) ?? null;
    }
    const consumer = findHookPresentationConsumer({
      broadOwnerJsx,
      context: this.context,
      hookName,
      importerFile: this.importerFile,
      members,
    });
    this.presentationConsumerContracts.set(key, consumer);
    return consumer;
  }

  public pureProjectionBindings(): ReadonlySet<string> {
    return this.context.sourceIndex.pureProjectionsFor(this.importerFile);
  }

  public resolveComponent(name: string): ChildComponentSource | null {
    return this.resolveComponentSource(this.importerFile, name);
  }

  private hookDefersCallback(file: string, name: string, argumentIndex: number): boolean {
    const source = this.resolveHookDeclaration(file, name);
    return (
      source !== null &&
      sourceHookDefersCallback({
        source,
        argumentIndex,
        property: null,
        resolver: this.hookResolver,
      })
    );
  }

  private hookComponentSource(file: string, name: string): ChildComponentSource | null {
    const source = this.resolveHookDeclaration(file, name);
    if (!source?.owner.body) {
      return null;
    }
    return {
      ...source,
      body: source.owner.body,
      deferredCallbackHooks: this.context.sourceIndex.deferredCallbackHooksFor(source.file),
    };
  }

  private resolveHookDeclaration(file: string, name: string): SourceHookDeclaration | null {
    const key = `${file}\0${name}`;
    const hit = this.hookDeclarations.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const declaration = this.readHookDeclaration(file, name);
    this.hookDeclarations.set(key, declaration);
    return declaration;
  }

  private readHookDeclaration(file: string, name: string): SourceHookDeclaration | null {
    const resolved = this.context.sourceIndex.hookDeclarationFor(file, name);
    const analysisFile = resolved ? this.context.project.getFile(resolved.file) : null;
    if (!resolved || !analysisFile) {
      return null;
    }
    const owner = findHookDeclaration(analysisFile.sourceFile, resolved.localName);
    return owner ? { file: resolved.file, owner, sourceFile: analysisFile.sourceFile } : null;
  }

  private resolveComponentSource(file: string, name: string): ChildComponentSource | null {
    const key = `${file}\0${name}`;
    const hit = this.componentSources.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const source = this.readComponentSource(file, name);
    this.componentSources.set(key, source);
    return source;
  }

  private readComponentSource(file: string, name: string): ChildComponentSource | null {
    const resolved = this.context.sourceIndex.componentDeclarationFor(file, name);
    const analysisFile = resolved ? this.context.project.getFile(resolved.file) : null;
    if (!resolved || !analysisFile) {
      return null;
    }
    return findComponentDeclaration({
      deferredCallbackHooks: this.context.sourceIndex.deferredCallbackHooksFor(resolved.file),
      file: resolved.file,
      localName: resolved.localName,
      sourceFile: analysisFile.sourceFile,
    });
  }

  private hasSingleKeyedRowConsumer(
    hookName: string,
    stateProperty: string,
    setterProperty: string,
  ): boolean {
    const declaration = this.context.sourceIndex.hookDeclarationFor(this.importerFile, hookName);
    if (!declaration) {
      return false;
    }
    const results = importedHookConsumers(this.context, declaration).map(({ file, hookBinding }) =>
      keyedCursorConsumerResult({
        sourceFile: file.sourceFile,
        hookBinding,
        cursorProperty: stateProperty,
        setterProperty,
      }),
    );
    return (
      !results.includes("unsafe") && results.filter((result) => result === "safe").length === 1
    );
  }
}

export function createChildContractResolver(
  context: AnalysisContext,
  importerFile: string,
): ChildContractResolver {
  return new ChildContracts(context, importerFile);
}
