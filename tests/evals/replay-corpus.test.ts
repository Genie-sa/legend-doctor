import assert from "node:assert/strict";
import { replayCommits } from "../../evals/corpus/replay-commits.js";
import { repositories } from "../../evals/corpus/repositories.js";
import test from "node:test";

const fullSha = /^[0-9a-f]{40}$/u;

test("every replay commit pins a public corpus repository by full SHAs", () => {
  const pinned = new Set(repositories.map(({ name }) => name));
  for (const { commit, parent, repository } of replayCommits) {
    assert.ok(pinned.has(repository), `${repository} is not a pinned corpus repository`);
    assert.match(commit, fullSha);
    assert.match(parent, fullSha);
  }
});

test("each replayed location carries one label", () => {
  const labeled = new Set<string>();
  for (const { cases, commit, root } of replayCommits) {
    for (const { file, line } of cases) {
      const location = `${commit.slice(0, 7)} ${root}/${file}:${line}`;
      assert.ok(!labeled.has(location), `${location} is labeled twice`);
      labeled.add(location);
    }
  }
});
