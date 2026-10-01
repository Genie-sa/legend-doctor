import { findAncestor, identifiersNamed, isNonProductionHarness, visit } from "../../core/ast.js";
import type { AnalysisContext } from "./analysis-context.js";
import type { ClosedBinding } from "./hook-consumer-closure.js";
import type { ComponentTarget } from "./component-references.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { closedComponentBindings } from "./hook-consumer-closure.js";
import { declaredComponent } from "./parent-rerenders.js";
import { isWithin } from "../workspace/packages.js";
import { outsideRootSources } from "./hook-closure-outside.js";
import { parseJsonFields } from "../../core/json.js";
import path from "node:path";
import ts from "typescript";

const ENTRY_MANIFEST_FIELDS = ["exports", "main", "module"] as const;
const ROUTE_DIRECTORY_PATTERN = /^(?:src\/)?(?:app|pages|routes)\//u;
const ROOT_RENDER_MODULES: ReadonlySet<string> = new Set([
  "expo",
  "react-dom",
  "react-dom/client",
  "react-native",
]);
const ROOT_RENDER_CALLS: ReadonlySet<string> = new Set([
  "createRoot",
  "hydrateRoot",
  "registerComponent",
  "registerRootComponent",
  "render",
]);

// Context identity owns the snapshot: a new scan re-reads every package's entries.
const entryByContext = new WeakMap<AnalysisContext, Map<string, boolean>>();

/**
 * Whether no production source can render `owner`. The component must be a named, non-default
 * export outside file-system route directories, declared in an application package that exposes
 * no entry point and renders its own root, and every traceable binding of it across that closed
 * package must be unused except for its declaration, its exports, and static property assignments
 * such as `displayName`.
 */
export function componentIsUnreferenced(
  context: AnalysisContext,
  owner: RuntimeFunctionLike,
): boolean {
  const component = declaredComponent(owner);
  const file = owner.getSourceFile();
  if (!component || isDefaultExported(file, component.target.name)) {
    return false;
  }
  const packageDirectory = applicationPackageDirectory(file.fileName);
  if (
    packageDirectory === null ||
    ROUTE_DIRECTORY_PATTERN.test(toPosix(path.relative(packageDirectory, file.fileName))) ||
    !rendersOwnRoot(context, packageDirectory)
  ) {
    return false;
  }
  const closure = closedComponentBindings(context, {
    file: component.target.file,
    localName: component.target.name,
  });
  return (
    closure !== null &&
    closure.consumers.every((binding) => !hasRenderableReference(binding, component.target))
  );
}

function hasRenderableReference(
  { file, localName }: ClosedBinding,
  target: ComponentTarget,
): boolean {
  return identifiersNamed(file.sourceFile, localName).some(
    (reference) =>
      reference !== target.declarationName &&
      !findAncestor(reference, ts.isImportDeclaration) &&
      !findAncestor(reference, ts.isTypeNode) &&
      !ts.isExportSpecifier(reference.parent) &&
      !isStaticPropertyAssignment(reference),
  );
}

function isStaticPropertyAssignment(reference: ts.Identifier): boolean {
  const access = reference.parent;
  return (
    ts.isPropertyAccessExpression(access) &&
    access.expression === reference &&
    ts.isBinaryExpression(access.parent) &&
    access.parent.left === access &&
    access.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

function isDefaultExported(file: ts.SourceFile, name: string): boolean {
  return file.statements.some(
    (statement) =>
      (ts.isExportAssignment(statement) &&
        ts.isIdentifier(statement.expression) &&
        statement.expression.text === name) ||
      ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name &&
        hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) ||
      (ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(
          (element) =>
            element.name.text === "default" && (element.propertyName ?? element.name).text === name,
        )),
  );
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

/**
 * The directory of the manifest governing `file` when it describes an application: other
 * packages import a library through its declared entry points, which the scan cannot see.
 */
function applicationPackageDirectory(file: string): string | null {
  const manifest = ts.findConfigFile(path.dirname(file), ts.sys.fileExists, "package.json");
  if (manifest === undefined) {
    return null;
  }
  const text = ts.sys.readFile(manifest);
  const fields = text === undefined ? null : parseJsonFields(text);
  return fields !== null && ENTRY_MANIFEST_FIELDS.every((field) => !fields.has(field))
    ? path.dirname(manifest)
    : null;
}

/**
 * A package whose sources never mount a React root or declare file-system routes is rendered by
 * a host the scan cannot see, so the absence of a reference inside it proves nothing.
 */
function rendersOwnRoot(context: AnalysisContext, packageDirectory: string): boolean {
  const byPackage = entryByContext.get(context) ?? new Map<string, boolean>();
  entryByContext.set(context, byPackage);
  const cached = byPackage.get(packageDirectory);
  if (cached !== undefined) {
    return cached;
  }
  const outside = isWithin(context.root, packageDirectory)
    ? []
    : outsideRootSources(context, packageDirectory).project.files;
  const renders = [...context.project.files, ...outside].some(
    (source) =>
      isWithin(packageDirectory, source.originalPath) &&
      !isNonProductionHarness(source.originalPath) &&
      (ROUTE_DIRECTORY_PATTERN.test(
        toPosix(path.relative(packageDirectory, source.originalPath)),
      ) ||
        mountsRoot(source.sourceFile)),
  );
  byPackage.set(packageDirectory, renders);
  return renders;
}

function mountsRoot(sourceFile: ts.SourceFile): boolean {
  const importsRootModule = sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      ROOT_RENDER_MODULES.has(statement.moduleSpecifier.text),
  );
  let mounts = false;
  if (importsRootModule) {
    visit(sourceFile, (node) => {
      mounts ||= ts.isCallExpression(node) && ROOT_RENDER_CALLS.has(calleeName(node.expression));
    });
  }
  return mounts;
}

function calleeName(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}
