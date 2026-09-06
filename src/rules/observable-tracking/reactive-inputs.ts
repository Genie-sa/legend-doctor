import type { HookImports, LegendReactComponent, LegendReaction } from "../../core/imports.js";
import {
  outermostTransparentParent,
  provenObservablePath,
} from "../observable-reads/observable-paths.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { TrackingScan } from "./model.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { visit } from "../../core/ast.js";

export interface EagerReactiveInput {
  readonly call: ts.CallExpression;
  readonly consequence: string;
  readonly observable: ts.Expression;
  readonly slot: string;
}

interface SnapshotRead {
  readonly method: "get" | "peek";
  readonly receiver: ts.Expression;
}

interface ReactiveSlot {
  readonly consequence: string;
  readonly slot: string;
}

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

const COMPONENT_SLOTS: ReadonlyMap<LegendReactComponent, ReadonlySet<string>> = new Map([
  ["For", new Set(["each"])],
  ["Show", new Set(["if", "ifReady"])],
  ["Switch", new Set(["value"])],
]);

const CHILD_COMPONENTS: ReadonlySet<LegendReactComponent> = new Set(["Computed", "Memo"]);

const REACTIONS: ReadonlySet<string> = new Set([
  "observe",
  "useObserve",
  "useObserveEffect",
  "useWhen",
  "useWhenReady",
  "when",
  "whenReady",
]);

const reactiveComponentsBySource = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * A `get()` or `peek()` snapshot handed to a Legend input that expects an observable or
 * selector: `Show if`, `Switch value`, `For each`, a `Memo`/`Computed` child, a `$`-prefixed
 * reactive prop, or the first argument of `observe`/`when` and their hooks. Legend can only
 * track what it receives, so the snapshot freezes the input at the parent's render.
 */
export function eagerReactiveInput(
  call: ts.CallExpression,
  scan: TrackingScan,
): EagerReactiveInput | null {
  const read = snapshotRead(call);
  const observable = read && provenObservablePath(read.receiver, scan.observableBindings);
  if (!read || !observable) {
    return null;
  }
  const outer = outermostTransparentParent(call);
  const slot = reactiveSlotFor(outer, scan);
  return slot ? { call, observable, ...slot } : null;
}

function snapshotRead(call: ts.CallExpression): SnapshotRead | null {
  if (
    call.arguments.length > 0 ||
    (call.typeArguments?.length ?? 0) > 0 ||
    call.questionDotToken ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.questionDotToken
  ) {
    return null;
  }
  const method = call.expression.name.text;
  if (method !== "get" && method !== "peek") {
    return null;
  }
  return { method, receiver: unwrapTransparentExpression(call.expression.expression) };
}

function reactiveSlotFor(outer: ts.Expression, scan: TrackingScan): ReactiveSlot | null {
  const { parent } = outer;
  if (ts.isJsxExpression(parent)) {
    const container = parent.parent;
    if (ts.isJsxAttribute(container)) {
      return attributeSlot(container, scan);
    }
    return ts.isJsxElement(container) ? childSlot(container.openingElement, scan.imports) : null;
  }
  if (ts.isCallExpression(parent) && parent.arguments[0] === outer) {
    return reactionSlot(parent, scan.imports);
  }
  return null;
}

function attributeSlot(attribute: ts.JsxAttribute, scan: TrackingScan): ReactiveSlot | null {
  const tag = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(tag) && !ts.isJsxSelfClosingElement(tag)) {
    return null;
  }
  const name = attribute.name.getText();
  const component = legendReactComponentOf(tag, scan.imports);
  if (component) {
    return COMPONENT_SLOTS.get(component)?.has(name)
      ? componentAttributeSlot(component, name)
      : null;
  }
  if (!name.startsWith("$") || !isReactiveHostTag(tag, scan)) {
    return null;
  }
  return {
    consequence:
      "the reactive prop tracks an observable or selector on its own, while the snapshot only updates when the parent re-renders",
    slot: `\`<${tag.tagName.getText()} ${name}>\``,
  };
}

function componentAttributeSlot(component: LegendReactComponent, name: string): ReactiveSlot {
  const slot = `\`<${component} ${name}>\``;
  if (component === "For") {
    return {
      consequence:
        "`For` calls `get()` on the collection it receives to track membership, so the raw array breaks that contract",
      slot,
    };
  }
  return {
    consequence: `\`${component}\` tracks the observable itself, while the snapshot only updates when the parent re-renders`,
    slot,
  };
}

function childSlot(tag: ts.JsxOpeningElement, imports: HookImports): ReactiveSlot | null {
  const component = legendReactComponentOf(tag, imports);
  if (!component || !CHILD_COMPONENTS.has(component)) {
    return null;
  }
  return {
    consequence: `\`${component}\` re-renders from its own observable, not from its parent, so the snapshot never updates`,
    slot: `\`<${component}>\``,
  };
}

function reactionSlot(call: ts.CallExpression, imports: HookImports): ReactiveSlot | null {
  const reaction = legendReactionOf(call, imports);
  if (!reaction) {
    return null;
  }
  const slot = `\`${reaction}\``;
  if (
    reaction === "when" ||
    reaction === "whenReady" ||
    reaction === "useWhen" ||
    reaction === "useWhenReady"
  ) {
    return {
      consequence: `\`${reaction}\` resolves the snapshot once instead of waiting for the observable to change`,
      slot,
    };
  }
  return {
    consequence: `\`${reaction}\` runs once against the snapshot instead of re-running when the observable changes`,
    slot,
  };
}

function legendReactComponentOf(tag: JsxTag, imports: HookImports): LegendReactComponent | null {
  const { tagName } = tag;
  if (ts.isIdentifier(tagName)) {
    return imports.legendReactComponents.get(tagName.text) ?? null;
  }
  if (
    ts.isPropertyAccessExpression(tagName) &&
    ts.isIdentifier(tagName.expression) &&
    imports.legendReactNamespaces.has(tagName.expression.text)
  ) {
    return canonicalComponent(tagName.name.text);
  }
  return null;
}

function canonicalComponent(name: string): LegendReactComponent | null {
  return name === "Computed" ||
    name === "For" ||
    name === "Memo" ||
    name === "Show" ||
    name === "Switch"
    ? name
    : null;
}

function legendReactionOf(call: ts.CallExpression, imports: HookImports): LegendReaction | null {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return imports.legendReactions.get(callee.text) ?? null;
  }
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    !REACTIONS.has(callee.name.text)
  ) {
    return null;
  }
  const namespace = callee.expression.text;
  const hook = callee.name.text.startsWith("use");
  const namespaces = hook ? imports.legendReactNamespaces : imports.legendNamespaces;
  return namespaces.has(namespace) ? canonicalReaction(callee.name.text) : null;
}

function canonicalReaction(name: string): LegendReaction | null {
  return name === "observe" ||
    name === "useObserve" ||
    name === "useObserveEffect" ||
    name === "useWhen" ||
    name === "useWhenReady" ||
    name === "when" ||
    name === "whenReady"
    ? name
    : null;
}

function isReactiveHostTag(tag: JsxTag, scan: TrackingScan): boolean {
  const { tagName } = tag;
  if (ts.isIdentifier(tagName)) {
    return (
      scan.imports.reactiveHosts.has(tagName.text) || reactiveComponentNames(scan).has(tagName.text)
    );
  }
  return (
    ts.isPropertyAccessExpression(tagName) &&
    ts.isIdentifier(tagName.expression) &&
    scan.imports.reactiveHosts.has(tagName.expression.text)
  );
}

function reactiveComponentNames(scan: TrackingScan): ReadonlySet<string> {
  const cached = reactiveComponentsBySource.get(scan.sourceFile);
  if (cached) {
    return cached;
  }
  const names = new Set<string>();
  visit(scan.sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    if (ts.isCallExpression(initializer) && isReactiveFactoryCall(initializer, scan.imports)) {
      names.add(node.name.text);
    }
  });
  reactiveComponentsBySource.set(scan.sourceFile, names);
  return names;
}

function isReactiveFactoryCall(call: ts.CallExpression, imports: HookImports): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return imports.reactiveFactories.has(callee.text) || imports.legendObservers.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    imports.legendReactNamespaces.has(callee.expression.text) &&
    (callee.name.text === "reactive" || callee.name.text === "reactiveObserver")
  );
}

export function eagerReactiveInputFinding(
  input: EagerReactiveInput,
  scan: TrackingScan,
): LegendPracticeFinding {
  const { call, consequence, observable, slot } = input;
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(scan.sourceFile),
  );
  const read = call.getText(scan.sourceFile);
  const path = observable.getText(scan.sourceFile);
  return {
    action: "pass-observable-to-reactive-input",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `${path} is a proven Legend observable path`,
      `${slot} accepts an observable or selector and tracks it in its own context`,
      "the snapshot is evaluated once in the parent's render and never tracked",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Replace \`${read}\` with \`${path}\` in ${slot}; ${consequence}.`,
    practice: "reactivity",
  };
}
