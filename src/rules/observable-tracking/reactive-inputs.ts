import type { HookImports, LegendReactComponent } from "../../core/imports.js";
import {
  outermostTransparentParent,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import type { TrackingScan } from "./model.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

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
 * Whether `read` is handed to a Legend input that expects an observable or selector: `Show if`,
 * `Switch value`, `For each`, a `Memo`/`Computed` child, a `$`-prefixed reactive prop, or the first
 * argument of `observe`/`when` and their hooks. Such an input tracks in its own context, so a
 * subscription in the parent cannot refresh the snapshot it received.
 */
export function isReactiveInputArgument(read: ts.Expression, scan: TrackingScan): boolean {
  const outer = outermostTransparentParent(read);
  const { parent } = outer;
  if (ts.isJsxExpression(parent)) {
    const container = parent.parent;
    if (ts.isJsxAttribute(container)) {
      return isReactiveAttribute(container, scan);
    }
    return (
      ts.isJsxElement(container) && isReactiveChildHost(container.openingElement, scan.imports)
    );
  }
  return (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === outer &&
    isLegendReaction(parent, scan.imports)
  );
}

function isReactiveAttribute(attribute: ts.JsxAttribute, scan: TrackingScan): boolean {
  const tag = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(tag) && !ts.isJsxSelfClosingElement(tag)) {
    return false;
  }
  const name = attribute.name.getText();
  const component = legendReactComponentOf(tag, scan.imports);
  if (component) {
    return COMPONENT_SLOTS.get(component)?.has(name) ?? false;
  }
  return name.startsWith("$") && isReactiveHostTag(tag, scan);
}

function isReactiveChildHost(tag: ts.JsxOpeningElement, imports: HookImports): boolean {
  const component = legendReactComponentOf(tag, imports);
  return component !== null && CHILD_COMPONENTS.has(component);
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

function isLegendReaction(call: ts.CallExpression, imports: HookImports): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return imports.legendReactions.has(callee.text);
  }
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    !REACTIONS.has(callee.name.text)
  ) {
    return false;
  }
  const hook = callee.name.text.startsWith("use");
  const namespaces = hook ? imports.legendReactNamespaces : imports.legendNamespaces;
  return namespaces.has(callee.expression.text);
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
