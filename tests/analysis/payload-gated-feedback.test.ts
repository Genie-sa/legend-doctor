import { agentFindings } from "../../src/report/format.js";
import { analyzeSource } from "../../src/analysis/analyze-source.js";
import assert from "node:assert/strict";
import { requireValue } from "./harness.js";
import test from "node:test";

test("groups a payload-gated timed feedback flag without widening its subscriber", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function Dialog(_props: unknown) { return null; }
    function Button(_props: unknown) { return null; }
    export function ResetDialog({ account }: { account: { id: string } }) {
      const [password, setPassword] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      useResetPassword({
        onSuccess: (result: { password: string }) => setPassword(result.password),
      });
      const copy = async () => {
        if (!password) return;
        await navigator.clipboard.writeText(password);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      };
      const close = () => {
        setPassword(null);
        setCopied(false);
        dismiss();
      };
      if (!account) return null;
      ${"\n".repeat(100)}
      return <Dialog onClose={close}><Header /><Toolbar /><Summary /><Fields /><Preview /><Help />
        <Status /><History /><Aside /><Footer /><Actions />
        {password ? <section><code>{password}</code><Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button></section> : <Confirm account={account} />}
      </Dialog>;
    }
  `,
    "fixture.tsx",
  );
  const grouped = findings.filter((finding) => finding.group);
  assert.deepEqual(
    grouped.map((finding) => finding.action),
    ["use-observable", "use-observable"],
  );
  assert.deepEqual(requireValue(requireValue(grouped[0]).group).members, ["password", "copied"]);
  assert.match(requireValue(grouped[0]).message ?? "", /batch/u);
  assert.match(requireValue(grouped[0]).message ?? "", /nested feedback leaf/u);
  assert.equal(agentFindings(findings).filter((finding) => finding.group).length, 1);
});

test("rejects incomplete payload-gated feedback models", () => {
  const findings = analyzeSource(
    `
    import { useState } from "react";
    function Shell(_props: unknown) { return null; }
    export function OutsideGate() {
      const [payload, setPayload] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      const open = () => setPayload("secret");
      const copy = () => { setCopied(true); setTimeout(() => setCopied(false), 10); };
      const close = () => { setPayload(null); setCopied(false); };
      ${"\n".repeat(100)}
      return <Shell><A /><B /><C /><D /><E /><F /><G /><H /><I /><J /><K />
        <button onClick={open} /><button onClick={close} />
        {payload ? <code>{payload}</code> : null}<output>{String(copied)}</output><button onClick={copy} />
      </Shell>;
    }
    export function SplitReset() {
      const [payload, setPayload] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      const open = () => setPayload("secret");
      const copy = () => { setCopied(true); setTimeout(() => setCopied(false), 10); };
      const closePayload = () => setPayload(null);
      const closeFeedback = () => setCopied(false);
      ${"\n".repeat(100)}
      return <Shell><A /><B /><C /><D /><E /><F /><G /><H /><I /><J /><K />
        <button onClick={open} /><button onClick={closePayload} /><button onClick={closeFeedback} />
        {payload ? <section><code>{payload}</code><output>{String(copied)}</output><button onClick={copy} /></section> : null}
      </Shell>;
    }
    export function UntimedFeedback() {
      const [payload, setPayload] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      const open = () => setPayload("secret");
      const copy = () => setCopied(true);
      const close = () => { setPayload(null); setCopied(false); };
      ${"\n".repeat(100)}
      return <Shell><A /><B /><C /><D /><E /><F /><G /><H /><I /><J /><K />
        <button onClick={open} /><button onClick={close} />
        {payload ? <section><code>{payload}</code><output>{String(copied)}</output><button onClick={copy} /></section> : null}
      </Shell>;
    }
    export function PayloadFanout() {
      const [payload, setPayload] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      const open = () => setPayload("secret");
      const copy = () => { setCopied(true); setTimeout(() => setCopied(false), 10); };
      const close = () => { setPayload(null); setCopied(false); };
      ${"\n".repeat(100)}
      return <Shell><A /><B /><C /><D /><E /><F /><G /><H /><I /><J />
        <button onClick={open} /><button onClick={close} /><output>{payload}</output>
        {payload ? <section><code>{payload}</code><output>{String(copied)}</output><button onClick={copy} /></section> : null}
      </Shell>;
    }
    export function BroadFeedbackLeaf() {
      const [payload, setPayload] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      const open = () => setPayload("secret");
      const copy = () => { setCopied(true); setTimeout(() => setCopied(false), 10); };
      const close = () => { setPayload(null); setCopied(false); };
      ${"\n".repeat(100)}
      return <Shell><A /><B /><C /><D /><E /><F /><G /><H /><I /><J /><button onClick={open} /><button onClick={close} />
        {payload ? <section><One /><Two /><Three /><Four /><output>{String(copied)}</output><output>{copied ? "yes" : "no"}</output><button onClick={copy} /></section> : null}
      </Shell>;
    }
    export function ShadowedTimer({ setTimeout }: { setTimeout: (callback: () => void, delay: number) => void }) {
      const [payload, setPayload] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      const open = () => setPayload("secret");
      const copy = () => { setCopied(true); setTimeout(() => setCopied(false), 10); };
      const close = () => { setPayload(null); setCopied(false); };
      ${"\n".repeat(100)}
      return <Shell><A /><B /><C /><D /><E /><F /><G /><H /><I /><J /><button onClick={open} /><button onClick={close} />
        {payload ? <section><code>{payload}</code><output>{String(copied)}</output><button onClick={copy} /></section> : null}
      </Shell>;
    }
    export function SplitTimer({ start }: { start: boolean }) {
      const [payload, setPayload] = useState<string | null>(null);
      const [copied, setCopied] = useState(false);
      const open = () => setPayload("secret");
      const copy = () => {
        if (start) setCopied(true);
        else setTimeout(() => setCopied(false), 10);
      };
      const close = () => { setPayload(null); setCopied(false); };
      ${"\n".repeat(100)}
      return <Shell><A /><B /><C /><D /><E /><F /><G /><H /><I /><J /><button onClick={open} /><button onClick={close} />
        {payload ? <section><code>{payload}</code><output>{String(copied)}</output><button onClick={copy} /></section> : null}
      </Shell>;
    }
  `,
    "fixture.tsx",
  );
  for (const name of ["payload", "copied"]) {
    assert.ok(
      findings.filter((finding) => finding.name === name).every((finding) => !finding.group),
    );
  }
});
