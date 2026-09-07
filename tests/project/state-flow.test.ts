import { functionAndCalls, requireCall } from "./state-flow-harness.js";
import { StateFlowIndex } from "../../src/project/state-flow/state-flow.js";
import assert from "node:assert/strict";
import test from "node:test";

test("proves sequential state writes can execute together", () => {
  const { calls, fn } = functionAndCalls(`
    function run() {
      setName("Ada");
      setOpen(true);
    }
  `);
  assert.deepEqual(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "proven",
  );
});

test("disproves state writes in opposite conditional branches", () => {
  const { calls, fn } = functionAndCalls(`
    function run(mode: boolean) {
      if (mode) setName("Ada");
      else setOpen(true);
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "disproven",
  );
});

test("disproves writes separated by a terminating guard", () => {
  const { calls, fn } = functionAndCalls(`
    function run(blocked: boolean) {
      if (blocked) {
        setName("Ada");
        return;
      }
      setOpen(true);
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "disproven",
  );
});

test("proves writes under the same structural branch", () => {
  const { calls, fn } = functionAndCalls(`
    function run(open: boolean) {
      if (open) {
        setName("Ada");
        setOpen(true);
      }
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "proven",
  );
});

test("does not prove a conditional write against a different control surface", () => {
  const { calls, fn } = functionAndCalls(`
    function run(mode: boolean) {
      if (mode) setName("Ada");
      setOpen(true);
    }
  `);
  assert.deepEqual(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "unknown",
  );
});

test("proves an unconditional write that dominates a following branch write", () => {
  const { calls, fn } = functionAndCalls(`
    function run(mode: boolean) {
      setName("Ada");
      if (mode) setOpen(true);
    }
  `);
  assert.deepEqual(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "proven",
  );
});

test("returns unknown for unsupported control flow instead of assuming absence", () => {
  const { calls, fn } = functionAndCalls(`
    function run(items: string[]) {
      for (const item of items) setName(item);
      setOpen(true);
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "unknown",
  );
});

test("does not turn correlated guards into a co-execution proof", () => {
  const { calls, fn } = functionAndCalls(`
    function run(mode: "create" | "rename") {
      if (mode === "create") setName("Ada");
      if (mode === "rename") setOpen(true);
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "unknown",
  );
});

test("does not prove a shared branch that an earlier guard makes unreachable", () => {
  const { calls, fn } = functionAndCalls(`
    function run(mode: boolean) {
      if (mode) return;
      if (mode) {
        setName("Ada");
        setOpen(true);
      }
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "unknown",
  );
});

test("disproves co-execution with a call in a constant-false branch", () => {
  const { calls, fn } = functionAndCalls(`
    function run() {
      if (false) setName("Ada");
      setOpen(true);
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "disproven",
  );
});

test("distinguishes same-invocation ordering from a synchronous transaction", () => {
  const { calls, fn } = functionAndCalls(`
    async function run() {
      setName("Ada");
      await save();
      setOpen(true);
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "disproven",
  );
});

test("does not include calls from nested runtime functions", () => {
  const { calls, fn } = functionAndCalls(`
    function run() {
      const later = () => setName("Ada");
      setOpen(true);
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setName"),
      requireCall(calls, "setOpen"),
    ),
    "unknown",
  );
});

test("does not mistake a locally disabled branch for proven coexecution", () => {
  const { calls, fn } = functionAndCalls(`
    function run() {
      let enabled = false;
      if (enabled) setFirst();
      setSecond();
    }
  `);

  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setFirst"),
      requireCall(calls, "setSecond"),
    ),
    "unknown",
  );
});

test("treats switch fallthrough as unknown instead of mutually exclusive", () => {
  const { calls, fn } = functionAndCalls(`
    function run(kind: number) {
      switch (kind) {
        case 1:
          setFirst();
        case 2:
          setSecond();
      }
    }
  `);

  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setFirst"),
      requireCall(calls, "setSecond"),
    ),
    "unknown",
  );
});

test("respects constant short-circuit branches", () => {
  for (const expression of [
    "false && setFirst()",
    "0 && setFirst()",
    "'' && setFirst()",
    "true || setFirst()",
    "1 || setFirst()",
    "'ready' ?? setFirst()",
  ] as const) {
    const { calls, fn } = functionAndCalls(`
      function run() {
        ${expression};
        setSecond();
      }
    `);

    assert.equal(
      new StateFlowIndex().proveSynchronousCoexecution(
        fn,
        requireCall(calls, "setFirst"),
        requireCall(calls, "setSecond"),
      ),
      "disproven",
    );
  }
});

test("does not treat a shadowed undefined identifier as a nullish constant", () => {
  const { calls, fn } = functionAndCalls(`
    function run(undefined: string) {
      undefined ?? setFirst();
      setSecond();
    }
  `);

  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setFirst"),
      requireCall(calls, "setSecond"),
    ),
    "unknown",
  );
});

test("treats a dynamic short-circuit RHS as a controlled write", () => {
  const after = functionAndCalls(`
    function run(enabled: boolean) {
      enabled && setFirst();
      setSecond();
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      after.fn,
      requireCall(after.calls, "setFirst"),
      requireCall(after.calls, "setSecond"),
    ),
    "unknown",
  );

  const before = functionAndCalls(`
    function run(enabled: boolean) {
      setSecond();
      enabled && setFirst();
    }
  `);
  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      before.fn,
      requireCall(before.calls, "setFirst"),
      requireCall(before.calls, "setSecond"),
    ),
    "proven",
  );
});

test("does not join writes across a generator suspension", () => {
  const { calls, fn } = functionAndCalls(`
    function* run() {
      setFirst();
      yield 1;
      setSecond();
    }
  `);

  assert.equal(
    new StateFlowIndex().proveSynchronousCoexecution(
      fn,
      requireCall(calls, "setFirst"),
      requireCall(calls, "setSecond"),
    ),
    "disproven",
  );
});
