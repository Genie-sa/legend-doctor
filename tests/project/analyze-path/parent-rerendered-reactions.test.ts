import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { HookFinding } from "../../../src/core/types.js";
import { analyzePath } from "../../../src/project/analyze-path/analyze-path.js";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { requireValue } from "./harness.js";
import test from "node:test";

type Verdict = readonly [HookFinding["action"], HookFinding["abstentionReason"] | null];

const SETTINGS = `
  import { observable } from "@legendapp/state";
  export const settings$ = observable({ codec: "h264", theme: "dark" });
`;

const BARE_CHILD = `
  import { useEffect } from "react";
  import { useValue } from "@legendapp/state/react";
  import { settings$ } from "./settings";
  export function Child({ build }: { build?: () => string }) {
    const codec = useValue(settings$.codec);
    useEffect(() => { reload(codec); }, [codec]);
    return <div />;
  }
`;

const MEMO_CHILD = `
  import { memo, useEffect } from "react";
  import { useValue } from "@legendapp/state/react";
  import { settings$ } from "./settings";
  export const Child = memo(({ build }: { build?: () => string }) => {
    const codec = useValue(settings$.codec);
    useEffect(() => { reload(codec); }, [codec]);
    return <div />;
  });
`;

function parent(subscription: string, site: string, name = "Parent"): string {
  return `
    import { useValue } from "@legendapp/state/react";
    import { settings$ } from "./settings";
    import { Child } from "./Child";
    export function ${name}({ ids }: { ids: string[] }) {
      ${subscription}
      return <main>{ids.map((id) => ${site})}</main>;
    }
  `;
}

const SAME_LEAF = "const codec = useValue(settings$.codec);";
const PLAIN_SITE = "<Child key={id} />";
const FRESH_SITE = "<Child key={id} build={() => id} />";

const HOOKS = `
  import { useValue } from "@legendapp/state/react";
  import { settings$ } from "./settings";
  export function useTheme() {
    return useValue(settings$.theme);
  }
  export function usePlayback() {
    const theme = useTheme();
    const codec = useValue(settings$.codec);
    return { codec, theme };
  }
`;

function hookParent(subscription: string): string {
  return parent(subscription, PLAIN_SITE).replace(
    'import { Child } from "./Child";',
    'import { Child } from "./Child"; import { usePlayback, useTheme } from "./hooks";',
  );
}

async function effectVerdict(files: Readonly<Record<string, string>>): Promise<Verdict> {
  const root = await mkdtemp(path.join(os.tmpdir(), "legend-doctor-parent-rerender-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, source]) =>
        writeFile(path.join(root, name), source, "utf8"),
      ),
    );
    const report = await analyzePath(root);
    const effect = requireValue(
      report.findings.find(
        (finding) => finding.hook === "useEffect" && finding.location.file.endsWith("Child.tsx"),
      ),
    );
    return [effect.action, effect.abstentionReason ?? null];
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const cases: readonly (readonly [string, Readonly<Record<string, string>>, Verdict])[] = [
  [
    "keeps the effect when the only parent subscribes to the same leaf and renders a bare child",
    {
      "Child.tsx": BARE_CHILD,
      "Parent.tsx": parent(
        `${SAME_LEAF} const build = () => codec;`,
        "<Child key={id} build={build} />",
      ),
    },
    ["keep-effect", null],
  ],
  [
    "converts the effect when the parent subscribes to a sibling leaf only",
    {
      "Child.tsx": BARE_CHILD,
      "Parent.tsx": parent("const theme = useValue(settings$.theme);", PLAIN_SITE),
    },
    ["use-observe-effect", null],
  ],
  [
    "converts the effect when the parent subscribes to a same-named observable from another module",
    {
      "Child.tsx": BARE_CHILD,
      "other.ts": SETTINGS,
      "Parent.tsx": parent(SAME_LEAF, PLAIN_SITE).replace('from "./settings"', 'from "./other"'),
    },
    ["use-observe-effect", null],
  ],
  [
    "converts the effect when the parent subscribes only to a projection of the leaf",
    {
      "Child.tsx": BARE_CHILD,
      "Parent.tsx": parent(
        'const modern = useValue(() => settings$.codec.get() === "vp9");',
        PLAIN_SITE,
      ),
    },
    ["use-observe-effect", null],
  ],
  [
    "reviews the effect when the parent subscribes to an ancestor of the leaf",
    {
      "Child.tsx": BARE_CHILD,
      "Parent.tsx": parent("const settings = useValue(settings$);", PLAIN_SITE),
    },
    ["review-effect", "render-cut-unproven"],
  ],
  [
    "reviews the effect when a memoized child receives only stable props",
    { "Child.tsx": MEMO_CHILD, "Parent.tsx": parent(SAME_LEAF, PLAIN_SITE) },
    ["review-effect", "render-cut-unproven"],
  ],
  [
    "keeps the effect when a memoized child receives a fresh callback",
    { "Child.tsx": MEMO_CHILD, "Parent.tsx": parent(SAME_LEAF, FRESH_SITE) },
    ["keep-effect", null],
  ],
  [
    "reviews the effect when only one of two parents subscribes to the leaf",
    {
      "Child.tsx": BARE_CHILD,
      "Parent.tsx": parent(SAME_LEAF, PLAIN_SITE),
      "Other.tsx": parent("", PLAIN_SITE, "Other"),
    },
    ["review-effect", "render-cut-unproven"],
  ],
  [
    "reviews the effect when the child also escapes through a value reference",
    {
      "Child.tsx": `${BARE_CHILD} export const Alias = Child;`,
      "Parent.tsx": parent(SAME_LEAF, PLAIN_SITE),
    },
    ["review-effect", "render-cut-unproven"],
  ],
  [
    "keeps the effect when the parent subscribes to the leaf through a custom hook it calls",
    { "Child.tsx": BARE_CHILD, "hooks.ts": HOOKS, "Parent.tsx": hookParent("usePlayback();") },
    ["keep-effect", null],
  ],
  [
    "converts the effect when the parent's custom hook subscribes to a sibling leaf only",
    { "Child.tsx": BARE_CHILD, "hooks.ts": HOOKS, "Parent.tsx": hookParent("useTheme();") },
    ["use-observe-effect", null],
  ],
  [
    "converts the effect when the parent calls the subscribing hook only inside a callback",
    {
      "Child.tsx": BARE_CHILD,
      "hooks.ts": HOOKS,
      "Parent.tsx": hookParent("const later = () => usePlayback();"),
    },
    ["use-observe-effect", null],
  ],
];

for (const [name, files, expected] of cases) {
  test(name, async () => {
    assert.deepEqual(await effectVerdict({ "settings.ts": SETTINGS, ...files }), expected);
  });
}

test("reviews the effect when the parent subscribes to only one of two dependency leaves", async () => {
  const child = BARE_CHILD.replace(
    "useEffect(() => { reload(codec); }, [codec]);",
    "const theme = useValue(settings$.theme); useEffect(() => { reload(codec, theme); }, [codec, theme]);",
  );
  assert.deepEqual(
    await effectVerdict({
      "settings.ts": SETTINGS,
      "Child.tsx": child,
      "Parent.tsx": parent(SAME_LEAF, PLAIN_SITE),
    }),
    ["review-effect", "render-cut-unproven"],
  );
});

test("proves a parent subscription through every Legend subscription hook it imports", async () => {
  const buildSite = "<Child key={id} build={build} />";
  const legendParent = (importClause: string, subscription: string): string =>
    parent(
      `const codec = ${subscription}(settings$.codec); const build = () => codec;`,
      buildSite,
    ).replace("{ useValue }", importClause);
  const verdicts = await Promise.all(
    [
      legendParent("{ use$ }", "use$"),
      legendParent("{ useSelector as select }", "select"),
      legendParent("* as Legend", "Legend.useSelector"),
    ].map((source) =>
      effectVerdict({ "settings.ts": SETTINGS, "Child.tsx": BARE_CHILD, "Parent.tsx": source }),
    ),
  );
  assert.deepEqual(
    verdicts,
    Array.from({ length: 3 }, () => ["keep-effect", null]),
  );

  const reduxParent = parent(
    "const codec = useSelector(settings$.codec); const build = () => codec;",
    buildSite,
  ).replace(
    'import { useValue } from "@legendapp/state/react";',
    'import { useSelector } from "react-redux";',
  );
  assert.notDeepEqual(
    await effectVerdict({
      "settings.ts": SETTINGS,
      "Child.tsx": BARE_CHILD,
      "Parent.tsx": reduxParent,
    }),
    ["keep-effect", null],
  );
});

test("keeps the effect when a same-file parent subscribes to every dependency leaf", async () => {
  const source = `
    import { useEffect } from "react";
    import { useValue } from "@legendapp/state/react";
    import { settings$ } from "./settings";
    const TabView: React.FC<{ build: () => string }> = ({ build }) => {
      const codec = useValue(settings$.codec);
      const theme = useValue(settings$.theme);
      useEffect(() => { reload(codec, theme); }, [theme, codec]);
      return <div />;
    };
    export const Page: React.FC<{ ids: string[] }> = ({ ids }) => {
      const codec = useValue(settings$.codec);
      const theme = useValue(settings$.theme);
      const build = () => codec + theme;
      return <main>{ids.map((id) => <TabView key={id} build={build} />)}</main>;
    };
  `;
  assert.deepEqual(await effectVerdict({ "settings.ts": SETTINGS, "PageChild.tsx": source }), [
    "keep-effect",
    null,
  ]);
});
