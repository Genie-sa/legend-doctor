import type {
  EffectCandidate,
  RenderPhaseResetEdit,
  StateCandidate,
} from "../../analysis/model.js";
import { isPrimitive, isPureCall } from "../in-place-memo-keys/primitive-selection.js";
import { isPureExpression, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { nodeWithin, visit } from "../../core/ast.js";
import type { EffectClassificationContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isCustomHookOwner } from "../../analysis/ast-helpers.js";
import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";

export interface RenderPhaseReset {
  /** Dependencies the reset compares; stable setters need no comparison. */
  readonly compared: readonly ts.Expression[];
  readonly targets: readonly ResetWrite[];
  /** Compared dependencies whose identity between renders no local fact proves. */
  readonly unprovenDependencies: readonly string[];
}

interface ResetWrite {
  readonly call: ts.CallExpression;
  readonly state: StateCandidate;
}

/**
 * An effect that only sets the owner's state from render-safe values when its dependencies
 * change commits a stale render first. Comparing the dependencies with their previous values
 * during render applies the same writes before that commit.
 */
export function findRenderPhaseReset(
  effect: EffectCandidate,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: EffectClassificationContext,
): RenderPhaseReset | null {
  const { dependencies, owner } = effect;
  if (
    !owner ||
    !dependencies ||
    dependencies.elements.length === 0 ||
    callback.parameters.length > 0 ||
    callback.asteriskToken ||
    callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  ) {
    return null;
  }
  const body = resetBody(callback, owner, context);
  if (!body || !dependencies.elements.every(isDependencyPath)) {
    return null;
  }
  const compared = dependencies.elements.filter(
    (dependency) => !(ts.isIdentifier(dependency) && context.stateBySetter.has(dependency.text)),
  );
  if (compared.length === 0 || mayLoopOrReadStale(compared, body, owner)) {
    return null;
  }
  return {
    compared,
    targets: body.writes,
    unprovenDependencies: compared
      .filter((dependency) => !hasStableIdentity(dependency, owner, context.stateByValue))
      .map((dependency) => dependency.getText()),
  };
}

/** A rebuilt dependency never compares equal, and a read of a written state sees its stale value. */
function mayLoopOrReadStale(
  compared: readonly ts.Expression[],
  body: ResetBody,
  owner: RuntimeFunctionLike,
): boolean {
  const targetNames = new Set(body.writes.map(({ state }) => state.valueName));
  return (
    compared.some((dependency) => isRebuiltEachRender(dependency, owner)) ||
    compared.some((dependency) => readsAny(dependency, targetNames)) ||
    body.reads.some((node) => readsAny(node, targetNames))
  );
}

interface ResetBody {
  /** Guard conditions and written values, which run during render after the rewrite. */
  readonly reads: readonly ts.Node[];
  readonly writes: readonly ResetWrite[];
}

function resetBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): ResetBody | null {
  if (!ts.isBlock(callback.body)) {
    const write = resetWrite(callback.body, owner, context);
    return write ? { reads: [write.call.arguments[0]!], writes: [write] } : null;
  }
  const { statements } = callback.body;
  const [guard] = statements;
  if (statements.length === 1 && guard && ts.isIfStatement(guard)) {
    return guardedResetBody(guard, owner, context);
  }
  const writes = statementWrites(statements, owner, context);
  return writes ? { reads: valuesOf(writes), writes } : null;
}

function guardedResetBody(
  guard: ts.IfStatement,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): ResetBody | null {
  if (guard.elseStatement || !isPureExpression(guard.expression, isPureValueCall)) {
    return null;
  }
  const inner = ts.isBlock(guard.thenStatement)
    ? guard.thenStatement.statements
    : [guard.thenStatement];
  const writes = statementWrites(inner, owner, context);
  return writes ? { reads: [guard.expression, ...valuesOf(writes)], writes } : null;
}

function statementWrites(
  statements: readonly ts.Statement[],
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): ResetWrite[] | null {
  const writes: ResetWrite[] = [];
  for (const statement of statements) {
    const write = ts.isExpressionStatement(statement)
      ? resetWrite(statement.expression, owner, context)
      : null;
    if (!write || writes.some(({ state }) => state === write.state)) {
      return null;
    }
    writes.push(write);
  }
  return writes.length > 0 ? writes : null;
}

function resetWrite(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): ResetWrite | null {
  const call = unwrapTransparentExpression(expression);
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.arguments.length !== 1
  ) {
    return null;
  }
  const state = context.stateBySetter.get(call.expression.text);
  const [value] = call.arguments;
  return state &&
    state.owner === owner &&
    isPureExpression(value!, isPureValueCall) &&
    writesInitialValue(value!, state)
    ? { call, state }
    : null;
}

/**
 * The effect also runs on mount, so the rewrite keeps the first commit only when that write is a
 * no-op: the value is the state's own initializer, which a deliberate placeholder render never is.
 */
function writesInitialValue(value: ts.Expression, state: StateCandidate): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const initial = unwrapTransparentExpression(initializer);
  const lazy =
    ts.isArrowFunction(initial) && initial.parameters.length === 0 && !ts.isBlock(initial.body)
      ? unwrapTransparentExpression(initial.body)
      : initial;
  return printed(lazy) === printed(unwrapTransparentExpression(value));
}

const PRINTER = ts.createPrinter({ removeComments: true });

/** Source tokens without their layout, so an equal literal at another indentation compares equal. */
function printed(node: ts.Expression): string {
  return PRINTER.printNode(ts.EmitHint.Expression, node, node.getSourceFile());
}

function isPureValueCall(call: ts.CallExpression): boolean {
  return isPureCall(call, call.getSourceFile());
}

function valuesOf(writes: readonly ResetWrite[]): ts.Node[] {
  return writes.map(({ call }) => call.arguments[0]!);
}

function isDependencyPath(dependency: ts.Expression): boolean {
  const node = unwrapTransparentExpression(dependency);
  return (
    ts.isIdentifier(node) ||
    ((ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) &&
      isDependencyPath(node.expression))
  );
}

/** A read of a written state would see its stale value. */
function readsAny(node: ts.Node, names: ReadonlySet<string>): boolean {
  let reads = false;
  visit(node, (current) => {
    reads ||=
      ts.isIdentifier(current) &&
      names.has(current.text) &&
      !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current);
  });
  return reads;
}

/** A function, object, or array the owner creates in its body is a new reference on every render. */
function isRebuiltEachRender(dependency: ts.Expression, owner: RuntimeFunctionLike): boolean {
  const node = unwrapTransparentExpression(dependency);
  const binding = ts.isIdentifier(node) ? lexicalBinding(node) : null;
  if (binding?.kind === "function") {
    return nodeWithin(binding.declaration, owner);
  }
  if (binding?.kind !== "value" || !nodeWithin(binding.declaration, owner)) {
    return false;
  }
  const initializer =
    ts.isVariableDeclaration(binding.declaration) && ts.isIdentifier(binding.declaration.name)
      ? binding.declaration.initializer
      : undefined;
  const value = initializer && unwrapTransparentExpression(initializer);
  return (
    value !== undefined &&
    (ts.isArrowFunction(value) ||
      ts.isFunctionExpression(value) ||
      ts.isObjectLiteralExpression(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isNewExpression(value))
  );
}

/**
 * React keeps a state value's identity until its setter runs, a binding outside the owner does
 * not change between its renders, a length or other primitive compares by value, and React re-runs
 * a component after a render-phase update with the same props, so comparing them settles.
 */
function hasStableIdentity(
  dependency: ts.Expression,
  owner: RuntimeFunctionLike,
  stateByValue: ReadonlyMap<string, StateCandidate>,
): boolean {
  const node = unwrapTransparentExpression(dependency);
  const root = pathRoot(node);
  const binding = root && lexicalBinding(root);
  if (
    (ts.isPropertyAccessExpression(node) && node.name.text === "length") ||
    binding?.kind === "import"
  ) {
    return true;
  }
  if (!root || !binding || binding.kind === "ambient") {
    return false;
  }
  const state = stateByValue.get(root.text);
  return (
    !nodeWithin(binding.declaration, owner) ||
    (state?.owner === owner && nodeWithin(binding.declaration, state.call.parent)) ||
    isPrimitiveConstant(binding.declaration) ||
    isComponentProp(root.text, binding.declaration, owner)
  );
}

/** A primitive compares by value, so recomputing it on every render still settles. */
function isPrimitiveConstant(declaration: ts.Node): boolean {
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0 &&
    declaration.initializer !== undefined &&
    isPrimitive(declaration.initializer, declaration.getSourceFile())
  );
}

function pathRoot(node: ts.Expression): ts.Identifier | null {
  const inner = unwrapTransparentExpression(node);
  if (ts.isIdentifier(inner)) {
    return inner;
  }
  return ts.isPropertyAccessExpression(inner) ? pathRoot(inner.expression) : null;
}

/** A destructuring default builds a new value on every render the prop is missing. */
function isComponentProp(name: string, declaration: ts.Node, owner: RuntimeFunctionLike): boolean {
  return (
    ts.isParameter(declaration) &&
    declaration.parent === owner &&
    !declaration.initializer &&
    !isCustomHookOwner(owner) &&
    bindsWithoutDefault(declaration.name, name)
  );
}

function bindsWithoutDefault(pattern: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(pattern)) {
    return pattern.text === name;
  }
  return pattern.elements.some(
    (element) =>
      ts.isBindingElement(element) &&
      !element.initializer &&
      bindsWithoutDefault(element.name, name),
  );
}

/** The complete edit: a previous-value state and the writes, guarded by a changed dependency, during render. */
export function renderPhaseResetInstruction(
  reset: RenderPhaseReset,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): string {
  const names = reset.compared.map((dependency) => dependency.getText());
  const [single] = names;
  const previous =
    names.length === 1 && single !== undefined
      ? {
          changed: `${single} !== ${previousName(single)}`,
          declaration: `const [${previousName(single)}, ${setterName(previousName(single))}] = useState(${single})`,
          update: `${setterName(previousName(single))}(${single})`,
        }
      : {
          changed: names.map((name, index) => `${name} !== prevDeps[${index}]`).join(" || "),
          declaration: `const [prevDeps, setPrevDeps] = useState([${names.join(", ")}])`,
          update: `setPrevDeps([${names.join(", ")}])`,
        };
  const body = (
    ts.isBlock(callback.body)
      ? callback.body.statements.map((statement) => statement.getText()).join(" ")
      : `${callback.body.getText()};`
  ).replaceAll(/\s+/gu, " ");
  return `Reset ${reset.targets.map(({ state }) => `\`${state.valueName}\``).join(", ")} during render instead of after a stale commit: add \`${previous.declaration}\`, then after the values it reads are declared run \`if (${previous.changed}) { ${previous.update}; ${body} }\`, and delete this effect.`;
}

function previousName(dependency: string): string {
  const words = dependency.split(/[^\w$]+/u).filter(Boolean);
  return `prev${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("")}`;
}

function setterName(name: string): string {
  return `set${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** The reset's instruction, its targets, and the dependency identities still to confirm. */
export function renderPhaseResetEdit(
  reset: RenderPhaseReset,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): RenderPhaseResetEdit {
  return {
    instruction: renderPhaseResetInstruction(reset, callback),
    targets: reset.targets.map(({ state }) => state),
    unprovenDependencies: reset.unprovenDependencies,
  };
}

/** "`a` keeps its identity" or "`a`, `b` keep their identity". */
export function identityClaim(dependencies: readonly string[]): string {
  const listed = dependencies.map((name) => `\`${name}\``).join(", ");
  return dependencies.length === 1
    ? `${listed} keeps its identity`
    : `${listed} keep their identity`;
}
