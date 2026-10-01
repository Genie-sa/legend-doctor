import type { HookFinding } from "../../src/core/types.js";
import { analyzeSourceWith } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME =
  "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />";

function states(source: string): ReadonlyMap<string, HookFinding> {
  return new Map(
    analyzeSourceWith(source, "fixture.tsx", {})
      .filter((finding) => finding.hook === "useState")
      .map((finding) => [finding.name ?? "", finding]),
  );
}

function verdict(finding: HookFinding | undefined): string {
  return finding?.abstentionReason
    ? `${finding.action}/${finding.abstentionReason}`
    : (finding?.action ?? "missing");
}

function panel(commands: string): string {
  return `
    import { useEffect, useState } from "react";
    export function Panel({ load }: { load: () => Promise<void> }) {
      const [pending, setPending] = useState(false);
      const [error, setError] = useState("");
      ${commands}
      return (
        <section>
          ${CHROME}
          <p>{error}</p>
          <button disabled={pending} onClick={() => void submit()}>Go</button>
        </section>
      );
    }
  `;
}

const HELPER_BEFORE_FINALLY = panel(`
  const run = async () => {
    try {
      await load();
    } catch {
      setError("failed");
    }
  };
  const submit = async () => {
    setPending(true);
    try {
      await run();
    } finally {
      setPending(false);
    }
  };
`);

const THEN_BEFORE_FINALLY = panel(`
  const submit = () => {
    setPending(true);
    return load()
      .then(() => setError("stale"))
      .finally(() => setPending(false));
  };
`);

const THEN_BEFORE_CATCH = panel(`
  const submit = () => {
    setPending(true);
    return load()
      .then(() => setError("stale"))
      .catch(() => setPending(false));
  };
`);

const ONE_STRETCH = panel(`
  const submit = async () => {
    setPending(true);
    await load();
    setError("stale");
    setPending(false);
  };
`);

const HELPER_IN_STRETCH = panel(`
  const stop = () => {
    setPending(false);
  };
  const submit = async () => {
    setPending(true);
    await load();
    setError("stale");
    stop();
  };
`);

test("a conversion whose co-written state is set in the same stretch commits together", () => {
  for (const source of [ONE_STRETCH, HELPER_IN_STRETCH]) {
    assert.equal(verdict(states(source).get("error")), "use-observable");
  }
});

test("abstains when one command sets a co-written state in another stretch", () => {
  for (const source of [HELPER_BEFORE_FINALLY, THEN_BEFORE_FINALLY, THEN_BEFORE_CATCH]) {
    const error = states(source).get("error");
    assert.equal(verdict(error), "review-state/atomic-transition-unproven");
    assert.match(
      error?.message ?? "",
      /React state `pending` is set in another stretch of the same command/u,
    );
  }
});

test("a companion set in another stretch of the converted write's own function never splits", () => {
  const source = panel(`
    const submit = async () => {
      setPending(true);
      await load();
      setPending(false);
      await load();
      setError("stale");
    };
  `);
  const found = states(source);
  assert.equal(verdict(found.get("error")), "use-observable");
  assert.equal(verdict(found.get("pending")), "use-observable");
});

test("a companion set before its command first suspends never splits the conversion", () => {
  const source = panel(`
    const run = async () => {
      await load();
      setError("stale");
    };
    const submit = () => {
      setPending(false);
      void run();
    };
  `);
  assert.equal(verdict(states(source).get("error")), "use-observable");
});

test("a companion that only another command sets never splits the conversion", () => {
  const source = panel(`
    const submit = async () => {
      await load();
      setError("stale");
    };
    const reset = () => setPending(false);
  `);
  assert.equal(verdict(states(source).get("error")), "use-observable");
});

test("a React host event commits what it runs before suspending once", () => {
  const source = panel(`
    const start = async () => {
      setPending(true);
      await load();
      setPending(false);
    };
    const submit = () => {
      setError("stale");
      void start();
    };
  `);
  assert.equal(verdict(states(source).get("error")), "use-observable");
});

test("a conversion written before its command first suspends never splits", () => {
  const source = panel(`
    const submit = () => {
      setError("stale");
      load().finally(() => setPending(false));
    };
    useEffect(() => submit(), []);
  `);
  assert.equal(verdict(states(source).get("error")), "use-observable");
});

test("React renders a companion the converted write's function awaited before it", () => {
  const source = panel(`
    const probe = async () => {
      await load();
      setPending(false);
    };
    const submit = async () => {
      await probe();
      setError("stale");
    };
  `);
  assert.equal(verdict(states(source).get("error")), "use-observable");
});

test("a cluster that converts together keeps the members it writes in one stretch", () => {
  const source = `
    import { useState } from "react";
    export function Counter() {
      const [count, setCount] = useState(0);
      const [label, setLabel] = useState("");
      return (
        <section>
          ${CHROME}
          <p>{count}</p>
          <em>{label}</em>
          <button onClick={() => { setCount(count + 1); setLabel("added"); }}>Add</button>
          <button onClick={() => setLabel("")}>Clear</button>
        </section>
      );
    }
  `;
  const found = states(source);
  assert.equal(verdict(found.get("count")), "use-observable");
  assert.equal(verdict(found.get("label")), "use-observable");
});

test("a companion no render, effect, or unknown code reads shows no split commit", () => {
  const source = `
    import { useState } from "react";
    export function Panel({ load }: { load: () => Promise<void> }) {
      const [attempts, setAttempts] = useState(0);
      const [error, setError] = useState("");
      const run = async () => {
        try {
          await load();
        } catch {
          setError("failed");
        }
      };
      const submit = async () => {
        try {
          await run();
        } finally {
          setAttempts((count) => count + 1);
        }
      };
      return (
        <section>
          ${CHROME}
          <p>{error}</p>
          <button onClick={() => void submit()}>Go</button>
        </section>
      );
    }
  `;
  assert.equal(verdict(states(source).get("error")), "use-observable");
});

test("the split-commit review asks whether an intermediate commit is acceptable", () => {
  const error = states(HELPER_BEFORE_FINALLY).get("error");
  assert.match(
    error?.assumption?.question ?? "",
    /Converted alone, `error` may commit apart from React state `pending` in the same transition/u,
  );
  assert.equal(error?.assumption?.ifConfirmed, "use-observable");
});

test("React commits the co-writes of a component's event prop together", () => {
  const source = `
    import { useState } from "react";
    import { Draggable } from "react-draggable";
    import { report } from "./report";
    export function Board({ children }: { children: React.ReactNode }) {
      const [dragging, setDragging] = useState(false);
      const [origin, setOrigin] = useState("");
      const startDrag = () => {
        setDragging(true);
      };
      report(dragging);
      return (
        <section>
          ${CHROME}
          <p>{origin}</p>
          <Draggable onStart={() => { setOrigin("top"); startDrag(); }}>{children}</Draggable>
        </section>
      );
    }
  `;
  assert.equal(verdict(states(source).get("origin")), "use-observable");
});
