import type { Hypothesis, HypothesisScope } from "./hypotheses.js";
import {
  bindingDeclarationCount,
  isNonValueIdentifier,
  unwrapTransparentExpression,
} from "../../core/analysis-ast.js";
import { findAncestorUntil, identifiersNamed, nearestNestedFunction } from "../../core/ast.js";
import { isBindingName } from "../../rules/child-contract/prop-bindings.js";
import { runtimeFunctionName } from "../ast-helpers.js";
import ts from "typescript";

/** Timing confirmation cannot establish execution through arbitrary control flow. */
function directAdapterCall(
  expression: ts.ArrowFunction | ts.FunctionExpression,
): ts.Expression | undefined {
  const { body } = expression;
  if (!ts.isBlock(body)) {
    return body;
  }
  const [statement] = body.statements;
  if (body.statements.length !== 1 || !statement) {
    return undefined;
  }
  return ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)
    ? statement.expression
    : undefined;
}

/** A direct JSX event reference or inline event adapter can be researched; an eager call cannot. */
function eventReference(reference: ts.Identifier, scope: HypothesisScope): ts.JsxAttribute | null {
  const attribute = findAncestorUntil(reference, ts.isJsxAttribute, scope.inputs.state.owner);
  const initializer = attribute?.initializer;
  if (
    !attribute ||
    !/^on[A-Z]/u.test(attribute.name.getText()) ||
    !initializer ||
    !ts.isJsxExpression(initializer) ||
    !initializer.expression
  ) {
    return null;
  }
  const expression = unwrapTransparentExpression(initializer.expression);
  if (expression === reference) {
    return attribute;
  }
  return isDirectAdapter(reference, expression, scope) ? attribute : null;
}

function isDirectAdapter(
  reference: ts.Identifier,
  expression: ts.Expression,
  scope: HypothesisScope,
): boolean {
  if (
    !ts.isCallExpression(reference.parent) ||
    reference.parent.expression !== reference ||
    nearestNestedFunction(reference, scope.inputs.state.owner) !== expression ||
    (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) ||
    expression.asteriskToken
  ) {
    return false;
  }
  const call = directAdapterCall(expression);
  return Boolean(call && unwrapTransparentExpression(call) === reference.parent);
}

function commandEventReferences(scope: HypothesisScope): readonly ts.JsxAttribute[] | null {
  const { state, usage } = scope.inputs;
  const commands = new Set(
    usage.setterCallNodes.map((call) => nearestNestedFunction(call, state.owner)),
  );
  const sites: ts.JsxAttribute[] = [];
  for (const command of commands) {
    const events = command ? eventsForCommand(runtimeFunctionName(command), scope) : null;
    if (!events) {
      return null;
    }
    sites.push(...events);
  }
  return sites.length > 0 ? sites : null;
}

function eventsForCommand(
  name: string | null,
  scope: HypothesisScope,
): readonly ts.JsxAttribute[] | null {
  if (!name || bindingDeclarationCount(scope.inputs.state.owner, name) !== 1) {
    return null;
  }
  const references = identifiersNamed(scope.inputs.state.owner.body, name).filter(
    (reference) => !isBindingName(reference) && !isNonValueIdentifier(reference),
  );
  const events = references.map((reference) => eventReference(reference, scope));
  return events.length === 0 || events.some((event) => event === null)
    ? null
    : events.filter((event) => event !== null);
}

/** The async interval and leaf cut have already passed; only command origins may be assumed. */
export function asyncCommandHypothesis(scope: HypothesisScope): Hypothesis | null {
  if (!scope.inputs.isUnprovenAsyncStatus) {
    return null;
  }
  const sites = commandEventReferences(scope);
  if (!sites) {
    return null;
  }
  const lines = [
    ...new Set(
      sites.map(
        (site) => scope.inputs.sourceFile.getLineAndCharacterOfPosition(site.getStart()).line + 1,
      ),
    ),
  ].toSorted((left, right) => left - right);
  const [line] = lines;
  if (line === undefined) {
    return null;
  }
  return {
    inputs: { ...scope.inputs, isAsyncLeafStatus: true, isUnprovenAsyncStatus: false },
    question: `The pending interval and leaf render boundary of \`${scope.inputs.state.valueName}\` are proven. Confirm every listed callback prop invokes its command only from a user event, never during render, memo calculation, effect setup, or subscription registration; keep the command and its async completion boundary unchanged.`,
    research: [
      {
        file: scope.reportFile,
        line,
        lines,
        total: sites.length,
        check:
          "Open every receiving component and follow this callback prop through wrappers to its event handler; a prop name alone does not prove event timing.",
      },
    ],
  };
}
