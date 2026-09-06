import { bindingDeclarationCount, isNonValueIdentifier } from "../../core/analysis-ast.js";
import {
  isRuntimeFunctionLike,
  nodeWithin,
  visit,
  visitSkippingNestedRuntimeFunctions,
} from "../../core/ast.js";
import type { StateCandidate } from "../model.js";
import ts from "typescript";

export interface ClosureConfinedReferences {
  readonly movedDeclarations: readonly string[];
  readonly nodes: readonly ts.Node[];
  /** The one owner return whose JSX holds every confined reference. */
  readonly returned: ts.Expression;
}

interface OwnerLevelConst {
  readonly declaration: ts.VariableDeclaration;
  readonly name: string;
}

interface ConfinementScope {
  readonly body: ts.Block;
  readonly returns: readonly ts.Expression[];
}

interface MovedDeclarations {
  readonly declarations: ReadonlyMap<string, OwnerLevelConst>;
  readonly uses: readonly ts.Node[];
}

interface UseSinks {
  readonly pending: ts.Node[];
  readonly uses: ts.Node[];
}

interface CollectedDeclarations {
  readonly declarations: Map<string, OwnerLevelConst>;
  readonly sinks: UseSinks;
}

/**
 * Every reference to the state or its setter either sits inside one of the owner's returned JSX
 * expressions or inside an owner-level `const` whose own references all sit there, directly or
 * through further such constants. Those declarations move into the extracted leaf together with the
 * state, so their JSX use sites stand in for the references they hold. A reference outside both
 * places, a shadowed name, a declaration nobody reads, or JSX uses split across two returns rejects
 * the proof; an owner with alternate returns keeps the state's ownership above the extracted leaf.
 */
export function closureConfinedReferences(state: StateCandidate): ClosureConfinedReferences | null {
  const scope = confinementScope(state);
  const moved = scope ? movedDeclarationsFor(state, scope) : null;
  if (!scope || !moved) {
    return null;
  }
  const nodes: ts.Node[] = [
    ...stateReferences(state).filter((reference) => returnHolding(reference, scope) !== null),
    ...moved.uses,
  ];
  const returned = soleReturnHolding(nodes, scope);
  return returned && nodes.every((node) => sitsInDirectRenderPosition(node, returned))
    ? { movedDeclarations: [...moved.declarations.keys()].toSorted(), nodes, returned }
    : null;
}

function returnHolding(node: ts.Node, { returns }: ConfinementScope): ts.Expression | null {
  return returns.find((returned) => nodeWithin(node, returned)) ?? null;
}

function soleReturnHolding(
  nodes: readonly ts.Node[],
  scope: ConfinementScope,
): ts.Expression | null {
  const holders = new Set(nodes.map((node) => returnHolding(node, scope)));
  const [returned] = holders;
  return holders.size === 1 && returned ? returned : null;
}

/**
 * A reference inside the returned JSX may sit in the render output itself or inside an event handler
 * attribute; a render callback handed to a child runs on that child's schedule, so its references do
 * not belong to this owner's render.
 */
function sitsInDirectRenderPosition(node: ts.Node, returned: ts.Expression): boolean {
  for (let current: ts.Node = node; current !== returned; current = current.parent) {
    if (isRuntimeFunctionLike(current) && !isJsxEventHandler(current)) {
      return false;
    }
  }
  return true;
}

function isJsxEventHandler(callback: ts.Node): boolean {
  const expression = callback.parent;
  const attribute = expression.parent;
  return (
    ts.isJsxExpression(expression) &&
    ts.isJsxAttribute(attribute) &&
    /^on[A-Z]/u.test(attribute.name.getText())
  );
}

function movedDeclarationsFor(
  state: StateCandidate,
  scope: ConfinementScope,
): MovedDeclarations | null {
  const collected: CollectedDeclarations = {
    declarations: new Map(),
    sinks: { pending: outsideStateReferences(state, scope), uses: [] },
  };
  while (collected.sinks.pending.length > 0) {
    if (!moveNextDeclaration(state, scope, collected)) {
      return null;
    }
  }
  return { declarations: collected.declarations, uses: collected.sinks.uses };
}

function moveNextDeclaration(
  state: StateCandidate,
  scope: ConfinementScope,
  { declarations, sinks }: CollectedDeclarations,
): boolean {
  const declaration = ownerLevelConstDeclaration(sinks.pending.pop()!, scope.body);
  if (!declaration || bindingDeclarationCount(state.owner, declaration.name) !== 1) {
    return false;
  }
  if (declarations.has(declaration.name)) {
    return true;
  }
  declarations.set(declaration.name, declaration);
  return collectDeclarationUses(declaration, scope, sinks);
}

function outsideStateReferences(state: StateCandidate, scope: ConfinementScope): ts.Node[] {
  return stateReferences(state).filter((reference) => returnHolding(reference, scope) === null);
}

/** A declaration nobody reads has an unknown purpose, such as a side effect, so it does not move. */
function collectDeclarationUses(
  { declaration, name }: OwnerLevelConst,
  scope: ConfinementScope,
  { pending, uses }: UseSinks,
): boolean {
  const outside = identifierReferences(scope.body, name).filter(
    (use) => !nodeWithin(use, declaration),
  );
  for (const use of outside) {
    (returnHolding(use, scope) ? uses : pending).push(use);
  }
  return outside.length > 0;
}

function confinementScope({
  owner,
  setterName,
  valueName,
}: StateCandidate): ConfinementScope | null {
  const { body } = owner;
  const uniquelyBound =
    setterName !== null &&
    bindingDeclarationCount(owner, valueName) === 1 &&
    bindingDeclarationCount(owner, setterName) === 1;
  if (!body || !ts.isBlock(body) || !uniquelyBound) {
    return null;
  }
  const returns: ts.Expression[] = [];
  visitSkippingNestedRuntimeFunctions(body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
    }
  });
  return returns.length > 0 ? { body, returns } : null;
}

function stateReferences(state: StateCandidate): ts.Identifier[] {
  const { call, owner, setterName, valueName } = state;
  return identifierReferences(owner.body, valueName, setterName ?? undefined).filter(
    (reference) => !nodeWithin(reference, call.parent),
  );
}

function identifierReferences(
  scope: ts.Node | undefined,
  ...names: readonly (string | undefined)[]
): ts.Identifier[] {
  const wanted = new Set(names.filter((name) => name !== undefined));
  const references: ts.Identifier[] = [];
  visit(scope, (node) => {
    if (ts.isIdentifier(node) && wanted.has(node.text) && !isNonValueIdentifier(node)) {
      references.push(node);
    }
  });
  return references;
}

function ownerLevelConstDeclaration(reference: ts.Node, body: ts.Block): OwnerLevelConst | null {
  for (let current: ts.Node = reference; current !== body; current = current.parent) {
    const parent: ts.Node = current.parent;
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      ts.isVariableDeclarationList(parent) &&
      (parent.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isVariableStatement(parent.parent) &&
      parent.parent.parent === body
    ) {
      return { declaration: current, name: current.name.text };
    }
  }
  return null;
}
