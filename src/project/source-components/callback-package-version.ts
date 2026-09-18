import type { SourceIndexState } from "./model.js";
import path from "node:path";
import { sourceModuleResolution } from "./module-resolution.js";
import ts from "typescript";

const versionsByIndex = new WeakMap<SourceIndexState, Map<string, string | null>>();

/** An exact owning-package pin is required; an installed package must agree with it. */
export function callbackPackageVersion(
  state: SourceIndexState,
  file: string,
  specifier: string,
): string | null {
  let cache = versionsByIndex.get(state);
  if (!cache) {
    cache = new Map();
    versionsByIndex.set(state, cache);
  }
  const key = `${file}\0${specifier}`;
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }
  const version = readCallbackPackageVersion(state, file, specifier);
  cache.set(key, version);
  return version;
}

function readCallbackPackageVersion(
  state: SourceIndexState,
  file: string,
  specifier: string,
): string | null {
  const host = state.moduleResolutionHost;
  const declared = declaredPackageVersion(host, file, specifier);
  if (!declared) {
    return null;
  }
  const resolution = sourceModuleResolution(state, file, specifier);
  if (!resolution.resolvedFile) {
    return declared;
  }
  // A TypeScript path alias to application source is not the audited dependency.
  if (!resolution.resolvedFile.split(path.sep).includes("node_modules")) {
    return null;
  }
  return installedVersionMatches(host, resolution.resolvedFile, { specifier, declared })
    ? declared
    : null;
}

function installedVersionMatches(
  host: ts.ModuleResolutionHost,
  file: string,
  pin: { specifier: string; declared: string },
): boolean {
  const manifest = ts.findConfigFile(path.dirname(file), host.fileExists, "package.json");
  const installed = manifest ? jsonObject(host.readFile(manifest)) : null;
  return (
    installed !== null &&
    stringField(installed, "name") === pin.specifier &&
    stringField(installed, "version") === pin.declared
  );
}

function jsonObject(text: string | undefined): ts.ObjectLiteralExpression | null {
  if (!text || !isValidJson(text)) {
    return null;
  }
  const source = ts.parseJsonText("package.json", text);
  const [statement] = source.statements;
  return statement &&
    ts.isExpressionStatement(statement) &&
    ts.isObjectLiteralExpression(statement.expression)
    ? statement.expression
    : null;
}

function field(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  const matches = object.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === name,
  );
  const [property] = matches;
  return matches.length === 1 && property && ts.isPropertyAssignment(property)
    ? property.initializer
    : null;
}

function objectField(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralExpression | null {
  const value = field(object, name);
  return value && ts.isObjectLiteralExpression(value) ? value : null;
}

function stringField(object: ts.ObjectLiteralExpression, name: string): string | null {
  const value = field(object, name);
  return value && ts.isStringLiteral(value) ? value.text : null;
}

function declaredPackageVersion(
  host: ts.ModuleResolutionHost,
  file: string,
  specifier: string,
): string | null {
  const manifest = ts.findConfigFile(path.dirname(file), host.fileExists, "package.json");
  const owner = manifest ? jsonObject(host.readFile(manifest)) : null;
  const dependencies = owner ? objectField(owner, "dependencies") : null;
  const declared = dependencies ? stringField(dependencies, specifier) : null;
  return declared && /^\d+\.\d+\.\d+$/u.test(declared) ? declared : null;
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
}
