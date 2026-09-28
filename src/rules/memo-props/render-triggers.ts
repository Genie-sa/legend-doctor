import { collectBindingNames, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { RenderReach } from "./render-reach.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { bindingKey } from "./render-reach.js";
import { ownerHookName } from "./owner-hooks.js";
import { ownerLevelReferences } from "../../core/scope-references.js";
import ts from "typescript";

type StateHook = "useReducer" | "useState";

/** A hook result whose change renders the owner: React state or a Legend State subscription. */
export interface RenderTrigger {
  readonly declaration: ts.VariableDeclaration;
  readonly hook: StateHook | "useValue";
  /** Names bound to the rendered value; empty when a state's value is never bound. */
  readonly names: ReadonlySet<string>;
  /** The state setter or reducer dispatch, whose calls render the owner. */
  readonly setter: ts.Identifier | null;
}

/** Owner-level state and subscriptions that can render the owner on their own. */
export function renderTriggers(owner: RuntimeFunctionLike): readonly RenderTrigger[] {
  if (!owner.body || !ts.isBlock(owner.body)) {
    return [];
  }
  return owner.body.statements
    .filter((statement) => ts.isVariableStatement(statement))
    .flatMap((statement) => statement.declarationList.declarations)
    .flatMap((declaration) => {
      const trigger = declarationTrigger(declaration, owner);
      return trigger ? [trigger] : [];
    });
}

export function triggerReads(trigger: RenderTrigger, reach: RenderReach): boolean {
  return [...trigger.names].some((name) =>
    reach.bindings.has(bindingKey(trigger.declaration, name)),
  );
}

function declarationTrigger(
  declaration: ts.VariableDeclaration,
  owner: RuntimeFunctionLike,
): RenderTrigger | null {
  const initializer = declaration.initializer
    ? unwrapTransparentExpression(declaration.initializer)
    : null;
  const hook = initializer && ts.isCallExpression(initializer) ? ownerHookName(initializer) : null;
  if (hook === "useValue") {
    return { declaration, hook, names: boundNames(declaration.name), setter: null };
  }
  return hook === "useState" || hook === "useReducer"
    ? stateTrigger(declaration, hook, owner)
    : null;
}

/** A state renders the owner only when its setter is called; an unreferenced setter never is. */
function stateTrigger(
  declaration: ts.VariableDeclaration,
  hook: StateHook,
  owner: RuntimeFunctionLike,
): RenderTrigger | null {
  if (!ts.isArrayBindingPattern(declaration.name)) {
    return null;
  }
  const [value, setter] = declaration.name.elements;
  const setterName =
    setter && ts.isBindingElement(setter) && ts.isIdentifier(setter.name) ? setter.name : null;
  if (!setterName || ownerLevelReferences(owner, setterName).length === 0) {
    return null;
  }
  const names = value && ts.isBindingElement(value) ? boundNames(value.name) : new Set<string>();
  return { declaration, hook, names, setter: setterName };
}

function boundNames(name: ts.BindingName): ReadonlySet<string> {
  const names = new Set<string>();
  collectBindingNames(name, names);
  return names;
}
