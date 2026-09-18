import type { HookImports } from "../core/imports.js";
import type { LegendPracticeFinding } from "../core/types.js";
import { bindingDeclarationCount } from "../core/analysis-ast.js";
import ts from "typescript";
import { visit } from "../core/ast.js";

interface Scan {
  fileName: string;
  sourceFile: ts.SourceFile;
  imports: HookImports;
}

const OWNER_STATEMENTS = 3;
const DECLARATION_AND_READ = 2;
type NamedConst = ts.VariableDeclaration & { name: ts.Identifier };
interface Projection {
  call: ts.CallExpression;
  comparison: ts.BinaryExpression;
  name: string;
}

/** Deliberately closed proof: one private JSX component, two consts, and inert host output. */
export function findPlainPrimitiveProjections(scan: Scan): LegendPracticeFinding[] {
  // Explicit alternate JSX factories/runtimes do not establish a React host boundary.
  if (/@jsx(?:ImportSource|Runtime|Frag)?\b/u.test(scan.sourceFile.text)) {
    return [];
  }
  return scan.sourceFile.statements.flatMap((owner) => {
    if (!privateJsxOwner(owner, scan.sourceFile)) {
      return [];
    }
    const projection = confinedProjection(owner, scan);
    return projection ? [projectionFinding(projection, scan)] : [];
  });
}

function confinedProjection(owner: ts.FunctionDeclaration, scan: Scan): Projection | null {
  const [rawStatement, projectionStatement, output] = owner.body!.statements;
  const raw = singleConst(rawStatement);
  const projection = singleConst(projectionStatement);
  if (!raw || !projection || !output || !ts.isReturnStatement(output)) {
    return null;
  }
  const call = rawSubscription(raw.initializer, owner, scan);
  const comparison = strictComparison(projection.initializer, raw.name.text);
  if (
    !call ||
    !comparison ||
    !safeOperand(comparison.right, owner) ||
    !output.expression ||
    !inertOutput(output.expression, projection.name.text) ||
    identifierCount(owner.body!, raw.name.text) !== DECLARATION_AND_READ
  ) {
    return null;
  }
  return { call, comparison, name: projection.name.text };
}

function rawSubscription(
  node: ts.Expression | undefined,
  owner: ts.FunctionDeclaration,
  scan: Scan,
): ts.CallExpression | null {
  if (
    !node ||
    !ts.isCallExpression(node) ||
    node.arguments.length !== 1 ||
    node.typeArguments ||
    !ts.isIdentifier(node.expression) ||
    !scan.imports.useValue.has(node.expression.text) ||
    bindingDeclarationCount(owner, node.expression.text) !== 0 ||
    !scalarObservable(node.arguments[0]!, owner, scan)
  ) {
    return null;
  }
  return node;
}

function strictComparison(
  node: ts.Expression | undefined,
  raw: string,
): ts.BinaryExpression | null {
  return node &&
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
      node.operatorToken.kind,
    ) &&
    ts.isIdentifier(node.left) &&
    node.left.text === raw
    ? node
    : null;
}

function projectionFinding(
  { call, comparison, name }: Projection,
  scan: Scan,
): LegendPracticeFinding {
  const observable = call.arguments[0]!.getText(scan.sourceFile);
  const projected = `${observable}.get() ${comparison.operatorToken.getText()} ${comparison.right.getText(scan.sourceFile)}`;
  const position = scan.sourceFile.getLineAndCharacterOfPosition(call.getStart());
  return {
    action: "select-primitive-projection",
    confidence: "certain",
    disposition: "change",
    practice: "reactivity",
    location: { file: scan.fileName, line: position.line + 1, column: position.character + 1 },
    evidence: [
      "a module const is initialized by the imported observable factory with a broad string or number domain; distinct unequal inputs can preserve the boolean result",
      "the raw value is confined to strict equality; the other operand is a literal or unmodified primitive parameter binding, with no helper or getter reads",
      "the private component is referenced only as a JSX tag, has no effects/events or other render computations, and renders the projection only into inert host JSX",
    ],
    message: `Replace the raw subscription and projection with \`const ${name} = ${call.expression.getText(scan.sourceFile)}(() => ${projected})\` at the original hook position. Keep the selector inline so prop updates stay live. Distinct source values with the same boolean result skip this component's render; selector executions still occur on source updates.`,
  };
}

function singleConst(statement: ts.Statement | undefined): NamedConst | null {
  if (
    !statement ||
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    statement.declarationList.declarations.length !== 1
  ) {
    return null;
  }
  const declaration = statement.declarationList.declarations[0]!;
  // SAFETY: The predicate verifies the identifier binding before refining the declaration.
  return ts.isIdentifier(declaration.name) && !declaration.type
    ? (declaration as NamedConst)
    : null;
}

function privateJsxOwner(
  node: ts.Statement,
  source: ts.SourceFile,
): node is ts.FunctionDeclaration {
  if (
    !ts.isFunctionDeclaration(node) ||
    !node.name ||
    !/^[A-Z]/u.test(node.name.text) ||
    !node.body ||
    node.asteriskToken ||
    node.modifiers?.length ||
    node.typeParameters ||
    !inertParameters(node) ||
    node.body.statements.length !== OWNER_STATEMENTS
  ) {
    return false;
  }
  let uses = 0;
  let safe = true;
  visit(source, (reference) => {
    if (
      !ts.isIdentifier(reference) ||
      reference.text !== node.name!.text ||
      reference === node.name
    ) {
      return;
    }
    const { parent } = reference;
    if (
      (ts.isJsxOpeningElement(parent) ||
        ts.isJsxSelfClosingElement(parent) ||
        ts.isJsxClosingElement(parent)) &&
      parent.tagName === reference
    ) {
      uses += 1;
    } else {
      safe = false;
    }
  });
  return safe && uses > 0;
}

function scalarObservable(
  expression: ts.Expression,
  owner: ts.FunctionDeclaration,
  scan: Scan,
): boolean {
  if (!ts.isIdentifier(expression) || bindingDeclarationCount(owner, expression.text) !== 0) {
    return false;
  }
  const declarations = scan.sourceFile.statements
    .map(singleConst)
    .filter((node) => node?.name.text === expression.text);
  if (declarations.length !== 1) {
    return false;
  }
  const { initializer } = declarations[0]!;
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    initializer.arguments.length !== 1 ||
    !ts.isIdentifier(initializer.expression) ||
    !scan.imports.observable.has(initializer.expression.text)
  ) {
    return false;
  }
  const kind = primitiveLiteralKind(initializer.arguments[0]!);
  return (
    kind !== null &&
    (!initializer.typeArguments ||
      (initializer.typeArguments.length === 1 && initializer.typeArguments[0]!.kind === kind))
  );
}

function safeOperand(expression: ts.Expression, owner: ts.FunctionDeclaration): boolean {
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) {
    return true;
  }
  if (
    !ts.isIdentifier(expression) ||
    owner.parameters.length !== 1 ||
    bindingDeclarationCount(owner, expression.text) !== 1
  ) {
    return false;
  }
  const parameter = owner.parameters[0]!;
  if (
    !ts.isObjectBindingPattern(parameter.name) ||
    !parameter.type ||
    !ts.isTypeLiteralNode(parameter.type)
  ) {
    return false;
  }
  const binding = parameter.name.elements.find(
    (element) => ts.isIdentifier(element.name) && element.name.text === expression.text,
  );
  const member = parameter.type.members.find(
    (entry) =>
      ts.isPropertySignature(entry) &&
      ts.isIdentifier(entry.name) &&
      entry.name.text === expression.text,
  );
  return (
    binding !== undefined &&
    member !== undefined &&
    ts.isPropertySignature(member) &&
    !member.questionToken &&
    (member.type?.kind === ts.SyntaxKind.StringKeyword ||
      member.type?.kind === ts.SyntaxKind.NumberKeyword)
  );
}

function identifierCount(node: ts.Node, name: string): number {
  let count = 0;
  visit(node, (child) => {
    if (ts.isIdentifier(child) && child.text === name) {
      count += 1;
    }
  });
  return count;
}

/** No component calls, spreads, event handlers, refs, getters, or arbitrary JSX expressions. */
function inertOutput(expression: ts.Expression, selected: string): boolean {
  if (!ts.isJsxElement(expression) && !ts.isJsxSelfClosingElement(expression)) {
    return false;
  }
  let safe = true;
  let reads = 0;
  visit(expression, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      safe &&= ts.isIdentifier(node.tagName) && /^[a-z][a-z0-9]*$/u.test(node.tagName.text);
    }
    if (ts.isJsxSpreadAttribute(node)) {
      safe = false;
    }
    if (ts.isJsxAttribute(node)) {
      safe &&=
        ts.isIdentifier(node.name) &&
        node.name.text !== "ref" &&
        node.name.text !== "key" &&
        !node.name.text.startsWith("on") &&
        node.name.text !== "dangerouslySetInnerHTML";
    }
    if (ts.isJsxExpression(node)) {
      reads += 1;
      safe &&=
        node.expression !== undefined &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === selected;
    }
  });
  return safe && reads > 0;
}

function inertParameters(owner: ts.FunctionDeclaration): boolean {
  return (
    owner.parameters.length === 0 ||
    (owner.parameters.length === 1 &&
      owner.parameters.every(
        (parameter) =>
          !parameter.initializer &&
          !parameter.dotDotDotToken &&
          ts.isObjectBindingPattern(parameter.name) &&
          parameter.name.elements.every(
            (element) =>
              ts.isIdentifier(element.name) &&
              !element.initializer &&
              !element.dotDotDotToken &&
              !element.propertyName,
          ),
      ))
  );
}

function primitiveLiteralKind(node: ts.Expression): ts.SyntaxKind | null {
  if (ts.isStringLiteral(node)) {
    return ts.SyntaxKind.StringKeyword;
  }
  return ts.isNumericLiteral(node) ? ts.SyntaxKind.NumberKeyword : null;
}
