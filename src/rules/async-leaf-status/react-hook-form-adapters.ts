import { bindingDeclarationCount, unwrapTransparentExpression } from "../../core/analysis-ast.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { jsxAttributeIsIntrinsicEvent } from "./event-rooted-commands.js";
import { localFunctionBinding } from "../state-proofs/binding-lookup.js";
import ts from "typescript";
import { visitSkippingNestedRuntimeFunctions } from "../../core/ast.js";

export function directReactHookFormEventCallbacks(
  owner: RuntimeFunctionLike,
): ReadonlySet<RuntimeFunctionLike> {
  const callbacks = new Set<RuntimeFunctionLike>();
  if (!owner.body) {
    return callbacks;
  }
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      !ts.isJsxAttribute(node) ||
      !/^on[A-Z]/u.test(node.name.getText()) ||
      !node.initializer ||
      !ts.isJsxExpression(node.initializer) ||
      !node.initializer.expression ||
      !jsxAttributeIsIntrinsicEvent(node)
    ) {
      return;
    }
    const handler = unwrapTransparentExpression(node.initializer.expression);
    const collectAdapter = (adapter: ts.CallExpression): void => {
      if (!isReactHookFormSubmitAdapter(adapter, owner)) {
        return;
      }
      for (const argument of adapter.arguments) {
        const candidate = unwrapTransparentExpression(argument);
        if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
          callbacks.add(candidate);
        } else if (ts.isIdentifier(candidate)) {
          const callback = localFunctionBinding(owner, candidate.text);
          if (callback) {
            callbacks.add(callback);
          }
        }
      }
    };
    if (ts.isCallExpression(handler)) {
      collectAdapter(handler);
    } else if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
      visitSkippingNestedRuntimeFunctions(handler.body, (candidate) => {
        if (ts.isCallExpression(candidate)) {
          collectAdapter(candidate);
        }
      });
    }
  });
  return callbacks;
}

function isReactHookFormSubmitAdapter(
  call: ts.CallExpression,
  owner: RuntimeFunctionLike,
): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return (
      bindingDeclarationCount(owner, callee.text) === 1 &&
      ownerHasReactHookFormBinding(owner, callee.text, true)
    );
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "handleSubmit" &&
    ts.isIdentifier(callee.expression) &&
    bindingDeclarationCount(owner, callee.expression.text) === 1 &&
    ownerHasReactHookFormBinding(owner, callee.expression.text, false)
  );
}

function ownerHasReactHookFormBinding(
  owner: RuntimeFunctionLike,
  localName: string,
  destructuredHandleSubmit: boolean,
): boolean {
  if (!owner.body) {
    return false;
  }
  let matched = false;
  visitSkippingNestedRuntimeFunctions(owner.body, (node) => {
    if (
      matched ||
      !ts.isVariableDeclaration(node) ||
      !node.initializer ||
      !declarationBindsName(node, localName, destructuredHandleSubmit)
    ) {
      return;
    }
    const initializer = unwrapTransparentExpression(node.initializer);
    matched =
      isReactHookFormFactoryCall(initializer, owner) ||
      (destructuredHandleSubmit &&
        ts.isIdentifier(initializer) &&
        bindingDeclarationCount(owner, initializer.text) === 1 &&
        ownerHasReactHookFormBinding(owner, initializer.text, false));
  });
  return matched;
}

function declarationBindsName(
  node: ts.VariableDeclaration,
  localName: string,
  destructuredHandleSubmit: boolean,
): boolean {
  if (!destructuredHandleSubmit) {
    return ts.isIdentifier(node.name) && node.name.text === localName;
  }
  return (
    ts.isObjectBindingPattern(node.name) &&
    node.name.elements.some(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === localName &&
        (candidate.propertyName
          ? ts.isIdentifier(candidate.propertyName) &&
            candidate.propertyName.text === "handleSubmit"
          : candidate.name.text === "handleSubmit"),
    )
  );
}

function isReactHookFormFactoryCall(
  expression: ts.Expression,
  owner: RuntimeFunctionLike,
): boolean {
  const value = unwrapTransparentExpression(expression);
  if (!ts.isCallExpression(value)) {
    return false;
  }
  const callee = unwrapTransparentExpression(value.expression);
  if (!ts.isIdentifier(callee) || bindingDeclarationCount(owner, callee.text) !== 0) {
    return false;
  }
  return expression
    .getSourceFile()
    .statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "react-hook-form" &&
        statement.importClause !== undefined &&
        statement.importClause.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some(
          (specifier) =>
            specifier.name.text === callee.text &&
            ["useForm", "useFormContext"].includes(
              specifier.propertyName?.text ?? specifier.name.text,
            ),
        ),
    );
}
