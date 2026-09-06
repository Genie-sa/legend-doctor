import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

const CHROME =
  "<Header/><Summary/><Chart/><List/><Footer/><Aside/><Toolbar/><Legend/><Caption/><Logo/><Badge/><Actions/>";

function firstStateMessage(source: string): string {
  const finding = analyzeSource(source, "fixture.tsx").find(
    (candidate) => candidate.hook === "useState",
  );
  assert.equal(finding?.action, "use-observable");
  return finding?.message ?? "";
}

test("treats Legend's reactive native components and $React members as host surfaces", () => {
  const nativeMessage = firstStateMessage(`
    import { useState } from "react";
    import { $Text, $View } from "@legendapp/state/react-native";
    export function Dashboard({ total }: { total: number }) {
      const [count, setCount] = useState(0);
      return (
        <$View>
          ${CHROME}
          <$Text>{count} of {total}</$Text>
          <$View style={count > 0 ? { opacity: 1 } : { opacity: 0.5 }} />
          <$View onTouchEnd={() => setCount(count + 1)} />
        </$View>
      );
    }
  `);
  assert.match(nativeMessage, /make the attribute a reactive prop \(style on <\$View>/u);

  const webMessage = firstStateMessage(`
    import { useState } from "react";
    import { $React } from "@legendapp/state/react-web";
    export function Dashboard({ total }: { total: number }) {
      const [count, setCount] = useState(0);
      return (
        <section>
          ${CHROME}
          <p>{count} of {total}</p>
          <$React.div className={count > 0 ? "active" : "idle"} />
          <button onClick={() => setCount(count + 1)}>Add</button>
        </section>
      );
    }
  `);
  assert.match(webMessage, /make the attribute a reactive prop \(className on <\$React\.div>/u);
});
