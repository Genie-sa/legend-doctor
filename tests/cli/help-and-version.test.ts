import { CLI_PATH, run } from "./harness.js";
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

test("--help documents flags, dispositions, and exit codes on stdout", async () => {
  const { stdout, stderr } = await run(process.execPath, [CLI_PATH, "--help"]);

  assert.equal(stderr, "");
  assert.match(stdout, /Usage/u);
  assert.match(stdout, /--ignore-action <a,\.\.\.>/u);
  assert.match(stdout, /legend-doctor\.config\.json/u);
  assert.match(stdout, /--actionable/u);
  assert.match(stdout, /--disposition/u);
  assert.match(stdout, /--coverage/u);
  assert.match(stdout, /candidate \| change \| keep \| style/u);
  assert.match(stdout, /^Examples$/mu);
  assert.match(stdout, /--fail-on <value,\.\.\.>/u);
  assert.match(stdout, /schemaVersion 3/u);
  assert.match(stdout, /abstentionReason/u);
  assert.match(stdout, /^ {2}3 {2}scan completed and a shown finding matched --fail-on$/mu);
  assert.doesNotMatch(stdout, /^ {2}-[-\w, <>.]+ {2,}[A-Z][^\n]*\.$/mu);
  assert.match(stdout, /JSON contract/u);
  for (const reason of ["invalid_usage", "unsupported_target", "target_not_found", "scan_failed"]) {
    assert.match(stdout, new RegExp(reason, "u"));
  }
  assert.match(stdout, /Agent loop/u);
  assert.match(stdout, /keep-react-effect/u);
  assert.match(stdout, /Exit codes/u);
});

test("-h prints the same help without scanning", async () => {
  const { stdout } = await run(process.execPath, [CLI_PATH, "-h", "/definitely/not/a/real/path"]);

  assert.match(stdout, /Usage/u);
});

test("--version prints the package version", async () => {
  const { stdout, stderr } = await run(process.execPath, [CLI_PATH, "--version"]);

  assert.equal(stderr, "");
  assert.match(stdout, /^legend-doctor \d+\.\d+\.\d+\n$/u);
});
