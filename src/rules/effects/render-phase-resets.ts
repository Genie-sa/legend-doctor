import type {
  EffectCandidate,
  RenderPhaseResetEdit,
  StateCandidate,
} from "../../analysis/model.js";
import { guardPinsInitialValue, printedExpression } from "./guarded-mount-writes.js";
import { isPureExpression, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import { nodeWithin, visit } from "../../core/ast.js";
import type { EffectClassificationContext } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { hasStableIdentity } from "./dependency-identity.js";
import { isPureCall } from "../in-place-memo-keys/primitive-selection.js";
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
      .filter((dependency) => !hasStableIdentity(dependency, owner, context))
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

/** Where a reset write runs: its owner, the analysis context, and the guard admitting it, if any. */
interface WriteScope {
  readonly context: EffectClassificationContext;
  readonly guard: ts.Expression | null;
  readonly owner: RuntimeFunctionLike;
}

function resetBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  owner: RuntimeFunctionLike,
  context: EffectClassificationContext,
): ResetBody | null {
  const scope: WriteScope = { context, guard: null, owner };
  if (!ts.isBlock(callback.body)) {
    const write = resetWrite(callback.body, scope);
    return write ? { reads: [write.call.arguments[0]!], writes: [write] } : null;
  }
  const { statements } = callback.body;
  const [guard] = statements;
  if (statements.length === 1 && guard && ts.isIfStatement(guard)) {
    return guardedResetBody(guard, scope);
  }
  const writes = statementWrites(statements, scope);
  return writes ? { reads: valuesOf(writes), writes } : null;
}

function guardedResetBody(guard: ts.IfStatement, scope: WriteScope): ResetBody | null {
  if (guard.elseStatement || !isPureExpression(guard.expression, isPureValueCall)) {
    return null;
  }
  const inner = ts.isBlock(guard.thenStatement)
    ? guard.thenStatement.statements
    : [guard.thenStatement];
  const writes = statementWrites(inner, { ...scope, guard: guard.expression });
  return writes ? { reads: [guard.expression, ...valuesOf(writes)], writes } : null;
}

function statementWrites(
  statements: readonly ts.Statement[],
  scope: WriteScope,
): ResetWrite[] | null {
  const writes: ResetWrite[] = [];
  for (const statement of statements) {
    const write = ts.isExpressionStatement(statement)
      ? resetWrite(statement.expression, scope)
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
  { context, guard, owner }: WriteScope,
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
    keepsMountValue(value!, state, guard)
    ? { call, state }
    : null;
}

/**
 * The effect also runs on mount, so the rewrite keeps the first commit only when that write is a
 * no-op: the value is the state's own initializer, which a deliberate placeholder render never is,
 * or the guard admits the write only where the initializer already evaluates to the same value.
 */
function keepsMountValue(
  value: ts.Expression,
  state: StateCandidate,
  guard: ts.Expression | null,
): boolean {
  const [initializer] = state.call.arguments;
  if (!initializer) {
    return false;
  }
  const initial = unwrapTransparentExpression(initializer);
  const lazy =
    ts.isArrowFunction(initial) && initial.parameters.length === 0 && !ts.isBlock(initial.body)
      ? unwrapTransparentExpression(initial.body)
      : initial;
  return (
    printedExpression(lazy) === printedExpression(unwrapTransparentExpression(value)) ||
    (guard !== null && guardPinsInitialValue(guard, value, lazy))
  );
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
 * The complete edit: a previous-value state and the writes, guarded by a changed dependency, during
 * render. The guard compares with `Object.is`, as React compares dependencies, so a `NaN` settles.
 */
export function renderPhaseResetInstruction(
  reset: RenderPhaseReset,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): string {
  const names = reset.compared.map((dependency) => dependency.getText());
  const [single] = names;
  const previous =
    names.length === 1 && single !== undefined
      ? {
          changed: `!Object.is(${single}, ${previousName(single)})`,
          declaration: `const [${previousName(single)}, ${setterName(previousName(single))}] = useState(${single})`,
          update: `${setterName(previousName(single))}(${single})`,
        }
      : {
          changed: names
            .map((name, index) => `!Object.is(${name}, prevDeps[${index}])`)
            .join(" || "),
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
