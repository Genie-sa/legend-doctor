import type { LegendPracticeFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import test from "node:test";
import { withProject } from "../with-project.js";

const LEGACY_DOM = JSON.stringify({ dependencies: { "react-dom": "18.3.1" }, name: "app" });
const LEGACY_NATIVE = JSON.stringify({ dependencies: { "react-native": "0.78.2" }, name: "app" });

const STORE = `
import { observable } from "@legendapp/state";

export const draft$ = observable({ saved: false, title: "" });
export const status$ = observable("idle");
`;

type TransactionDisposition = Pick<LegendPracticeFinding, "action" | "disposition"> & {
  readonly line: number;
};

async function transactions(
  files: Readonly<Record<string, string>>,
  packageJson = LEGACY_DOM,
): Promise<TransactionDisposition[]> {
  let found: TransactionDisposition[] = [];
  await withProject({ "package.json": packageJson, "store.ts": STORE, ...files }, async (root) => {
    const report = await analyzePath(root);
    assert.equal(report.capabilities.concurrentRoot, false);
    found = report.practices
      .filter(({ practice }) => practice === "assign" || practice === "batch")
      .map(({ action, disposition, location }) => ({ action, disposition, line: location.line }))
      .toSorted((left, right) => left.line - right.line);
  });
  return found;
}

function component(body: string, jsx: string, imports = ""): string {
  return `
import { useCallback, useEffect } from "react";
import { draft$, status$ } from "./store";
${imports}

export function Editor({ id }: { id: string }) {
${body}
  return ${jsx};
}
`;
}

const SAVE_CALLBACK = `
  const handleSave = useCallback(() => {
    draft$.saved.set(true);
    status$.set("saved");
  }, []);
`;

test("writes in a callback that only a host element's event prop receives already render once", async () => {
  assert.deepEqual(
    await transactions({
      "editor.tsx": component(SAVE_CALLBACK, `<button onClick={handleSave} />`),
    }),
    [{ action: "batch-observable-writes", disposition: "candidate", line: 9 }],
  );
});

test("an inline host handler, a plain alias, and a call from a host handler each run inside the event", async () => {
  const body = `
  const save = () => {
    draft$.saved.set(true);
    status$.set("saved");
  };
  const onSave = save;
  function reset(next: string) {
    draft$.title.set(next);
    draft$.saved.set(false);
  }
`;
  const jsx = `(
    <form onSubmit={onSave}>
      <button onClick={() => { status$.set("idle"); draft$.saved.set(false); }} />
      <input onChange={() => reset(id)} />
    </form>
  )`;
  const found = await transactions({ "editor.tsx": component(body, jsx) });
  assert.deepEqual(
    found.map(({ disposition }) => disposition),
    ["candidate", "candidate", "candidate"],
  );
});

test("a review names the event handler and the non-React observers that still see separate writes", async () => {
  await withProject(
    {
      "editor.tsx": component(SAVE_CALLBACK, `<button onClick={handleSave} />`),
      "package.json": LEGACY_DOM,
      "store.ts": STORE,
    },
    async (root) => {
      const report = await analyzePath(root);
      const review = report.practices.find(({ action }) => action === "batch-observable-writes");
      assert.ok(review);
      assert.match(review.message, /^Review only: React renders these writes once/u);
      assert.match(review.message, /only when a non-React observer/u);
      assert.ok(
        review.evidence.some((line) => line.includes("synchronously inside a React event")),
      );
    },
  );
});

test("a callback forwarded unchanged to a child's host event prop runs inside the event", async () => {
  const child = `
export function SaveButton({ onSave }: { onSave: () => void }) {
  return <button onClick={onSave} />;
}
`;
  assert.deepEqual(
    await transactions({
      "editor.tsx": component(
        SAVE_CALLBACK,
        `<SaveButton onSave={handleSave} />`,
        `import { SaveButton } from "./save-button";`,
      ),
      "save-button.tsx": child,
    }),
    [{ action: "batch-observable-writes", disposition: "candidate", line: 9 }],
  );
});

test("a native component's event props dispatch through the renderer's batch", async () => {
  const native = `
import { forwardRef } from "react";
import { requireNativeComponent, type ViewProps } from "react-native";

interface DropProps extends ViewProps {
  onDragStart?: () => void;
  onTrackDrop?: () => void;
}

const NativeDropView = requireNativeComponent<DropProps>("RNDropView");

export const DropView = forwardRef<unknown, DropProps>(({ onTrackDrop, ...props }, ref) => (
  <NativeDropView ref={ref} onTrackDrop={onTrackDrop} {...props} />
));

export function DragSource({ onDragStart }: { onDragStart?: () => void }) {
  return <NativeDropView onDragStart={onDragStart} />;
}
`;
  const body = `
  const handleDrop = useCallback(() => {
    draft$.saved.set(true);
    status$.set("dropped");
  }, []);
  const handleDragStart = useCallback((source: string) => {
    draft$.title.set(source);
    status$.set("dragging");
  }, []);
`;
  const jsx = `(
    <DropView onTrackDrop={handleDrop}>
      <DragSource onDragStart={() => handleDragStart(id)} />
    </DropView>
  )`;
  const found = await transactions(
    {
      "drop-view.tsx": native,
      "editor.tsx": component(body, jsx, `import { DragSource, DropView } from "./drop-view";`),
    },
    LEGACY_NATIVE,
  );
  assert.deepEqual(
    found.map(({ disposition }) => disposition),
    ["candidate", "candidate"],
  );
});

const UNPROVEN_HANDLERS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  [
    "a handler an effect also calls",
    {
      "editor.tsx": component(
        `${SAVE_CALLBACK}  useEffect(() => { handleSave(); }, [handleSave]);`,
        `<button onClick={handleSave} />`,
      ),
    },
  ],
  [
    "a handler passed to a third-party component",
    {
      "editor.tsx": component(
        SAVE_CALLBACK,
        `<Menu onSelect={handleSave} />`,
        `import { Menu } from "menu-kit";`,
      ),
    },
  ],
  [
    "a handler that awaits before writing",
    {
      "editor.tsx": component(
        `  const handleSave = async () => {\n    await Promise.resolve();\n    draft$.saved.set(true);\n    status$.set("saved");\n  };`,
        `<button onClick={handleSave} />`,
      ),
    },
  ],
  [
    "writes a handler defers to a timer",
    {
      "editor.tsx": component(
        `  const handleSave = () => {\n    setTimeout(() => {\n      draft$.saved.set(true);\n      status$.set("saved");\n    }, 0);\n  };`,
        `<button onClick={handleSave} />`,
      ),
    },
  ],
  [
    "a handler registered with addEventListener",
    {
      "editor.tsx": component(
        `${SAVE_CALLBACK}  useEffect(() => {\n    window.addEventListener("focus", handleSave);\n    return () => window.removeEventListener("focus", handleSave);\n  }, [handleSave]);`,
        `<button onClick={handleSave} />`,
      ),
    },
  ],
  [
    "a handler stored on an object",
    {
      "editor.tsx": component(
        `${SAVE_CALLBACK}  const actions = { handleSave };`,
        `<button onClick={actions.handleSave} />`,
      ),
    },
  ],
  [
    "a module handler other files can import",
    {
      "editor.tsx": `
import { draft$, status$ } from "./store";

export function handleSave() {
  draft$.saved.set(true);
  status$.set("saved");
}

export function Editor() {
  return <button onClick={handleSave} />;
}
`,
    },
  ],
  [
    "a child that calls the forwarded callback from a timer",
    {
      "editor.tsx": component(
        SAVE_CALLBACK,
        `<SaveButton onSave={handleSave} />`,
        `import { SaveButton } from "./save-button";`,
      ),
      "save-button.tsx": `
export function SaveButton({ onSave }: { onSave: () => void }) {
  return <button onClick={() => setTimeout(onSave, 0)} />;
}
`,
    },
  ],
];

for (const [name, files] of UNPROVEN_HANDLERS) {
  test(`separate writes stay a change for ${name}`, async () => {
    const found = await transactions(files);
    assert.ok(found.length > 0, name);
    assert.ok(
      found.every(({ disposition }) => disposition === "change"),
      `${name}: ${JSON.stringify(found)}`,
    );
  });
}

test("React Native Pressable press callbacks stay a change without a source-visible host dispatch", async () => {
  const found = await transactions(
    {
      "editor.tsx": component(
        SAVE_CALLBACK,
        `<Pressable onPress={handleSave} />`,
        `import { Pressable } from "react-native";`,
      ),
    },
    LEGACY_NATIVE,
  );
  assert.deepEqual(found, [{ action: "batch-observable-writes", disposition: "change", line: 9 }]);
});
