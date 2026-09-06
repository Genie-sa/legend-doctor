import { actions, requireValue } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("isolates presentation gates whose branches contain ordinary render calls", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ t }: { t: (key: string) => string }) {
      const [copied, setCopied] = useState(false);
      const copy = () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      };
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button aria-label={copied ? t("copied") : t("copy")} onClick={copy}>
          {copied ? <CheckIcon label={t("copied")} /> : <CopyIcon label={t("copy")} />}
        </button>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /full state-controlled render expression/u);
});

test("isolates a presentation gate rendered by one local JSX factory", () => {
  const source = `
    import { useState } from "react";
    export function Screen({ t }: { t: (key: string) => string }) {
      const [open, setOpen] = useState(false);
      const renderDialog = () => {
        const title = t("confirm");
        return <Dialog title={title} onClose={() => setOpen(false)}><p>Body</p></Dialog>;
      };
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <button onClick={() => setOpen(true)}>Open</button>
        {open && renderDialog()}
      </main>;
    }
  `;
  const finding = analyzeSource(source, "fixture.tsx").find(
    (candidate) => candidate.name === "open",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /full state-controlled render expression/u);

  for (const unsafe of [
    source.replace("const renderDialog =", "let renderDialog ="),
    source
      .replace("const renderDialog = () =>", "const renderDialog = (kind: string) =>")
      .replace("renderDialog()", 'renderDialog("confirm")'),
    source
      .replace("const renderDialog = () => {", "const renderDialog = makeRenderer(() => {")
      .replace("\n      };\n      return", "\n      });\n      return"),
    source.replace(
      'const title = t("confirm");',
      'if (t("skip")) return <Fallback />; const title = t("confirm");',
    ),
  ]) {
    const candidate = analyzeSource(unsafe, "fixture.tsx").find((result) => result.name === "open");
    assert.notEqual(requireValue(candidate).action, "use-observable");
  }
});

test("isolates a small logical JSX gate without moving its owner lifetime", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen() {
      const [visible, setVisible] = useState(true);
      const hide = () => setVisible(false);
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>
          <Canvas onBegin={hide} />
          {visible && <Hint onDismiss={hide}>Draw here</Hint>}
        </section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /always-mounted leaf subscriber/u);
});

test("isolates a leaf reached through one immutable render projection", () => {
  const [finding] = analyzeSource(
    `
    import { useState } from "react";
    export function Screen({ src, enabled }: { src: string; enabled: boolean }) {
      const [failed, setFailed] = useState(false);
      const showImage = src.length > 0 && !failed;
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
        <section>{showImage && enabled && <img src={src} onError={() => setFailed(true)} />}</section>
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "use-observable");
  assert.match(requireValue(finding).message ?? "", /full state-controlled render expression/u);
});

test("does not isolate mutable, effectful, or externally consumed render aliases", () => {
  for (const alias of [
    `let showImage = !failed;`,
    `const showImage = trackAndCheck(failed);`,
    `const showImage = !failed; useQuery(showImage);`,
  ]) {
    assert.deepEqual(
      actions(`
        import { useState } from "react";
        export function Screen() {
          const [failed, setFailed] = useState(false);
          ${alias}
          return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
            {showImage && <img onError={() => setFailed(true)} />}
          </main>;
        }
      `),
      ["review-state"],
    );
  }
});

test("does not move side effects embedded in a render gate condition", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ trackAndCheck }: { trackAndCheck: (value: boolean) => boolean }) {
        const [visible, setVisible] = useState(false);
        const show = () => setVisible(true);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={show}>Show</button>
          {trackAndCheck(visible) && <Leaf />}
        </main>;
      }
    `),
    ["review-state"],
  );
});

test("does not isolate a presentation gate that owns the whole return", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [ready, setReady] = useState(false);
        return ready
          ? <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /></main>
          : <Loading onReady={() => setReady(true)} />;
      }
    `),
    ["review-state"],
  );
});

test("does not isolate a presentation gate repeated across rows", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen({ rows }: { rows: Array<{ id: string }> }) {
        const [active, setActive] = useState(false);
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          {rows.map(row => <Row key={row.id} onClick={() => setActive(true)}>
            {active ? <ActiveIcon /> : <IdleIcon />}
          </Row>)}
        </main>;
      }
    `),
    ["review-state"],
  );
});

test("migrates a presentation gate together with its companion writes", () => {
  assert.deepEqual(
    actions(`
      import { useState } from "react";
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [payload, setPayload] = useState<string | null>(null);
        const show = () => { setPayload("item"); setOpen(true); };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions />
          <button onClick={show}>Open</button>
          {open && <Dialog payload={payload} onClose={() => setOpen(false)} />}
        </main>;
      }
    `),
    ["use-observable", "use-observable"],
  );

  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Dialog(_props: unknown) { return null; }
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [dirty, setDirty] = useState(false);
        const unused = <button onClick={() => setOpen(true)} />;
        const close = () => { setOpen(false); setDirty(false); };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <Dialog open={open} onOpenChange={close} />
          <span>{dirty}</span>
        </main>;
      }
    `),
    ["review-state", "review-state"],
  );

  assert.deepEqual(
    actions(`
      import { useState } from "react";
      function Dialog(_props: unknown) { return null; }
      export function Screen() {
        const [open, setOpen] = useState(false);
        const [dirty, setDirty] = useState(false);
        const markDirty = () => { setDirty(true); return true; };
        const close = () => { setOpen(false); setDirty(false); };
        return <main><Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Actions /><Preview />
          <button onClick={() => setOpen(markDirty())} />
          <Dialog open={open} onOpenChange={close} />
          <span>{dirty}</span>
        </main>;
      }
    `),
    ["use-observable", "use-observable"],
  );
});
