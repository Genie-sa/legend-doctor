import { actions } from "./harness.js";
import assert from "node:assert/strict";
import test from "node:test";

test("isolates one nullable payload inside a bounded dialog boundary", () => {
  const source = (
    dialog: string,
    extraWrite = "",
    confirmBody = "if (!target) return; remove(target.id); setTarget(null);",
  ): string => `
    import { useState } from "react";
    interface Item { id: string; name: string }
    function Eager(_props: { onFire: () => void }) { return null; }
    function renderName(_item: Item | null) { return null; }
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | null>(null);
      const [page, setPage] = useState(1);
      const confirm = () => {
        ${confirmBody}
      };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Preview />
        <button onClick={() => { setTarget(item); ${extraWrite} }}>Delete</button>
        ${dialog}
      </main>;
    }
  `;

  assert.deepEqual(
    actions(
      source(`<dialog open={target !== null} onClose={() => setTarget(null)}>
      <h2>{renderName(target)}</h2>
      <button onClick={confirm} disabled={!target}>Confirm</button>
    </dialog>`),
    ),
    ["use-observable", "review-state"],
  );

  assert.deepEqual(
    actions(
      source(`<dialog open={target !== null} onClose={() => setTarget(null)}>
      <h2>{renderName(target)}</h2>
      <button onClick={confirm}>Confirm</button>
    </dialog><Preview item={target} />`),
    ),
    ["review-state", "review-state"],
  );

  assert.deepEqual(
    actions(
      source(`{target && <dialog open>
      <h2>Delete {target.name}</h2>
      <button onClick={confirm}>Confirm</button>
    </dialog>}`),
    ),
    ["use-observable", "review-state"],
  );

  assert.deepEqual(
    actions(
      source(
        `<dialog open={target !== null} onClose={() => setTarget(null)}>
      <h2>{renderName(target)}</h2>
      <button onClick={confirm}>Confirm</button>
    </dialog>`,
        "setPage(2);",
      ),
    ),
    ["review-state", "delete-unused-state"],
  );

  assert.deepEqual(
    actions(
      source(`<Eager onFire={() => setTarget(item)} /><dialog open={target !== null} onClose={() => setTarget(null)}>
      <h2>{renderName(target)}</h2>
      <button onClick={confirm}>Confirm</button>
    </dialog>`),
    ),
    ["review-state", "review-state"],
  );

  assert.deepEqual(
    actions(
      source(
        `<dialog open={target !== null} onClose={() => setTarget(null)}>
      <h2>{renderName(target)}</h2>
      <button onClick={confirm}>Confirm</button>
    </dialog>`,
        "",
        "Promise.resolve().then(() => remove(target?.id)); setTarget(null);",
      ),
    ),
    ["review-state", "review-state"],
  );
});

test("isolates call-free payload projections inside one bounded conditional dialog", () => {
  const source = (
    dialog: string,
    extraWrite = "",
    producer = `<button onClick={() => open()}>Edit</button>`,
  ): string => `
    import { useState } from "react";
    interface Item { id: string }
    export function Screen({ item }: { item: Item }) {
      const [target, setTarget] = useState<Item | "create" | null>(null);
      const open = () => { setTarget(item); ${extraWrite} };
      ${"\n".repeat(100)}
      return <main>
        <Header /><Toolbar /><Summary /><Filters /><List /><Footer />
        <Aside /><Help /><Status /><Actions /><Preview />
        ${producer}
        ${dialog}
      </main>;
    }
  `;

  assert.deepEqual(
    actions(
      source(`{target && <dialog open onClose={() => setTarget(null)}>
      <Editor item={target === "create" ? null : target} />
    </dialog>}`),
    ),
    ["use-observable"],
  );

  for (const unsafe of [
    `{target && <dialog open onClose={() => setTarget(null)}>
      <Editor item={normalize(target)} />
    </dialog>}`,
    `{target && <dialog open onClose={() => setTarget(null)}><Editor item={target} /></dialog>}
     <Preview item={target} />`,
    `{items.map(item => target && <dialog key={item.id} open onClose={() => setTarget(null)}>
      <Editor item={target} />
    </dialog>)}`,
    `{target && <dialog open onClose={() => setTarget(null)}>
      <One /><Two /><Three /><Four /><Five /><Six /><Seven /><Eight /><Nine /><Ten /><Eleven /><Twelve /><Thirteen />
      <Editor item={target} />
    </dialog>}`,
  ]) {
    assert.deepEqual(actions(source(unsafe)), ["review-state"]);
  }

  assert.deepEqual(
    actions(
      source(
        `{target && <dialog open onClose={() => setTarget(null)}>
      <Editor item={target} />
    </dialog>}`,
        "setPage(2);",
      ),
    ),
    ["review-state"],
  );

  assert.deepEqual(
    actions(
      source(
        `{target && <dialog open onClose={() => setTarget(null)}>
      <Editor item={target} />
    </dialog>}`,
        "",
        `<Unknown onFire={() => open()} />`,
      ),
    ),
    ["review-state"],
  );
});
