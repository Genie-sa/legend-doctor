import { actions } from "./harness.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import test from "node:test";

test("resolves a row alias whose initializer reads a property of its own name", () => {
  assert.deepEqual(
    actions(`
    import { useState } from "react";
    export function Ingredients({ items }) {
      const [have, setHave] = useState({});
      function toggle(id) {
        setHave({ [id]: true });
      }
      return (
        <Screen>
          <Section>
            <Card>
              <List>
                {items.map((item) => {
                  const checked = !!have[item.id];
                  const name = item.ingredient.name;
                  return (
                    <Row key={item.id} onPress={() => toggle(item.id)}>
                      <Check>{checked ? <Icon name="check" /> : null}</Check>
                      <Text>{name}</Text>
                    </Row>
                  );
                })}
              </List>
            </Card>
          </Section>
        </Screen>
      );
    }
  `),
    ["review-state"],
  );
});

test("does not prove uniqueness for a list that filters itself", () => {
  assert.deepEqual(
    actions(`
    import { useState } from "react";
    export function Ingredients() {
      const [have, setHave] = useState({});
      const items = items.filter((item) => item.id !== "");
      function toggle(id) {
        setHave({ [id]: true });
      }
      return (
        <Screen>
          <Section>
            <Card>
              <List>
                {items.map((item) => {
                  const checked = !!have[item.id];
                  return (
                    <Row key={item.id} onPress={() => toggle(item.id)}>
                      <Check>{checked ? <Icon /> : null}</Check>
                      <Text>{item.label}</Text>
                    </Row>
                  );
                })}
              </List>
            </Card>
          </Section>
        </Screen>
      );
    }
  `),
    ["review-state"],
  );
});

test("treats a ref alias whose conditional leads back to itself as a fresh ref", () => {
  const siblings =
    "<Header /><Toolbar /><Summary /><Filters /><List /><Footer /><Aside /><Help /><Status /><Preview />";
  const findings = analyzeSource(
    `
    import { useCallback, useState } from "react";
    function Leaf() { return null; }
    export function SelfRef({ alternate }: { alternate: boolean }) {
      const [visible, setVisible] = useState(false);
      const stable = useCallback((node: unknown) => synchronizeLayout(node), []);
      const setNode = alternate ? setNode : stable;
      return <main ref={setNode}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
    export function MutualRef({ alternate, wide }: { alternate: boolean; wide: boolean }) {
      const [visible, setVisible] = useState(false);
      const stable = useCallback((node: unknown) => synchronizeLayout(node), []);
      const first = alternate ? second : stable;
      const second = wide ? first : stable;
      return <main ref={first}>${siblings}<button onClick={() => setVisible(true)}>Open</button>{visible && <Leaf />}</main>;
    }
  `,
    "fixture.tsx",
  );
  assert.deepEqual(
    findings.filter((finding) => finding.name === "visible").map((finding) => finding.action),
    ["review-state", "review-state"],
  );
});
