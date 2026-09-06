import type ts from "typescript";

export interface SourceHookDeclaration {
  readonly file: string;
  readonly owner: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  readonly sourceFile: ts.SourceFile;
}

export interface SourceHookResolver {
  resolveHook: (importerFile: string, name: string) => SourceHookDeclaration | null;
}

export interface CallbackBinding {
  readonly name: ts.Identifier;
}

export interface StoredCallbackRef {
  readonly declaration: ts.VariableDeclaration;
  readonly name: string;
  readonly property: string;
}

/** The callback input of one resolved hook, identified the way a caller passes it in. */
export interface DeferredCallbackQuery {
  readonly argumentIndex: number;
  readonly property: string | null;
  readonly source: SourceHookDeclaration;
}

/** How far the trace has recursed, which hook inputs it already entered, and how to resolve more. */
export interface ResolverTrace {
  readonly depth: number;
  readonly resolver: SourceHookResolver;
  readonly visited: ReadonlySet<string>;
}

/** The hook body being walked, together with the React imports of its source file. */
export interface HookBody {
  readonly hooks: ReactHookImports;
  readonly source: SourceHookDeclaration;
}

/** Everything one deferral step needs: the hook body plus the trace state carried into it. */
export interface CallbackTrace {
  readonly depth: number;
  readonly hooks: ReactHookImports;
  readonly resolver: SourceHookResolver;
  readonly source: SourceHookDeclaration;
  readonly visited: ReadonlySet<string>;
}

export interface ReactHookImports {
  readonly effectNames: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
  readonly refNames: ReadonlySet<string>;
}
