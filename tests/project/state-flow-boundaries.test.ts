import { functionAndCalls, requireCall } from "./state-flow-harness.js";
import { StateFlowIndex } from "../../src/project/state-flow/state-flow.js";
import assert from "node:assert/strict";
import { lowerStatements } from "../../src/project/state-flow/statement-lowering.js";
import test from "node:test";
import ts from "typescript";
import { visit } from "../../src/core/ast.js";

for (const conditionals of [7, 8, 9, 20]) {
  test(`bounds expression-bodied arrows with ${conditionals} independent conditions`, () => {
    const branches = Array.from(
      { length: conditionals },
      (_value, index) => `p${index} ? 1 : 0`,
    ).join(",");
    const file = ts.createSourceFile(
      "fixture.ts",
      `const run = () => [${branches}, setName(), setOpen()];`,
      ts.ScriptTarget.Latest,
      true,
    );
    let arrow: ts.ArrowFunction | null = null;
    const calls = new Map<string, ts.CallExpression>();
    visit(file, (node) => {
      if (ts.isArrowFunction(node)) {
        arrow = node;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        calls.set(node.expression.text, node);
      }
    });
    assert.ok(arrow);
    const flow = new StateFlowIndex();
    assert.equal(
      flow.proveSynchronousCoexecution(
        arrow,
        requireCall(calls, "setName"),
        requireCall(calls, "setOpen"),
      ),
      conditionals <= 7 ? "proven" : "unknown",
    );
    assert.equal(flow.coverageFor(arrow), conditionals <= 7 ? "complete" : "unknown");
  });
}

for (const [body, expected] of [
  ["try { setName(); setOpen(); } catch {}", "proven"],
  ["try { work(); } catch { setName(); setOpen(); }", "proven"],
  ["try { setName(); throw Error(); setOpen(); } catch {}", "disproven"],
  ["try { setName(); } catch { setOpen(); }", "unknown"],
  ["try { setName(); await work(); setOpen(); } catch {}", "disproven"],
  ["try { return; } finally { setName(); setOpen(); }", "proven"],
  ["try { throw Error(); } finally { setName(); } setOpen();", "disproven"],
  ["try { return; } finally {} setName(); setOpen();", "disproven"],
  ["try { throw Error(); } finally { return; } setName(); setOpen();", "disproven"],
  ["try { for (;;) {} setName(); setOpen(); } catch {}", "unknown"],
]) {
  test(`preserves exception and finalization flow: ${body}`, () => {
    const { calls, fn } = functionAndCalls(`async function run() { ${body} }`);
    assert.equal(
      new StateFlowIndex().proveSynchronousCoexecution(
        fn,
        requireCall(calls, "setName"),
        requireCall(calls, "setOpen"),
      ),
      expected,
    );
  });
}

test("catch paths retain writes before an exception and allow an exception before the first write", () => {
  const { calls, fn } = functionAndCalls(
    "function run() { try { setName(); work(); } catch { setOpen(); } }",
  );
  assert.ok(fn.body);
  const result = lowerStatements(
    fn.body.statements,
    [{ events: [], awaitEpoch: 0, termination: null }],
    {
      breakable: false,
      left: requireCall(calls, "setName"),
      right: requireCall(calls, "setOpen"),
    },
  );
  assert.equal(result.unknown, false);
  const traces = new Set(
    result.paths.map((path) =>
      path.events.map((event) => event.call.expression.getText()).join(","),
    ),
  );
  assert.deepEqual(traces, new Set(["setName", "setOpen", "setName,setOpen"]));
});
