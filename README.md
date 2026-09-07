# Legend Doctor

Your React app renders more than it needs to. Legend Doctor proves where, and shows the exact edit that cuts it.

It is a read-only scanner for TypeScript and JavaScript. It reads your `useState`, `useEffect`, and
[Legend State](https://legendapp.com/open-source/state/) code and reports:

- proven edits that remove a render or an effect
- edits that need one more fact before they are safe
- code that is already right and should stay as it is

It never edits files. It never guesses. It emits `change` only when the TypeScript structure proves the edit.

## Why fewer renders

Most React apps re-render whole trees when one value changes. Legend State fixes this by letting each leaf subscribe
to exactly the value it renders. Jay Meistrich, who built Legend State, explains the idea and the numbers in his
App.js Conf 2026 talk:

[![How to Build the Fastest Apps: Break the Rules](https://i.ytimg.com/vi/K3flMIHS-cI/hqdefault.jpg)](https://youtu.be/K3flMIHS-cI)

Legend Doctor is the tool that finds those cuts in an existing codebase, and holds every one of them to a proof.

## Quick start

Requires Node.js 22 or newer.

```bash
npx legend-doctor /absolute/path/to/app --actionable
```

Or install it once and call `legend-doctor` directly:

```bash
npm install --save-dev legend-doctor
```

Scan the smallest folder that contains the related components, hooks, and observables together. One file rarely
holds enough proof.

## Use it with a coding agent

Copy the skill into your project, then the agent scans before and after every state or effect edit.

```bash
cp -r node_modules/legend-doctor/skills/legend-doctor /path/to/app/.claude/skills/
```

The report JSON is stable and versioned. Agents apply `change` findings, read the named source for `candidate`
findings, and rescan.

To see the effect at runtime, pair it with [genie-react](https://github.com/Genie-sa/genie-react). Genie counts real
renders in the running app, so the agent can record a render count before the edit and check it dropped after.

## Run in CI

The GitHub Action reviews every pull request and reports only the findings the change introduced, not the existing
backlog. It posts one sticky summary comment, inline review comments on the changed lines, and a commit status. It is
advisory by default. Add `.github/workflows/legend-doctor.yml`:

```yaml
name: Legend Doctor
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write
concurrency:
  group: legend-doctor-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  legend-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          fetch-depth: 0
      - uses: Genie-sa/legend-doctor@v0.1.3
        with:
          directory: src
```

Keep `fetch-depth: 0`. The action diffs the pull request against its base branch and needs the history.

Or paste this to your coding agent:

> Add Legend Doctor to this repository so it reviews every pull request. Create a branch, add the workflow file shown
> in the "Run in CI" section of https://github.com/Genie-sa/legend-doctor exactly as written, set `directory` to the
> folder that holds our React components, commit only that file, and open a pull request titled "Add Legend Doctor
> CI". Do not change application code.

| Input            | Default   | Meaning                                                                                  |
| ---------------- | --------- | ---------------------------------------------------------------------------------------- |
| `directory`      | `.`       | Folder to scan                                                                           |
| `scope`          | `changed` | `changed` reports what the PR introduced, `files` every finding in changed files, `full` |
| `blocking`       | `none`    | Fail the check on `change`, `candidate`, or `style` findings                             |
| `materiality`    | config    | `compact` also reports render cuts in components with 8 to 11 JSX elements               |
| `ignore-actions` | config    | Comma-separated actions to hide, added to the config file's list                         |

The action skips pull requests that change no React files. [action.yml](action.yml) lists every input and output.

## Configure

Put `legend-doctor.config.json` at the repository root, or anywhere above the folder you scan. The nearest one wins.

```json
{
  "ignoreActions": ["use-ref", "toggle-observable"],
  "materiality": "compact"
}
```

| Key             | Values                                     | Effect                                                  |
| --------------- | ------------------------------------------ | ------------------------------------------------------- |
| `ignoreActions` | Action names from [ACTIONS.md](ACTIONS.md) | Hide those findings. They count under `hidden`.         |
| `materiality`   | `broad` or `compact`                       | Minimum owner size for a size-gated render cut, 12 or 8 |

Flags override the file. `--ignore-action a,b` adds to the list and `--materiality` replaces the tier. An unknown key
or action name fails the scan with exit code 2, so a typo never silently hides findings.

To keep one effect on purpose, put this comment above it instead of hiding the whole action:

```tsx
// legend-doctor keep-react-effect
useEffect(() => syncWithExternalSystem(), []);
```

## What a finding says

Every finding has a disposition:

| Disposition | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `change`    | Proven. Apply the instruction as written.                                 |
| `candidate` | One fact is missing. The finding names the source to read.                |
| `keep`      | Correct as is. Leave the React or lifecycle boundary alone.               |
| `style`     | Cleaner form. Apply only when the installed Legend State API supports it. |

Stdout is always one JSON document and stays valid JSON when the scan fails, so a caller parses a single channel and
never prose. Nothing is written to stderr.

`legend-doctor --help` documents every report field. [REPORT.md](REPORT.md) goes further: the `assumption` a
`review-state` finding carries when one yes/no fact would turn it into a `change`, and how to record the answer.

## The loop

1. Scan.
2. Apply one group of `change` findings.
3. Read the source for each `candidate`. Edit only when the missing fact is proven.
4. Run your formatter, typecheck, and tests.
5. Scan again. Stop when every remaining finding is `keep` or an understood `candidate`.

Check [EXAMPLES.md](EXAMPLES.md) before applying an action you have not seen before.

## What it cuts

| Cost                                               | Typical action                                         |
| -------------------------------------------------- | ------------------------------------------------------ |
| A parent render caused by one child's local state  | `move-state-down`, `use-observable`                    |
| A render for a value only commands or cleanup read | `use-ref`                                              |
| Derived state kept in sync by an effect            | `delete-derived-state`, `delete-effect`                |
| An effect that runs after an event it could join   | `move-to-event`                                        |
| A render used only to run an external reaction     | `use-observe-effect`                                   |
| A subscription wider than the value rendered       | `narrow-use-value-subscription`, `move-use-value-down` |
| A render read that never subscribes                | `use-value-for-render-read`                            |
| A parent clone where one path changed              | `narrow-observable-write`, `assign-observable-fields`  |

[EXAMPLES.md](EXAMPLES.md) has one worked example per action.

## Commands

```bash
legend-doctor <root> --disposition change      # proven edits only
legend-doctor <root> --disposition candidate   # needs a human or agent to read more
legend-doctor <root> --actionable              # one entry per edit, keep findings hidden
legend-doctor <root> --fail-on change          # CI: exit 3 while a proven edit remains
legend-doctor <root> --coverage                # parser and analysis coverage
legend-doctor <root> --ignore-action use-ref   # hide one action for this run
legend-doctor <root> --answer "<id>=yes"       # record an answer to a review question
```

Scope a rescan to the files you touched. The whole root still loads, so proofs stay complete.

```bash
legend-doctor <root> --actionable --changed             # uncommitted files
legend-doctor <root> --actionable --staged              # staged files
legend-doctor <root> --actionable --since origin/main   # this branch
```

By default a render cut proven by owner size needs a component with 12 or more JSX elements. `--materiality compact`
lowers that to 8. Cuts proven another way — a transported read reaching a child that subscribes, or a custom hook
owner — do not depend on the tier. Run `--help` for every flag and exit code.

## Safety rules

- One owner per value. Do not mirror React state and an observable.
- `useObservable` for state tied to a component's lifetime.
- `useValue` at the smallest stable leaf that renders the value.
- `.peek()` only in a proven non-tracking command.
- `.assign()` or `batch()` when several writes are one update.
- Keep small, one-control state in React when an observable removes no render.
- Keep an effect when its timing, replay, or cleanup is not proven equivalent.
- Apply grouped findings together.
- Check the installed `@legendapp/state` version before changing an API.

Under `@legendapp/state` 2.x the tracking rule is off, because `enableReactTracking({ auto: true })` can make render
reads track app-wide. In React Compiler projects, keep clone writes unless the report proves the in-place write safe.

These rules follow the [Legend State React API](https://legendapp.com/open-source/state/v3/react/react-api/), the
[reactivity guide](https://legendapp.com/open-source/state/v3/usage/reactivity/), and the
[Legend State best-practices skill](https://github.com/LegendApp/legend-skills/tree/main/legend-state-best-practices).

## Develop

```bash
npm run typecheck
npm test
npm run eval
```

Read [evals/README.md](evals/README.md) before changing corpus targets, labels, or scoring. `npm run bench` times
the analysis pipeline on a checkout you point it at.

MIT licensed.
