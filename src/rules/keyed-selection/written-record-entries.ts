import { accessPathFromBinding, accessPathsEqual } from "./rendered-record-entries.js";
import {
  bindingDeclarationCount,
  isDeclarationName,
  isNonValueIdentifier,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, nearestNestedFunction, nodeWithin, visit } from "../../core/ast.js";
import type { ChildContractResolver } from "../child-contract/model.js";
import type { KeyedRecordEntry } from "./model.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import { nearestRepeatedRenderCall } from "../state-proofs/jsx-subtrees.js";
import ts from "typescript";

interface WrittenRecordEntryCheck {
  call: ts.CallExpression;
  childContracts: ChildContractResolver | null;
  key: ts.Expression;
  state: StateCandidate;
}

export function writtenRecordEntry(check: WrittenRecordEntryCheck): KeyedRecordEntry | null {
  const { call, childContracts, key, state } = check;
  const direct = directRepeatedRecordEntry(check);
  if (direct) {
    return direct;
  }
  const command = writeCommandFunction(call, state.owner);
  const match = command && commandParameterMatch(command, key);
  if (!command || !match) {
    return null;
  }
  return recordCommandEntry({
    childContracts,
    command,
    parameterIndex: match.index,
    state,
    suffix: match.suffix,
  });
}

function directRepeatedRecordEntry(check: WrittenRecordEntryCheck): KeyedRecordEntry | null {
  const { call, childContracts, key, state } = check;
  const repeated = nearestRepeatedRenderCall(call, state.owner);
  const callback = repeated?.arguments[0];
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !callback.parameters[0] ||
    !ts.isIdentifier(callback.parameters[0]!.name)
  ) {
    return null;
  }
  const path = accessPathFromBinding(key, callback.parameters[0]!.name.text);
  return path && path.length > 0 && jsxEventCallIsDeferred(call, state.owner, childContracts)
    ? { path, repeated }
    : null;
}

function writeCommandFunction(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression | null {
  const command = nearestNestedFunction(call, owner);
  return command &&
    (ts.isArrowFunction(command) ||
      ts.isFunctionDeclaration(command) ||
      ts.isFunctionExpression(command))
    ? command
    : null;
}

interface CommandParameterMatch {
  index: number;
  suffix: readonly string[];
}

function commandParameterMatch(
  command: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
  key: ts.Expression,
): CommandParameterMatch | null {
  const matches = command.parameters.flatMap((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) {
      return [];
    }
    const suffix = accessPathFromBinding(key, parameter.name.text);
    return suffix ? [{ index, suffix }] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

interface RecordCommandEntryCheck {
  childContracts: ChildContractResolver | null;
  command: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
  parameterIndex: number;
  state: StateCandidate;
  suffix: readonly string[];
}

function recordCommandEntry(check: RecordCommandEntryCheck): KeyedRecordEntry | null {
  const { command, state } = check;
  const name = localRuntimeFunctionName(command);
  if (!name || bindingDeclarationCount(state.owner, name) !== 1) {
    return null;
  }
  let references = 0;
  let result: KeyedRecordEntry | null = null;
  let safe = true;
  visit(state.owner.body, (node) => {
    if (
      !safe ||
      !ts.isIdentifier(node) ||
      node.text !== name ||
      isDeclarationName(node) ||
      isNonValueIdentifier(node)
    ) {
      return;
    }
    references += 1;
    const entry = commandInvocationEntry(node, check);
    if (
      !entry ||
      (result && (result.repeated !== entry.repeated || !accessPathsEqual(result.path, entry.path)))
    ) {
      safe = false;
      return;
    }
    result = entry;
  });
  return safe && references > 0 ? result : null;
}

function commandInvocationEntry(
  node: ts.Identifier,
  check: RecordCommandEntryCheck,
): KeyedRecordEntry | null {
  const invocation = node.parent;
  if (!ts.isCallExpression(invocation) || invocation.expression !== node) {
    return null;
  }
  const render = deferredRepeatedInvocation(invocation, check);
  const prefix = render && accessPathFromBinding(render.argument, render.itemName);
  const path = prefix ? [...prefix, ...check.suffix] : null;
  return render && path && path.length > 0 ? { path, repeated: render.repeated } : null;
}

interface DeferredRepeatedInvocation {
  argument: ts.Expression;
  itemName: string;
  repeated: ts.CallExpression;
}

function deferredRepeatedInvocation(
  invocation: ts.CallExpression,
  check: RecordCommandEntryCheck,
): DeferredRepeatedInvocation | null {
  const { childContracts, parameterIndex, state } = check;
  const repeated = nearestRepeatedRenderCall(invocation, state.owner);
  const callback = repeated?.arguments[0];
  const argument = invocation.arguments[parameterIndex];
  if (
    !repeated ||
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !callback.parameters[0] ||
    !ts.isIdentifier(callback.parameters[0]!.name) ||
    !argument ||
    ts.isSpreadElement(argument) ||
    !jsxEventCallIsDeferred(invocation, state.owner, childContracts)
  ) {
    return null;
  }
  return { argument, itemName: callback.parameters[0]!.name.text, repeated };
}

function jsxEventCallIsDeferred(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
  childContracts: ChildContractResolver | null,
): boolean {
  const attribute = findAncestorUntil(call, ts.isJsxAttribute, owner);
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression ||
    !nodeWithin(call, attribute.initializer.expression)
  ) {
    return false;
  }
  const opening = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return false;
  }
  const component = opening.tagName.getText();
  if (/^[a-z]/u.test(component)) {
    return true;
  }
  return (
    childContracts !== null &&
    (childContracts.frameworkEventComponent(component) ||
      childContracts.componentCallbackPropIsDeferred(component, attribute.name.getText()))
  );
}

function localRuntimeFunctionName(
  callback: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
): string | null {
  if (ts.isFunctionDeclaration(callback)) {
    return callback.name?.text ?? null;
  }
  return ts.isVariableDeclaration(callback.parent) &&
    callback.parent.initializer === callback &&
    ts.isIdentifier(callback.parent.name)
    ? callback.parent.name.text
    : null;
}
