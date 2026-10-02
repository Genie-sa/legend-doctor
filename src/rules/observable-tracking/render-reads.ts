import {
  bindingDeclarationCount,
  hookCallName,
  outermostTransparentParent,
  staticPropertyPath,
} from "../../core/analysis-ast.js";
import {
  directGetReceiver,
  isTrackingHookCall,
  provenObservablePath,
} from "../observable-reads/observable-paths.js";
import { earlyExitBefore, renderInitializerEdits } from "./render-read-edits.js";
import { inBabelWrappedChild, isReactiveInputArgument } from "./reactive-inputs.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { RenderOwner } from "./render-owners.js";
import type { TrackingScan } from "./model.js";
import { guardsOnlyObservableWrites } from "./write-guards.js";
import { hasCoveringSubscription } from "./subscription-coverage.js";
import { renderOwnerOf } from "./render-owners.js";
import { subscriptionHookCallee } from "../../core/use-value-import.js";
import ts from "typescript";
import { withEdits } from "../../core/text-edits.js";

interface RenderRead {
  readonly call: ts.CallExpression;
  readonly observable: ts.Expression;
  readonly owner: RenderOwner;
  readonly path: readonly string[];
}

/**
 * A `get()` on a proven observable path that executes during a component's or custom hook's
 * render without any tracking context. Nothing subscribes, so the value is read once per render
 * and the owner never re-renders when it changes. Reads handed to Legend reactive inputs, which
 * track on their own, `useValue` arguments, reads handed to hooks as snapshots, `key` attributes,
 * reads that only guard observable writes, and paths already covered by a `useValue` in the same
 * owner or in a source-resolved custom hook it calls are left alone. Inside `observer` the read
 * already tracks, so only a render-body initializer is reported, as a style rename.
 */
export function renderReadFinding(
  call: ts.CallExpression,
  scan: TrackingScan,
): LegendPracticeFinding | null {
  const read = renderRead(call, scan);
  if (!read) {
    return null;
  }
  return read.owner.tracked ? observerReadRename(read, scan) : renderReadPractice(read, scan);
}

function renderRead(call: ts.CallExpression, scan: TrackingScan): RenderRead | null {
  const receiver = directGetReceiver(call);
  const observable = receiver && provenObservablePath(receiver, scan.observableBindings);
  const path = observable && staticPropertyPath(observable);
  if (
    !observable ||
    !path ||
    isReactiveInputArgument(call, scan) ||
    isSnapshotPosition(call, scan.imports) ||
    guardsOnlyObservableWrites(call, scan)
  ) {
    return null;
  }
  const owner = renderOwnerOf(call, scan.imports);
  if (
    !owner ||
    inBabelWrappedChild(call, owner.owner, scan) ||
    hasCoveringSubscription(owner.owner, path, scan) ||
    scan.childContracts?.customHookSubscribes(owner.owner, observable)
  ) {
    return null;
  }
  return { call, observable, owner, path };
}

/**
 * Hook arguments are evaluated once per render on purpose (`useState(x$.get())` seeds state),
 * tracking hooks own their own input rule, and `key` reads are intentionally non-reactive.
 */
function isSnapshotPosition(call: ts.CallExpression, imports: HookImports): boolean {
  const outer = outermostTransparentParent(call);
  const { parent } = outer;
  if (ts.isCallExpression(parent) && parent.arguments.includes(outer)) {
    const hook = hookCallName(parent);
    return (
      isTrackingHookCall(parent, imports) ||
      (hook !== null && (/^use[A-Z0-9$]/u.test(hook) || isAliasedReactHook(hook, imports)))
    );
  }
  return (
    ts.isJsxExpression(parent) &&
    ts.isJsxAttribute(parent.parent) &&
    parent.parent.name.getText() === "key"
  );
}

function isAliasedReactHook(name: string, imports: HookImports): boolean {
  return (
    imports.useState.has(name) ||
    imports.useRef.has(name) ||
    imports.useMemo.has(name) ||
    imports.useCallback.has(name) ||
    imports.useObservable.has(name)
  );
}

function directRenderInitializer(read: RenderRead): ts.VariableStatement | null {
  const declaration = outermostTransparentParent(read.call).parent;
  if (
    read.owner.hops > 0 ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !ts.isVariableStatement(declaration.parent.parent)
  ) {
    return null;
  }
  const statement = declaration.parent.parent;
  return statement.parent === read.owner.owner.body ? statement : null;
}

function suggestedBindingName(read: RenderRead): string {
  const last = read.path.at(-1) ?? "value";
  const base = last.replace(/\$+$/u, "") || "value";
  const name = base.charAt(0).toLowerCase() + base.slice(1);
  return bindingDeclarationCount(read.owner.owner, name) === 0 ? name : `${name}Value`;
}

interface RenderReadRewrite {
  readonly hook: string;
  readonly initializer: ts.VariableStatement | null;
  readonly path: string;
}

/**
 * An in-place rewrite only for a render-body initializer that every render reaches; below an early exit the
 * new hook would run on some renders only, so the declaration moves above that exit.
 */
function renderReadInstruction(
  read: RenderRead,
  { hook, initializer, path }: RenderReadRewrite,
  sourceFile: ts.SourceFile,
): string {
  const subscription = `${hook}(${path})`;
  if (!initializer) {
    const binding = suggestedBindingName(read);
    return `Subscribe with \`const ${binding} = ${subscription}\` at the top of \`${read.owner.name}\` and read \`${binding}\` here`;
  }
  const exit = earlyExitBefore(initializer);
  if (!exit) {
    return `Replace \`${path}.get()\` with \`${subscription}\``;
  }
  const exitLine = sourceFile.getLineAndCharacterOfPosition(exit.getStart(sourceFile)).line + 1;
  return `Move this declaration above the early exit at line ${exitLine} and replace \`${path}.get()\` with \`${subscription}\` there, so the hook runs on every render`;
}

function renderReadPractice(read: RenderRead, scan: TrackingScan): LegendPracticeFinding {
  const { call, observable, owner } = read;
  const path = observable.getText(scan.sourceFile);
  const subject =
    owner.kind === "component" ? `\`${owner.name}\`` : `components calling \`${owner.name}\``;
  const consequence = `the read runs in \`${owner.name}\` outside a tracking context (a subscription hook, observer, or a reactive component), so ${subject} never re-render${owner.kind === "component" ? "s" : ""} when \`${path}\` changes`;
  const initializer = directRenderInitializer(read);
  const hook = subscriptionHookCallee(scan.sourceFile);
  const instruction = renderReadInstruction(read, { hook, initializer, path }, scan.sourceFile);
  return withEdits(
    {
      action: "use-value-for-render-read",
      confidence: "certain",
      disposition: "change",
      evidence: [
        `${path}.get() reads a proven Legend observable path`,
        owner.hops === 0
          ? `the call executes directly in the render body of ${owner.kind} \`${owner.name}\``
          : `the call executes in a synchronous iteration callback of ${owner.kind} \`${owner.name}\`'s render`,
        `no useValue, use$, or useSelector call in \`${owner.name}\` or a source-resolved custom hook it calls subscribes to \`${path}\` or a parent path, and the component is not wrapped in observer`,
      ],
      location: findingLocation(call, scan),
      message: `${instruction}; ${consequence}.`,
      practice: "reactivity",
    },
    initializer && renderInitializerEdits(call, initializer, scan),
  );
}

/** Inside `observer`, `useValue(x$)` runs `x$.get()` without a hook, so a render-body initializer renames exactly. */
function observerReadRename(read: RenderRead, scan: TrackingScan): LegendPracticeFinding | null {
  const initializer = directRenderInitializer(read);
  if (!initializer || earlyExitBefore(initializer)) {
    return null;
  }
  const { call, observable, owner } = read;
  const path = observable.getText(scan.sourceFile);
  const subscription = `${subscriptionHookCallee(scan.sourceFile)}(${path})`;
  return withEdits(
    {
      action: "use-value-for-render-read",
      confidence: "certain",
      disposition: "style",
      evidence: [
        `${path}.get() reads a proven Legend observable path in the render body of \`${owner.name}\``,
        `observer wraps \`${owner.name}\`, so the read already tracks and ${subscription} performs the same get() there`,
        "Legend State deprecates render get() inside observer in favor of useValue",
      ],
      location: findingLocation(call, scan),
      message: `Replace \`${path}.get()\` with \`${subscription}\`; observer already tracks the read, so this follows Legend State's useValue guidance with no runtime effect.`,
      practice: "reactivity",
    },
    renderInitializerEdits(call, initializer, scan),
  );
}

function findingLocation(
  call: ts.CallExpression,
  scan: TrackingScan,
): LegendPracticeFinding["location"] {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(scan.sourceFile),
  );
  return { column: character + 1, file: scan.fileName, line: line + 1 };
}
