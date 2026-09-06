import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("moves a subscription only into one stable isolated JSX leaf", () => {
  const positive = analyzeLegendPractices({
    sourceText: `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen() {
      const open$ = useObservable(false);
      const open = useValue(open$);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        <Dialog open={open} />
      </main>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(
    requireValue(positive.find((finding) => finding.location.line === 5)).action,
    "move-use-value-down",
  );
  assert.match(
    requireValue(positive.find((finding) => finding.location.line === 5)).message ?? "",
    /1 JSX element instead of the 13-element owner/u,
  );

  const cohesive = analyzeLegendPractices({
    sourceText: `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Dialog() {
      const open$ = useObservable(false);
      const open = useValue(open$);
      return <Popup open={open} />;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(
    cohesive.some((finding) => finding.action === "move-use-value-down"),
    false,
  );

  for (const leaf of [
    "items.map(item => <Dialog key={item.id} open={open} />)",
    "<Dialog key={id} open={open} />",
    "<Dialog open={open} onOpenChange={() => log(open)} />",
  ]) {
    const findings = analyzeLegendPractices({
      sourceText: `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ show, items }) {
        const open$ = useObservable(false);
        const open = useValue(open$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {${leaf}}
        </main>;
      }
    `,
      fileName: "fixture.tsx",
    });
    assert.equal(
      findings.some((finding) => finding.action === "move-use-value-down"),
      false,
      leaf,
    );
  }

  const splitReturn = analyzeLegendPractices({
    sourceText: `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen({ loading }) {
      const open$ = useObservable(false);
      const open = useValue(open$);
      if (loading) return <Loading />;
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        <Dialog open={open} />
      </main>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(
    splitReturn.some((finding) => finding.action === "move-use-value-down"),
    false,
  );
});

test("moves a subscription behind a complete conditional JSX slot without changing its lifetime", () => {
  const positive = analyzeLegendPractices({
    sourceText: `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen({ view }) {
      const kind$ = useObservable("all");
      const kind = useValue(kind$);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        {view === "category" && <CategoryFilter kind={kind} />}
      </main>;
    }
  `,
    fileName: "fixture.tsx",
  });
  const finding = positive.find((candidate) => candidate.location.line === 5);
  assert.equal(requireValue(finding).action, "move-use-value-down");
  assert.match(requireValue(finding).message ?? "", /always-mounted wrapper/u);
  assert.match(requireValue(finding).message ?? "", /complete conditional JSX slot/u);
  assert.match(
    requireValue(finding).evidence.join(" ") ?? "",
    /preserves the subscription lifetime/u,
  );

  const controllingValue = analyzeLegendPractices({
    sourceText: `
    import { useObservable, useValue } from "@legendapp/state/react";
    export function Screen() {
      const open$ = useObservable(false);
      const open = useValue(open$);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Search />
        {open ? <Dialog /> : null}
      </main>;
    }
  `,
    fileName: "fixture.tsx",
  });
  assert.equal(
    requireValue(controllingValue.find((candidate) => candidate.location.line === 5)).action,
    "move-use-value-down",
  );

  for (const source of [
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ loading, view }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        if (loading) return <Loading />;
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {view === "category" && <CategoryFilter kind={kind} />}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ items, view }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {items.map(item => <section key={item.id}>
            {view === "category" && <CategoryFilter kind={kind} />}
          </section>)}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ show, view }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {show && <section>{view === "category" && <CategoryFilter kind={kind} />}</section>}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ view, id }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {view === "category" && <CategoryFilter key={id} kind={kind} />}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ view }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        const panel = <section>{view === "category" && <CategoryFilter kind={kind} />}</section>;
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {panel}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ view }) {
        const state$ = useObservable({ kind: "all", error: "" });
        const state = useValue(state$);
        const error = useValue(state$.error);
        return <main>
          <Header kind={state.kind} /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen({ view, check }) {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {check(view) && <CategoryFilter kind={kind} />}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      let visible = false;
      export function Screen() {
        const kind$ = useObservable("all");
        const kind = useValue(kind$);
        return <main>
          <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {visible && <CategoryFilter kind={kind} />}
        </main>;
      }
    `,
    `
      import { useObservable, useValue } from "@legendapp/state/react";
      export function Screen() {
        const state$ = useObservable({ error: "" });
        const hasError = useValue(() => state$.error.get().length > 0);
        const error = useValue(state$.error);
        return <main>
          <Header hasError={hasError} /><Toolbar /><Summary /><Filters /><List /><Footer />
          <Aside /><Help /><Status /><Actions /><Search />
          {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        </main>;
      }
    `,
  ]) {
    const findings = analyzeLegendPractices({ sourceText: source, fileName: "fixture.tsx" });
    assert.equal(
      findings.some((candidate) => candidate.action === "move-use-value-down"),
      false,
    );
  }
});
