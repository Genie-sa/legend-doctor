import type { ObservableReadScan, UseValueDeclaration } from "./model.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  staticPropertyPath,
} from "../../core/analysis-ast.js";
import {
  directGetReceiver,
  identifiedUseValueDeclaration,
  isValueReferenceTo,
  outermostTransparentParent,
  provenObservablePath,
} from "./observable-paths.js";
import {
  hasUnstableSubtreeLifetime,
  jsxElementCount,
  jsxElementCountIn,
} from "../state-proofs/jsx-subtrees.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasAncestorUseValueSubscription } from "./move-down.js";
import { hasUnprovenOwnerWork } from "./owner-subscription-work.js";
import { isInsideOwnerReturn } from "./conditional-jsx-slots.js";
import { propIsPrimitiveValueConsumer } from "../child-contract/child-contract.js";
import { subscriptionCut } from "./subscription-cut.js";
import { subscriptionFlow } from "./subscription-flow.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export function moveUseValueIntoChildFinding(
  declaration: ts.VariableDeclaration,
  scan: ObservableReadScan,
): LegendPracticeFinding | null {
  const use = scan.childContracts ? identifiedUseValueDeclaration(declaration, scan) : null;
  if (
    !use ||
    bindingDeclarationCount(use.owner, use.localName) !== 1 ||
    hasUnprovenOwnerWork(use.owner, scan) ||
    hasAncestorUseValueSubscription(use.call, use.owner, scan) ||
    hasOtherGetReadOfPath(use.owner, use.observable, scan.observableBindings)
  ) {
    return null;
  }
  const reference = soleValueReference(use);
  const transport = reference ? directJsxPropTransport(reference) : null;
  if (!transport || !childAcceptsPrimitiveProp(transport, use.owner, scan)) {
    return null;
  }
  const cut = subscriptionCut(
    subscriptionFlow(use, scan),
    [
      {
        leaf: transport.subtree,
        node: transport.subtree,
        references: [reference!],
        ownerElements: jsxElementCount(use.owner),
        leafElements: jsxElementCountIn(transport.subtree),
      },
    ],
    scan,
  );
  cut.boundaries = cut.boundaries.map((boundary) => ({ ...boundary, kind: "existing-child" }));
  return { ...moveIntoChildFinding(use, transport, scan), subscription: cut };
}

function soleValueReference(use: UseValueDeclaration): ts.Identifier | null {
  let reference: ts.Identifier | null = null;
  let unsafe = false;
  visit(use.owner.body, (node) => {
    if (unsafe || !isValueReferenceTo(node, use.localName, use.declaration.name)) {
      return;
    }
    if (isDeclarationName(node) || reference !== null) {
      unsafe = true;
      return;
    }
    reference = node;
  });
  return unsafe ? null : reference;
}

function childAcceptsPrimitiveProp(
  transport: DirectJsxPropTransport,
  owner: RuntimeFunctionLike,
  scan: ObservableReadScan,
): boolean {
  if (
    !isInsideOwnerReturn(transport.subtree, owner) ||
    hasUnstableSubtreeLifetime(transport.subtree, owner)
  ) {
    return false;
  }
  const child = scan.childContracts?.resolveComponent(transport.component);
  return Boolean(child && propIsPrimitiveValueConsumer(child, transport.prop));
}

function moveIntoChildFinding(
  use: UseValueDeclaration,
  transport: DirectJsxPropTransport,
  scan: ObservableReadScan,
): LegendPracticeFinding {
  const { line, character } = scan.sourceFile.getLineAndCharacterOfPosition(
    use.declaration.getStart(scan.sourceFile),
  );
  const observablePath = use.observable.getText(scan.sourceFile);
  return {
    action: "move-use-value-into-child",
    confidence: "certain",
    disposition: "change",
    evidence: [
      `the ${use.localName} binding is referenced once, as the direct \`${transport.prop}\` prop of source-resolved \`${transport.component}\``,
      "the child is not React-wrapped, declares that prop as a primitive value, and consumes it",
      "the child call site is unkeyed, unrepeated, unconditional, and owned by the component's only render return",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message: `Move \`useValue(${observablePath})\` out of this owner: pass \`${observablePath}\` to \`${transport.component}\` as an observable prop and subscribe inside the child, using the resulting primitive for \`${transport.prop}\`. Updates will rerender the existing child without rerunning this owner.`,
    practice: "reactivity",
  };
}

function hasOtherGetReadOfPath(
  owner: RuntimeFunctionLike,
  observable: ts.Expression,
  observableBindings: ReadonlySet<string>,
): boolean {
  if (!owner.body) {
    return true;
  }
  const currentPath = staticPropertyPath(observable);
  if (!currentPath) {
    return true;
  }
  let overlap = false;
  visit(owner.body, (node) => {
    if (overlap || !ts.isCallExpression(node)) {
      return;
    }
    const receiver = directGetReceiver(node);
    const other = receiver && provenObservablePath(receiver, observableBindings);
    const otherPath = other && staticPropertyPath(other);
    if (!otherPath) {
      return;
    }
    const shared = Math.min(currentPath.length, otherPath.length);
    overlap = currentPath.slice(0, shared).every((part, index) => part === otherPath[index]);
  });
  return overlap;
}

interface DirectJsxPropTransport {
  component: string;
  prop: string;
  subtree: ts.JsxElement | ts.JsxSelfClosingElement;
}

function isTransportableJsxProp(prop: string): boolean {
  return prop !== "children" && prop !== "key" && prop !== "ref" && !/^on[A-Z]/u.test(prop);
}

function directJsxPropTransport(reference: ts.Identifier): DirectJsxPropTransport | null {
  const expression = outermostTransparentParent(reference);
  const container = expression.parent;
  if (
    !ts.isJsxExpression(container) ||
    container.expression !== expression ||
    !ts.isJsxAttribute(container.parent)
  ) {
    return null;
  }
  const attribute = container.parent;
  const opening = attribute.parent.parent;
  const prop = attribute.name.getText();
  if (
    (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) ||
    !isTransportableJsxProp(prop)
  ) {
    return null;
  }
  return {
    component: opening.tagName.getText(),
    prop,
    subtree: ts.isJsxOpeningElement(opening) ? opening.parent : opening,
  };
}
