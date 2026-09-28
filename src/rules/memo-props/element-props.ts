import type { IdentityContext, PropIdentity } from "./identity-model.js";
import { STABLE, fresh, unproven } from "./identity-model.js";
import { expressionIdentity } from "./prop-identity.js";
import { propertyNameText } from "../../core/analysis-ast.js";
import ts from "typescript";

/** One prop the element passes, as the memo comparison sees it. */
export interface ElementProp {
  readonly identity: PropIdentity;
  readonly name: string;
  /** The expression that produces the value; the element itself for a list of children. */
  readonly value: ts.Node;
}

/** Every prop the element hands its component, excluding `key`, which memo never compares. */
export function elementProps(
  element: ts.JsxOpeningLikeElement,
  context: IdentityContext,
): readonly ElementProp[] {
  const props = element.attributes.properties.flatMap((attribute) =>
    ts.isJsxAttribute(attribute)
      ? attributeProps(attribute, context)
      : spreadProps(attribute.expression, context),
  );
  return ts.isJsxOpeningElement(element) ? [...props, ...childrenProps(element, context)] : props;
}

function attributeProps(attribute: ts.JsxAttribute, context: IdentityContext): ElementProp[] {
  const name = ts.isIdentifier(attribute.name) ? attribute.name.text : attribute.name.getText();
  const { initializer } = attribute;
  if (name === "key") {
    return [];
  }
  if (!initializer || ts.isStringLiteral(initializer)) {
    return [{ identity: STABLE, name, value: attribute }];
  }
  if (ts.isJsxExpression(initializer)) {
    return initializer.expression ? [expressionProp(name, initializer.expression, context)] : [];
  }
  return [{ identity: fresh("element", initializer), name, value: initializer }];
}

/** An object literal spread passes each of its members; any other spread passes unknown keys. */
function spreadProps(expression: ts.Expression, context: IdentityContext): ElementProp[] {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap((property) => spreadMemberProps(property, context));
  }
  const identity = expressionIdentity(expression, context);
  return [
    {
      identity:
        identity.kind === "stable" ? STABLE : unproven("a spread whose members are not visible"),
      name: `...${expression.getText()}`,
      value: expression,
    },
  ];
}

function spreadMemberProps(
  property: ts.ObjectLiteralElementLike,
  context: IdentityContext,
): ElementProp[] {
  if (ts.isSpreadAssignment(property)) {
    return spreadProps(property.expression, context);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return [expressionProp(property.name.text, property.name, context)];
  }
  const name = property.name ? propertyNameText(property.name) : null;
  if (ts.isPropertyAssignment(property) && name !== null) {
    return name === "key" ? [] : [expressionProp(name, property.initializer, context)];
  }
  return [
    {
      identity: unproven("a computed or accessor member"),
      name: property.getText(),
      value: property,
    },
  ];
}

/** Children arrive as one `children` prop: a single value, or a list allocated per render. */
function childrenProps(element: ts.JsxOpeningElement, context: IdentityContext): ElementProp[] {
  const { parent } = element;
  const children = parent.children.filter(
    (child) =>
      !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) &&
      !(ts.isJsxExpression(child) && !child.expression),
  );
  const [only, ...rest] = children;
  if (!only) {
    return [];
  }
  return rest.length > 0
    ? [{ identity: fresh("children list", parent), name: "children", value: parent }]
    : [singleChildProp(only, context)];
}

function singleChildProp(child: ts.JsxChild, context: IdentityContext): ElementProp {
  if (ts.isJsxText(child)) {
    return { identity: STABLE, name: "children", value: child };
  }
  if (ts.isJsxExpression(child) && child.expression) {
    return expressionProp("children", child.expression, context);
  }
  return { identity: fresh("element", child), name: "children", value: child };
}

function expressionProp(name: string, value: ts.Expression, context: IdentityContext): ElementProp {
  return { identity: expressionIdentity(value, context), name, value };
}
