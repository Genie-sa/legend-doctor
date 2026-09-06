import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("reviews a literal boolean leaf commanded by memoized event options", () => {
  const [finding] = analyzeSource(
    `
    import { useMemo, useState } from "react";
    function DecisionModal(props: { isVisible: boolean; onClose: () => void }) { return null; }
    export function Screen() {
      const [failureVisible, setFailureVisible] = useState(false);
      const actions = useMemo(() => [{
        label: "Download",
        onSelected: () => downloadReport(() => setFailureVisible(true)),
      }], []);
      return <main><Header /><Toolbar actions={actions} /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={failureVisible} onClose={() => setFailureVisible(false)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("does not treat lifecycle options passed to an unknown hook as JSX events", () => {
  const [finding] = analyzeSource(
    `
    import { useMemo, useState } from "react";
    function DecisionModal(props: { isVisible: boolean; onClose: () => void }) { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      const lifecycle = useMemo(() => ({
        onOpen: () => setVisible(true),
        onCleanup: () => setVisible(false),
      }), []);
      useLibraryLifecycle(lifecycle);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("does not treat event options wrapped by a JSX-time registrar as direct events", () => {
  const [finding] = analyzeSource(
    `
    import { useMemo, useState } from "react";
    function DecisionModal(props: { isVisible: boolean; onClose: () => void }) { return null; }
    export function Screen() {
      const [visible, setVisible] = useState(false);
      const actions = useMemo(() => [{ onSelected: () => setVisible(true) }], []);
      return <main><Header /><Toolbar actions={register(actions)} /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  assert.equal(requireValue(finding).action, "review-state");
});

test("requires literal leaf setters to be event-rooted and independently useful", () => {
  const findings = analyzeSource(
    `
    import { useMemo, useState } from "react";
    function DecisionModal(props: { isVisible: boolean; onClose: () => void }) { return null; }
    export function RenderWrite() {
      const [visible, setVisible] = useState(false);
      useMemo(() => { setVisible(true); return []; }, []);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
    export function OpaqueCallback() {
      const [visible, setVisible] = useState(false);
      const actions = useMemo(() => [{ compute: () => invokeNow(() => setVisible(true)) }], []);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
    export function CompanionWrite() {
      const [dirty, setDirty] = useState(false);
      const [visible, setVisible] = useState(false);
      const actions = useMemo(() => [{ onSelected: () => { setVisible(true); setDirty(true); } }], []);
      return <main><Header /><Toolbar /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} /><output>{String(dirty)}</output>
      </main>;
    }
    export function MutationOwned() {
      const mutation = useSaveMutation();
      const [visible, setVisible] = useState(false);
      const actions = useMemo(() => [{
        onSelected: async () => {
          setVisible(true);
          await mutation.mutateAsync();
          setVisible(false);
        },
      }], [mutation]);
      return <main><Header /><Toolbar actions={actions} /><Summary /><Fields /><Preview /><Help /><Status /><History /><Aside /><Footer /><Actions />
        <DecisionModal isVisible={visible} onClose={() => setVisible(false)} />
      </main>;
    }
  `,
    "fixture.tsx",
  );
  const candidates = findings.filter((candidate) => candidate.name === "visible");
  assert.equal(candidates.length, 4);
  for (const finding of candidates) {
    assert.equal(finding.action, "review-state");
  }
});
