import { propertyNameText, unwrapTransparentExpression } from "./analysis-ast.js";
import ts from "typescript";

/** Local names that reach `synced` from `@legendapp/state/sync`, directly or through a namespace. */
export interface SyncedImports {
  readonly legendSyncNamespaces: ReadonlySet<string>;
  readonly synced: ReadonlySet<string>;
}

/** The dotted path of an observable's own value, as opposed to one of its members. */
export const ROOT_PATH = "";

/**
 * The value an observable factory call starts from. A `synced({ initial })` argument contributes its
 * literal `initial`; a synced call without a literal initial value has no provable starting value.
 */
export function observableInitialValue(
  factory: ts.CallExpression,
  imports: SyncedImports,
): ts.Expression | null {
  const [argument] = factory.arguments;
  if (!argument) {
    return null;
  }
  const value = unwrapTransparentExpression(argument);
  return ts.isCallExpression(value) && isSyncedCall(value, imports)
    ? syncedInitialValue(value)
    : value;
}

function syncedInitialValue(synced: ts.CallExpression): ts.Expression | null {
  const [options] = synced.arguments;
  const optionsObject = options ? unwrapTransparentExpression(options) : null;
  if (!optionsObject || !ts.isObjectLiteralExpression(optionsObject)) {
    return null;
  }
  const initial = staticProperties(optionsObject).get("initial");
  return initial ? unwrapTransparentExpression(initial) : null;
}

function isSyncedCall(call: ts.CallExpression, imports: SyncedImports): boolean {
  const { expression } = call;
  if (ts.isIdentifier(expression)) {
    return imports.synced.has(expression.text);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.legendSyncNamespaces.has(expression.expression.text) &&
    expression.name.text === "synced"
  );
}

/**
 * Dotted static paths inside an initial value whose literal is an array; the root path is the empty
 * string. Only members that a later spread or computed key cannot overwrite count.
 */
export function arrayLiteralPaths(initial: ts.Expression): ReadonlySet<string> {
  const paths = new Set<string>();
  collectArrayLiteralPaths(unwrapTransparentExpression(initial), ROOT_PATH, paths);
  return paths;
}

function collectArrayLiteralPaths(value: ts.Expression, path: string, paths: Set<string>): void {
  if (ts.isArrayLiteralExpression(value)) {
    paths.add(path);
    return;
  }
  if (!ts.isObjectLiteralExpression(value)) {
    return;
  }
  for (const [name, initializer] of staticProperties(value)) {
    const memberPath = path === ROOT_PATH ? name : `${path}.${name}`;
    collectArrayLiteralPaths(unwrapTransparentExpression(initializer), memberPath, paths);
  }
}

/**
 * Statically named property assignments in evaluation order. A spread or computed key drops every
 * earlier member because it may overwrite one, and a repeated name keeps only its last initializer.
 */
function staticProperties(object: ts.ObjectLiteralExpression): ReadonlyMap<string, ts.Expression> {
  const properties = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    recordStaticProperty(properties, property);
  }
  return properties;
}

function recordStaticProperty(
  properties: Map<string, ts.Expression>,
  property: ts.ObjectLiteralElementLike,
): void {
  const name =
    ts.isSpreadAssignment(property) || !property.name ? null : propertyNameText(property.name);
  if (name === null) {
    properties.clear();
  } else if (ts.isPropertyAssignment(property)) {
    properties.set(name, property.initializer);
  } else {
    properties.delete(name);
  }
}
