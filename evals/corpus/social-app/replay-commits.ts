import type { ReplayCommit } from "../contracts.js";

const effect = "React.useEffect(() => {";

const timeElapsedEffect = {
  cases: [
    {
      action: "delete-derived-state",
      expected: "non-enforced",
      file: "view/com/util/TimeElapsed.tsx",
      line: 16,
      rationale:
        "Each minute tick commits the stale string and the effect renders again, so computing ago(timestamp) in render removes a pass per row. The effect keys on tick, which the expression never reads; the edit holds only because ago reads the clock and the component re-renders on every tick through the tick context, and it also refreshes the string on unrelated renders.",
      source: "React.useState(() => ago(timestamp))",
    },
    {
      action: "delete-effect",
      expected: "non-enforced",
      file: "view/com/util/TimeElapsed.tsx",
      line: 18,
      rationale:
        "The effect's only work is the setTimeAgo write, so it goes with the state at line 16 and rests on the same clock-read proof.",
      source: effect,
    },
  ],
  commit: "361d255e954d6afbc0bbae293acf73ac8882f356",
  parent: "256bb33de0cd24b0ac541bfdddc8daa55bf59b60",
  repository: "social-app",
  root: "src",
} as const satisfies ReplayCommit;

const replyGateState = {
  cases: [
    {
      action: "delete-effect",
      expected: "non-enforced",
      file: "view/com/post-thread/PostThread.tsx",
      line: 213,
      rationale:
        "The effect only forwards the reply gate computed from rootPost and error to the screen's setter; deleting it is sound only with the screen state at screens/PostThread.tsx:36 removed and the compose prompt rendered here, as the commit does.",
      source: "useEffect(() => {",
    },
    {
      action: "delete-derived-state",
      expected: "non-enforced",
      file: "view/screens/PostThread.tsx",
      line: 36,
      rationale:
        "canReply is written only by the child's effect from the child's thread query and read only in the screen's prompt condition, so each write re-renders the screen and the whole thread list. Deriving it needs the prompt moved into PostThread, and the useState(false) initializer hides the prompt on the first commit even when the thread is already cached.",
      source: "React.useState(false)",
    },
  ],
  commit: "4b71950d9920913a2a2cc9e493b23b87aad7cec1",
  parent: "2174feed441459448668934015810fe0eb876dde",
  repository: "social-app",
  root: "src",
} as const satisfies ReplayCommit;

const hostingProviderDialog = {
  cases: [
    {
      expected: "excluded",
      file: "view/com/auth/server-input/index.tsx",
      line: 31,
      rationale:
        "pdsAddressHistory is written only by onClose, so the owner renders for it once per close; it moves into the new child only so the imperative handle can read it, and removes no render.",
      source: "const [pdsAddressHistory, setPdsAddressHistory] = React.useState<string[]>(",
    },
    {
      expected: "excluded",
      file: "view/com/auth/server-input/index.tsx",
      line: 34,
      rationale:
        "fixedOption stays in the owner and changes from a one-element array to a string, a refactor.",
      source: "const [fixedOption, setFixedOption] = React.useState([BSKY_SERVICE])",
    },
    {
      action: "move-state-down",
      expected: "non-enforced",
      file: "view/com/auth/server-input/index.tsx",
      line: 35,
      rationale:
        "Each keystroke re-rendered the owner and the whole Dialog.Outer portal. The owner's onClose also reads customAddress and the input is inline JSX, so moving the state needs a new child plus an imperative handle; on web the child remounts on every open, so the expert adds previousCustomAddress to carry the value across opens.",
      source: "const [customAddress, setCustomAddress] = React.useState('')",
    },
    {
      expected: "excluded",
      file: "view/com/auth/server-input/index.tsx",
      line: 40,
      rationale:
        "onClose now reads the form through the child's imperative handle and records the previous custom address, a refactor that follows the state move.",
      source: "const onClose = React.useCallback(() => {",
    },
  ],
  commit: "083a5c9667b243bf935f663386041e954d93803d",
  parent: "24a4ab2b0f155a385581da4855dae5b8cb63220f",
  repository: "social-app",
  root: "src",
} as const satisfies ReplayCommit;

/** The social-app maintainers' derived-state and re-render commits, classified against each parent tree. */
export const socialAppReplayCommits: readonly ReplayCommit[] = [
  timeElapsedEffect,
  replyGateState,
  hostingProviderDialog,
];
