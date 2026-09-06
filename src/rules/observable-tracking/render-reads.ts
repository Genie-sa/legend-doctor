import {
  bindingDeclarationCount,
  hookCallName,
  staticPropertyPath,
} from "../../core/analysis-ast.js";
import {
  directGetReceiver,
  isTrackingHookCall,
  outermostTransparentParent,
  provenObservablePath,
} from "../observable-reads/observable-paths.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { RenderOwner } from "./render-owners.js";
import type { TrackingScan } from "./model.js";
import { eagerReactiveInput } from "./reactive-inputs.js";
import { hasCoveringSubscription } from "./subscription-coverage.js";
import { renderOwnerOf } from "./render-owners.js";
import ts from "typescript";

interface RenderRead {
  readonly call: ts.CallExpression;
  readonly observable: ts.Expression;
  readonly owner: RenderOwner;
  readonly path: readonly string[];
}

/**
 * A `get()` on a proven observable path that executes during a component's or custom hook's
 * render without any tracking context. Nothing subscribes, so the value is read once per render
 * and the owner never re-renders when it changes. Reads that another rule owns (eager reactive
 * inputs, `useValue` arguments), reads handed to hooks as snapshots, `key` attributes, observer
 * components, and paths already covered by a `useValue` in the same owner are left alone.
 */
export function renderReadFinding(
  call: ts.CallExpression,
  scan: TrackingScan,
): LegendPracticeFinding | null {
  const read = untrackedRenderRead(call, scan);
  return read ? renderReadPractice(read, scan) : null;
}

function untrackedRenderRead(call: ts.CallExpression, scan: TrackingScan): RenderRead | null {
  const receiver = directGetReceiver(call);
  const observable = receiver && provenObservablePath(receiver, scan.observableBindings);
  const path = observable && staticPropertyPath(observable);
  if (
    !observable ||
    !path ||
    eagerReactiveInput(call, scan) ||
    isSnapshotPosition(call, scan.imports)
  ) {
    return null;
  }
  const owner = renderOwnerOf(call, scan.imports);
  if (!owner || owner.tracked || hasCoveringSubscription(owner.owner, path, scan)) {
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

function isDirectRenderInitializer(read: RenderRead): boolean {
  const declaration = outermostTransparentParent(read.call).parent;
  if (
    read.owner.hops > 0 ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !ts.isVariableStatement(declaration.parent.parent)
  ) {
    return false;
  }
  return declaration.parent.parent.parent === read.owner.owner.body;
}

function suggestedBindingName(read: RenderRead): string {
  const last = read.path.at(-1) ?? "value";
  const base = last.replace(/\$+$/u, "") || "value";
  const name = base.charAt(0).toLowerCase() + base.slice(1);
  return bindingDeclarationCount(read.owner.owner, name) === 0 ? name : `${name}Value`;
}

function renderReadPractice(read: RenderRead, scan: TrackingScan): LegendPracticeFinding {
  const { call, observable, owner } = read;
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(scan.sourceFile),
  );
  const path = observable.getText(scan.sourceFile);
  const subject =
    owner.kind === "component" ? `\`${owner.name}\`` : `components calling \`${owner.name}\``;
  const consequence = `the read runs in \`${owner.name}\` outside a tracking context (useValue, observer, or a reactive component), so ${subject} never re-render${owner.kind === "component" ? "s" : ""} when \`${path}\` changes`;
  const instruction = isDirectRenderInitializer(read)
    ? `Replace \`${path}.get()\` with \`useValue(${path})\``
    : `Subscribe with \`const ${suggestedBindingName(read)} = useValue(${path})\` at the top of \`${owner.name}\` and read \`${suggestedBindingName(read)}\` here`;
  return {
    action: "use-value-for-render-read",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${path}.get() reads a proven Legend observable path`,
      owner.hops === 0
        ? `the call executes directly in the render body of ${owner.kind} \`${owner.name}\``
        : `the call executes in a synchronous iteration callback of ${owner.kind} \`${owner.name}\`'s render`,
      `no useValue in \`${owner.name}\` subscribes to \`${path}\` or a parent path, and the component is not wrapped in observer`,
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `${instruction}; ${consequence}.`,
    practice: "reactivity",
  };
}
