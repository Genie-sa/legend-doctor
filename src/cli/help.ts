export const HELP = `legend-doctor — read-only React hook and Legend State triage for coding agents

Usage
  legend-doctor [<target>] [flags]

Examples
  legend-doctor src --actionable
      Scan before editing: one JSON entry per edit, keep findings hidden
  legend-doctor src --disposition change
      Proven edits only, ready to apply mechanically
  legend-doctor src --disposition candidate
      Opportunities that need the agent to read the named source first
  legend-doctor src --fail-on change
      CI gate: exit 3 when any shown finding still has a proven edit
  legend-doctor src --coverage
      Add parsed files, functions, diagnostics, and skipped stages
  legend-doctor src --actionable --changed
      Report only files with uncommitted work; proofs still see the whole root
  legend-doctor src --since origin/main
      Report only files touched on this branch, including uncommitted work

Target
  <target>  File or directory to scan (default: current directory)
            Scan the smallest complete root that contains the relevant
            components, hooks, imports, re-exports, and observables; a
            single-file scan can hide the proof a safe finding needs.
            Files must be .ts, .tsx, .js, .jsx, .mts, .cts, .mjs, or .cjs.
            Directories named .git, .next, .turbo, build, coverage, dist,
            node_modules, and vendor are skipped. Stdin is not read.

Flags
  --actionable              Hide keep findings and secondary members of
                            finding groups, leaving one entry per edit
  --disposition <value>     Show only findings with this disposition
                            (candidate | change | keep | style)
  --fail-on <value,...>     Exit 3 when any shown finding or practice has one
                            of these dispositions; applied after filters
  --ignore-action <a,...>   Hide findings and practices with these action names
                            (for example use-ref,toggle-observable); hidden
                            counts include them; repeatable. Project defaults
                            live in the nearest legend-doctor.config.json at or
                            above the target: { "ignoreActions": [...],
                            "materiality": "broad" | "compact" }; flags win
  --materiality <tier>      broad (default) needs 12+ JSX elements for a cut
                            proven by owner size; compact lowers that to 8 and
                            tags those findings with materiality: compact. Cuts
                            proven by a transported read or a hook owner ignore
                            the tier
  --changed                 Analyze only files with uncommitted changes (staged,
                            unstaged, or untracked) relative to HEAD
  --staged                  Analyze only files in the git index, at their
                            working-tree content
  --since <ref>             Analyze only files changed since the merge base
                            with <ref>, plus uncommitted work
                            Scope flags need a directory target inside a git
                            work tree, and at most one may be set. Every file
                            under the target still loads, so cross-file proofs
                            for the selected files stay complete.
  --answer <id>=<yes|no>    Record an answer to an open review question with
                            its current fingerprint, then report the scan that
                            honours it; repeatable
  --note <text>             Justification stored with every --answer this run
  --confirm <file>          Honour answered review questions from a JSON file;
                            without it, <root>/.legend-doctor/confirmations.json
                            is used when present
  --coverage                Add coverage and diagnostics to the JSON report
  -h, --help                Show this help
  -v, --version             Print the version

Output
  Stdout is one JSON document, on success and on failure alike, and nothing
  is written to stderr.

JSON contract (schemaVersion 4)
  A completed scan is the report object with:
    status          "ok"
    root            directory every location.file is relative to
    analyzer        { version, build }; build digests the compiled analyzer,
                    so two reports compare only when it matches
    files, hooks    scan size; under a scope flag, files counts the analyzed
                    subset and scope { mode, ref?, contextFiles } names the
                    flag and how many files loaded for cross-file proofs
    capabilities    { legendState, reactCompiler, disabledRules }: the
                    installed @legendapp/state (version, useValue export, and
                    sync export) or null, whether the root enables the React
                    Compiler, and the rules those facts switched off, each
                    with a stable reason and the number of files that skipped
                    it
    findings        useState and useEffect findings; every review-state and
                    review-effect finding carries one stable, kebab-case
                    abstentionReason naming its primary blocker or constraint.
                    A review-state finding whose blocker is one confirmable
                    fact (or two, listed in facts) also carries assumption
                    { id, facts, fingerprint, question, ifConfirmed, research,
                    renderCost, updateSites, status }:
                    read every research step (file, line, optional lines and
                    total, check), then answer the yes/no question. A group
                    reports convertingCount in questions and each member's
                    outcome in assumption.members; blocked members stay under
                    review after confirmation
                    A review-effect finding whose verdict waits on a state
                    lists that state's question ids in waitsOn instead
                    A finding a confirmation converted carries verification
                    { harness, steps, expect }: the jsdom recipe that checks it
    questions       open review questions ranked by expected render saving
                    (renderCost × update sites), each with id, file, line
    confirmations   { applied, rejected, stale, unmatched, source } when
                    answers were read
    practices       Legend State practice findings
    hidden          { findings, practices } removed by --actionable or
                    --disposition, so an empty list is not a clean scan
    gate            { failOn, matched } when --fail-on is set
    coverage,       present only with --coverage
    diagnostics
  A failure is { status: "error", reason, message, next? } where reason is:
    invalid_usage       bad flag or value; nothing was scanned      exit 2
    unsupported_target  file target is not a scannable source file  exit 2
    target_not_found    the target path does not exist              exit 1
    scope_unavailable   a scope flag ran outside a git work tree,
                        without git, or with an unknown --since ref  exit 1
    scan_failed         analysis could not complete                 exit 1

Dispositions
  change     Apply the instruction; structural proof is complete
  candidate  Inspect the named source; resolve the missing timing,
             ownership, or type fact before editing
  keep       Preserve the current React or lifecycle boundary
  style      Apply only when the installed Legend State API supports the form

Agent loop
  1. Scan before editing:  legend-doctor <root> --actionable
  2. Apply one group of change findings; inspect candidates against source
  3. Run the application's formatter, typecheck, and relevant tests
  4. Scan the same root again and report the finding delta, including zero

Confirmations
  Write answers as { "confirmations": [{ "id", "answer": "yes" | "no",
  "fingerprint", "note"? }] } to <root>/.legend-doctor/confirmations.json, or
  pass any file with --confirm. Ids are stable across line shifts (file,
  owner, state name, blocker). Copy the fingerprint from the question: when
  the owner changes, the answer is reported stale and the question is asked
  again instead of silently applied. "yes" converts the finding with the
  assumption recorded in its evidence; "no" keeps it under review and stops
  the question. Work through report.questions in rank order.

Subscription plans
  report.subscriptionAnalysis (version 1) inventories useValue calls and groups
  proven child cuts by owner. Static JSX impact is separate from runtime data.
  Optional evidence: <root>/.legend-doctor/subscription-measurements.json.
  See REPORT.md for the measurement format and source fingerprint contract.

Suppression
  Precede a deliberate React effect with \`// legend-doctor keep-react-effect\`
  to suppress its review-effect finding.

Exit codes
  0  scan completed; the report may contain zero or more findings
  1  the scan failed (missing target, analysis error)
  2  invalid usage; nothing was scanned
  3  scan completed and a shown finding matched --fail-on
`;
