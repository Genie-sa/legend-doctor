import assert from "node:assert/strict";
import { lexicalBinding } from "../../src/core/lexical-bindings.js";
import test from "node:test";
import ts from "typescript";
import { visit } from "../../src/core/ast.js";

/** The binding of the identifier handed to the module's single `probe(...)` call, described. */
function probedBinding(sourceText: string): string {
  const sourceFile = ts.createSourceFile(
    "fixture.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const probed: ts.Identifier[] = [];
  visit(sourceFile, (node) => {
    const [argument] = ts.isCallExpression(node) ? node.arguments : [];
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "probe" &&
      argument !== undefined &&
      ts.isIdentifier(argument)
    ) {
      probed.push(argument);
    }
  });
  const [identifier] = probed;
  assert.equal(probed.length, 1);
  assert.ok(identifier);
  const binding = lexicalBinding(identifier);
  if (binding?.kind === "function" || binding?.kind === "value") {
    return `${binding.kind} ${ts.SyntaxKind[binding.declaration.kind]}`;
  }
  return binding?.kind ?? "global";
}

test("every construct that declares names is consulted as a scope", () => {
  const cases: readonly (readonly [source: string, expected: string])[] = [
    ["for (let index = 0; index < 1; index++) probe(index);", "value VariableDeclaration"],
    [
      "declare const items: number[]; for (const item of items) probe(item);",
      "value VariableDeclaration",
    ],
    [
      "declare const record: object; for (const key in record) probe(key);",
      "value VariableDeclaration",
    ],
    ["try {} catch (error) { probe(error); }", "value VariableDeclaration"],
    ["const Outer = class Named { run() { probe(Named); } };", "value ClassExpression"],
    [
      "declare const k: number; switch (k) { case 1: const local = 1; probe(local); }",
      "value VariableDeclaration",
    ],
    [
      "declare const k: number; switch (k) { default: const local = 1; probe(local); }",
      "value VariableDeclaration",
    ],
    ["namespace Space { const inner = 1; probe(inner); }", "value VariableDeclaration"],
    ["const outer = function named() { probe(named); };", "function FunctionExpression"],
    ["function outer() { { var hoisted = 1; } probe(hoisted); }", "value VariableDeclaration"],
    [
      "function outer(param: number) { return ((param + 1)) && [{ key: probe(param) }]; }",
      "value Parameter",
    ],
    [
      "const shadowed = () => 1; { const shadowed = 2; probe(shadowed); }",
      "value VariableDeclaration",
    ],
    [
      "const helper = () => 1; function run() { return [{ nested: probe(helper) }]; }",
      "function ArrowFunction",
    ],
    ['import { imported } from "./module"; probe(imported);', "import"],
    ["declare function ambient(): void; probe(ambient);", "ambient"],
  ];
  for (const [source, expected] of cases) {
    assert.equal(probedBinding(source), expected, source);
  }
});

test("a var inside a nested function stays out of the enclosing scope", () => {
  assert.equal(
    probedBinding("function outer() { const inner = () => { var hidden = 1; }; probe(hidden); }"),
    "global",
  );
  assert.equal(
    probedBinding("const run = (x: number) => (y: number) => { var z = 1; }; probe(z);"),
    "global",
  );
});
