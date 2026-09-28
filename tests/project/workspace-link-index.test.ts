import type { WorkspaceLink } from "../../src/project/workspace/packages.js";
import assert from "node:assert/strict";
import { isWithin } from "../../src/project/workspace/packages.js";
import path from "node:path";
import { pathIdentityKey } from "../../src/core/path-identity.js";
import process from "node:process";
import test from "node:test";
import { workspaceLinkIndex } from "../../src/project/workspace/link-index.js";

const ROOT = path.resolve("/repo");
const WEB_MODULES = path.join(ROOT, "apps/web/node_modules");
const SYNTHETIC_LINK_COUNT = 2000;

const at = (...segments: readonly string[]): string => path.join(ROOT, ...segments);
const link = (from: string, to: string): WorkspaceLink => ({ from, to });

/** Nested, duplicated, and prefix-sharing links whose precedence depends on declaration order. */
const ADVERSARIAL_LINKS = [
  link(path.join(WEB_MODULES, "@scope/ui"), at("packages/ui")),
  link(path.join(WEB_MODULES, "@scope/ui-kit"), at("packages/ui-kit")),
  link(path.join(WEB_MODULES, "@scope/ui/node_modules/inner"), at("packages/inner")),
  link(path.join(WEB_MODULES, "deep/node_modules/nested"), at("packages/nested")),
  link(path.join(WEB_MODULES, "deep"), at("packages/deep")),
  link(path.join(WEB_MODULES, "@scope/ui"), at("packages/shadowed")),
] as const satisfies readonly WorkspaceLink[];

function linearLinkedPath(links: readonly WorkspaceLink[], file: string): string {
  const match = links.find((candidate) => isWithin(candidate.from, file));
  return match
    ? path.join(match.to, path.relative(pathIdentityKey(match.from), pathIdentityKey(file)))
    : file;
}

function adversarialProbes(): readonly string[] {
  const inside = ADVERSARIAL_LINKS.flatMap(({ from }) =>
    ["", "index.ts", "package.json", "src/a/b.tsx", "node_modules"].map((suffix) =>
      path.join(from, suffix),
    ),
  );
  const outside = [
    path.join(WEB_MODULES, "@scope/u"),
    path.join(WEB_MODULES, "@scope/uix/index.ts"),
    path.join(WEB_MODULES, "deeper/index.ts"),
    path.join(WEB_MODULES, "@scope/ui/../ui-kit/index.ts"),
    at("elsewhere/file.ts"),
    path.parse(ROOT).root,
    ROOT,
  ];
  const probes = [...inside, ...outside];
  return [
    ...probes,
    ...probes.map((probe) => probe.toUpperCase()),
    ...probes.map((probe) => `${probe}${path.sep}`),
    ...probes.map((probe) => path.relative(process.cwd(), probe)),
  ];
}

test("link lookups agree with a linear scan over every declared link", () => {
  const index = workspaceLinkIndex(ADVERSARIAL_LINKS);
  for (const probe of adversarialProbes()) {
    assert.equal(index.linkedPath(probe), linearLinkedPath(ADVERSARIAL_LINKS, probe), probe);
    assert.equal(
      index.containsLink(probe),
      ADVERSARIAL_LINKS.some(({ from }) => isWithin(probe, from)),
      probe,
    );
  }
});

test("the earliest declared link owns a path, even when a later link is nearer", () => {
  const index = workspaceLinkIndex(ADVERSARIAL_LINKS);
  assert.equal(
    index.linkedPath(path.join(WEB_MODULES, "@scope/ui/node_modules/inner/index.ts")),
    at("packages/ui/node_modules/inner/index.ts"),
  );
  assert.equal(
    index.linkedPath(path.join(WEB_MODULES, "deep/node_modules/nested/index.ts")),
    at("packages/nested/index.ts"),
  );
  assert.equal(index.linkedPath(path.join(WEB_MODULES, "@scope/ui-kit")), at("packages/ui-kit"));
});

test("a lookup reads only the link it resolves to, never every declared link", () => {
  let fromReads = 0;
  const links = Array.from({ length: SYNTHETIC_LINK_COUNT }, (_unused, order): WorkspaceLink => {
    const from = at(`packages/owner-${order}/node_modules/dependency-${order}`);
    return {
      get from(): string {
        fromReads += 1;
        return from;
      },
      to: at(`packages/dependency-${order}`),
    };
  });
  const index = workspaceLinkIndex(links);
  const readsWhileIndexing = fromReads;
  for (let order = 0; order < SYNTHETIC_LINK_COUNT; order += 1) {
    index.linkedPath(at(`packages/owner-${order}/node_modules/dependency-${order}/index.ts`));
    index.linkedPath(at(`packages/owner-${order}/src/index.ts`));
    index.containsLink(at(`packages/owner-${order}/node_modules`));
  }
  assert.equal(readsWhileIndexing, SYNTHETIC_LINK_COUNT);
  assert.equal(fromReads - readsWhileIndexing, SYNTHETIC_LINK_COUNT);
});
