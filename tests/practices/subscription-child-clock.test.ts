import { analyzeLegendPractices } from "../../src/practices/analyze-legend-practices.js";
import assert from "node:assert/strict";
import test from "node:test";

test("fresh independent memo inputs do not authorize a cut past a sibling render-clock snapshot", () => {
  const findings = analyzeLegendPractices({
    fileName: "filters.tsx",
    sourceText: `
      import { observable } from "@legendapp/state";
      import { useValue } from "@legendapp/state/react";
      import { useMemo } from "react";
      const kind$ = observable("all");
      function DatePanel() {
        const year = new Date().getFullYear();
        return <Calendar endMonth={new Date(year + 2, 11)} />;
      }
      export function Filters({ view }: { view: string }) {
        const kind = useValue(kind$);
        const range = { from: new Date(0), to: new Date(1000) };
        const summary = useMemo(() => range.from.getTime(), [range]);
        return <main><Header/><Toolbar/><Summary/><Help/><Actions/><Footer/>
          <Aside/><Search/><Status/><Preview/><Navigation/>
          <output>{summary}</output>
          {view === "category" && <CategoryPanel kind={kind}/>}
          {view === "date" && <DatePanel/>}
        </main>;
      }
    `,
  });
  assert.equal(
    findings.some((finding) => finding.action === "move-use-value-down"),
    false,
    "independence from the selected value does not establish render equivalence",
  );
});
