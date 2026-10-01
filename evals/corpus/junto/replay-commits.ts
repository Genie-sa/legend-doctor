import type { ReplayCommit, ScoredReplayCase } from "../contracts.js";

const repository = "junto";
const root = "src/renderer";
const effect = "useEffect(() => {";

const gatedCauseReads =
  "The value feeds only the cause memo, which reads it only while the card is selected and graph-blocked, yet each write re-rendered every unselected NodeActions; the flow identity cache keeps unchanged FlowNode objects, so NodeShell itself does not render on these writes. The memo consumes all five subscriptions, so none can move into a gated selector or a child mounted on that path without the memo and the other four.";
const impactChromeReads =
  "impact.active also sets the ReactFlow className in this render, so moving the selection and revision reads into ImpactSeedChip needs the new impactModeActive$ boolean the stamping code publishes, and useCanvasGraph's own docVersion, executionRev, and selectedNodeId subscriptions keep CanvasGraph rendering on the same writes.";
const carriedBySelectionAndRebuild =
  "The deletion is part of the observer conversions of the structural rebuild and selection sync effects at lines 172 and 184, which carry the case.";
const reactOnlyStrandBatch =
  "publishStrands wraps these writes in batch, but only per-edge use$ subscribers read loomStrands$ keys and React 19 already coalesces their renders, so no tracker rerun is saved.";

type SubscriptionLocation = Pick<ScoredReplayCase, "file" | "line" | "source">;

const chatCoarseProjection = {
  cases: [
    {
      action: "select-primitive-projection",
      expected: "non-enforced",
      file: "components/nodes/TextNode.tsx",
      line: 124,
      rationale:
        "Every streamed token replaces chatState$[agentKey].transcript and re-renders the mark, which scans the transcript only for a pending or in-progress tool. Cutting those renders needs one selector that collapses status, pendingPermission, turnBusy, and that scan into a primitive, since chatActivity returns a fresh object; the expert instead reads the chatCoarse$ mirror the same commit adds.",
      source: "use$(chatState$[agentKey])",
    },
    {
      expected: "excluded",
      file: "lib/alert-attention.ts",
      line: 164,
      rationale:
        "A hand-written onChange listener moves to the chatCoarse$ mirror the same commit adds; the cut per-token run() calls come from the mirror, and no subscription action re-targets a manual listener.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "lib/alert-attention.ts",
      line: 201,
      rationale:
        "Only the peeked source changes from chatState$ to the coarse mirror; the effect still runs on every rollups change and nothing is removed.",
      source: effect,
    },
    {
      action: "select-primitive-projection",
      expected: "non-enforced",
      file: "lib/region-rollups.ts",
      line: 122,
      rationale:
        "useRegionRollups reads only status, pendingPermission, and turnBusy per agent, yet the whole-map subscription re-renders RtsBottomBar on every streamed token. A selector projecting those fields into a primitive key, with agentActivity peeking the map, removes those renders; the expert's edit rests on the chatCoarse$ mirror and its paint-equal gate from the same commit.",
      source: "use$(chatState$)",
    },
    {
      expected: "excluded",
      file: "lib/region-rollups.ts",
      line: 145,
      rationale:
        "Dropping chat from the dependency list saves only memo work, and is valid only because the same commit adds turnBusy to chatCoarseKey.",
      source: "useMemo(() => {",
    },
  ],
  commit: "eb851989ea344a86bfdb71fdb1fb12021f09bd89",
  parent: "fc94f8a3d8f32a720d41bf2d53de5e657a1cf485",
  repository,
  root,
} as const satisfies ReplayCommit;

const chatViewFieldSubscriptions = {
  cases: [
    {
      action: "split-use-value-leaves",
      equivalents: ["narrow-use-value-subscription"],
      expected: "enforced",
      file: "components/chat/ChatView.tsx",
      line: 43,
      rationale:
        "ChatView renders every AgentChatState field except unread. The reducer bumps unread with each appended transcript item and the view's own markRead effect then writes unread.set(0) alone, so the whole-agent subscription renders the view a second time per item; per-field subscriptions skip that render, and the parent NodeInspector does not subscribe to the chat store.",
      source: "use$(chatState$[agentKey])",
    },
    {
      expected: "excluded",
      file: "components/chat/ChatView.tsx",
      line: 48,
      rationale:
        "The dependency still reads the transcript length under a new binding; the effect runs exactly as often.",
      source: "useEffect(() => { markRead(agentKey); }",
    },
  ],
  commit: "71d7dc02bf1945ea0de9733d5c9b3659e2ada387",
  parent: "eb851989ea344a86bfdb71fdb1fb12021f09bd89",
  repository,
  root,
} as const satisfies ReplayCommit;

function editTargetSelector(
  { file, line, source }: SubscriptionLocation,
  component: string,
): ScoredReplayCase {
  return {
    action: "select-primitive-projection",
    expected: "enforced",
    file,
    line,
    rationale: `${component} reads editNodeId only in the effect that compares it with node.id, and no component above the canvas nodes reads it. Each edit request sets the id and the target clears it, rendering every mounted ${component} twice; the editNodeId === node.id selector renders only the target.`,
    source,
  };
}

const narrowNodeSubscriptions = {
  cases: [
    {
      action: "narrow-use-value-subscription",
      expected: "non-enforced",
      file: "components/InspectorPanel.tsx",
      line: 384,
      rationale:
        "InspectorPanel reads doc only to find the selected node, so every document write renders it and the inspector tree beneath it. A find selector cuts those renders only when unrelated writes keep the selected node object's identity, a runtime fact about how syncPositions and the mutation helpers rebuild doc.nodes.",
      source: "use$(state$.doc)",
    },
    {
      expected: "excluded",
      file: "components/InspectorPanel.tsx",
      line: 385,
      rationale:
        "selectedNodeId stays tracked inside the new selector, so its subscription and renders are unchanged.",
      source: "use$(state$.selectedNodeId)",
    },
    {
      action: "narrow-use-value-subscription",
      expected: "enforced",
      file: "components/browser/PageCard.tsx",
      line: 27,
      rationale:
        "PageCard reads sessions only as sessions[pageRef], and every writer sets or deletes one browser$.sessionByRef[ref], so the whole-map subscription renders every page card on another page's session event. Subscribing to sessionByRef[pageRef] below the pageRef memo keeps the read, and LinkNode, the only parent, does not subscribe to browser$.",
      source: "use$(browser$.sessionByRef)",
    },
    {
      action: "select-primitive-projection",
      expected: "enforced",
      file: "components/browser/PageCard.tsx",
      line: 28,
      rationale:
        "The only read is registry.surfaces.some(...) for this pageRef, folded into the docked boolean, while applyTransition replaces the registry on every layout, focus, pin, and other-surface change. A boolean selector renders only when this page's docked state flips.",
      source: "use$(dock$.registry)",
    },
    {
      action: "narrow-use-value-subscription",
      expected: "enforced",
      file: "components/browser/PageCard.tsx",
      line: 29,
      rationale:
        "stopErrors is read only at pageRef, and every writer sets or deletes dock$.stopErrorByRef[ref] for one ref, so narrowing to that key drops renders from other pages' stop results.",
      source: "use$(dock$.stopErrorByRef)",
    },
    editTargetSelector(
      { file: "components/nodes/FileNode.tsx", line: 16, source: "use$(state$.editNodeId)" },
      "FileNode",
    ),
    editTargetSelector(
      { file: "components/nodes/GroupNode.tsx", line: 36, source: "use$(state$.editNodeId)" },
      "GroupNode",
    ),
    editTargetSelector(
      { file: "components/nodes/LinkNode.tsx", line: 22, source: "use$(state$.editNodeId)" },
      "LinkNode",
    ),
    {
      action: "select-primitive-projection",
      expected: "non-enforced",
      file: "components/nodes/TextNode.tsx",
      line: 140,
      rationale:
        "EntityCard reads the whole snapshot state to resolve one hermes connection, so every adapter poll renders each agent card. A primitive projection needs a cross-module proof that resolveNodeConnections returns exactly one hermes connection for an agent entity, and the expert's selectors also swap its byKey lookup over ok bundles for findEntity, which can pick a different entity.",
      source: "use$(state$.snapshots)",
    },
    editTargetSelector(
      { file: "components/nodes/TextNode.tsx", line: 298, source: "use$(state$.editNodeId)" },
      "TextNode",
    ),
  ],
  commit: "de63ac35ed6c7fe83540d18598e6a2f802eb86ca",
  parent: "d1a2dab571d08b9e52c29613821980e5ad42add2",
  repository,
  root,
} as const satisfies ReplayCommit;

const selectionAndKernelRemints = {
  cases: [
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "components/Canvas.tsx",
      line: 172,
      rationale:
        "docVersion and executionRev are also subscribed by CanvasGraph at lines 1063-1064 for the impact chrome, and the rebuild always hands setNodes a fresh array, so an observer alone removes no CanvasGraph render. The saving also needs the commit's identity-preserving setNodes updater, and the effect mixes React-owned filter and search dependencies into the observer.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "components/Canvas.tsx",
      line: 184,
      rationale:
        "The effect writes React Flow's useNodesState and useEdgesState, which change on every selection, so CanvasGraph still renders once per selection. selectedNodeId also stays subscribed at line 1062, so the observer only collapses the subscription render and the effect's setState render into one render.",
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "enforced",
      file: "components/Canvas.tsx",
      line: 257,
      rationale:
        'focusNodeId reaches only this effect through useCanvasFocus, and all of the effect\'s work runs in requestAnimationFrame or after fitView resolves. Its closing focusNodeId.set("") lands alone, after the selection writes are already equal-value, so observing the leaf removes that whole-CanvasGraph render.',
      source: effect,
    },
    {
      action: "use-observe-effect",
      expected: "non-enforced",
      file: "components/Canvas.tsx",
      line: 288,
      rationale:
        "Every navigation path writes canvasName in the same task as loadDoc, so the docVersion subscriptions still render CanvasGraph. The committed onChange listener fires at write time with the previous canvas's nodeCount, so it can claim the fit before the new nodes land, which moves the fit.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/Canvas.tsx",
      line: 1002,
      rationale:
        "The deletion is part of the observer conversion of the viewport-fit effect at line 288, which carries the case.",
      source: "use$(state$.canvasName)",
    },
    {
      expected: "excluded",
      file: "components/Canvas.tsx",
      line: 1003,
      rationale: carriedBySelectionAndRebuild,
      source: "use$(state$.docVersion)",
    },
    {
      expected: "excluded",
      file: "components/Canvas.tsx",
      line: 1004,
      rationale: carriedBySelectionAndRebuild,
      source: "use$(kernel$.executionRev)",
    },
    {
      expected: "excluded",
      file: "components/Canvas.tsx",
      line: 1006,
      rationale:
        "The deletion is part of the observer conversion of the selection sync effect at line 184, which carries the case.",
      source: "use$(state$.selectedNodeId)",
    },
    {
      expected: "excluded",
      file: "components/Canvas.tsx",
      line: 1007,
      rationale:
        "The deletion is part of the observer conversion of the selection sync effect at line 184, which carries the case.",
      source: "use$(state$.selectedEdgeId)",
    },
    {
      expected: "excluded",
      file: "components/Canvas.tsx",
      line: 1010,
      rationale:
        "The deletion is part of the observer conversion of the focus effect at line 257, which carries the case.",
      source: "use$(state$.focusNodeId)",
    },
    {
      action: "move-use-value-into-child",
      equivalents: ["move-use-value-down"],
      expected: "non-enforced",
      file: "components/Canvas.tsx",
      line: 1062,
      rationale: impactChromeReads,
      source: "use$(state$.selectedNodeId)",
    },
    {
      action: "move-use-value-into-child",
      equivalents: ["move-use-value-down"],
      expected: "non-enforced",
      file: "components/Canvas.tsx",
      line: 1063,
      rationale: impactChromeReads,
      source: "use$(state$.docVersion)",
    },
    {
      action: "move-use-value-into-child",
      equivalents: ["move-use-value-down"],
      expected: "non-enforced",
      file: "components/Canvas.tsx",
      line: 1064,
      rationale: impactChromeReads,
      source: "use$(kernel$.executionRev)",
    },
    {
      expected: "excluded",
      file: "components/Canvas.tsx",
      line: 1066,
      rationale:
        "The impact memo moves into ImpactSeedChip with the reads at lines 1062-1064, which carry the case.",
      source: "useMemo(",
    },
  ],
  commit: "39dc025ab584643d3f03634928b3528f704458a5",
  parent: "8ea367e594a1802a5a2a3dc1ca23398097ad10c1",
  repository,
  root,
} as const satisfies ReplayCommit;

const blockerCauseSelector = {
  cases: [
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "components/nodes/NodeShell.tsx",
      line: 157,
      rationale: gatedCauseReads,
      source: "use$(state$.doc)",
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "components/nodes/NodeShell.tsx",
      line: 158,
      rationale: gatedCauseReads,
      source: "use$(kernel$.execution)",
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "components/nodes/NodeShell.tsx",
      line: 159,
      rationale:
        "executionRev appears only in the memo dependency list, but kernel-view sets it right after every execution set in the same synchronous stretch, so peeking it alone removes no render; the tick renders fall away only when all five gated reads move together.",
      source: "use$(kernel$.executionRev)",
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "components/nodes/NodeShell.tsx",
      line: 160,
      rationale: gatedCauseReads,
      source: "use$(state$.canvasName)",
    },
    {
      action: "move-use-value-down",
      expected: "non-enforced",
      file: "components/nodes/NodeShell.tsx",
      line: 161,
      rationale: gatedCauseReads,
      source: "use$(state$.actorRefs)",
    },
    {
      expected: "excluded",
      file: "components/nodes/NodeShell.tsx",
      line: 162,
      rationale:
        "The memo already skipped the cause walk on unselected cards; folding it into the selector saves compute only, and the render saving comes from the subscriptions at lines 157-161.",
      source: "useMemo(() => {",
    },
  ],
  commit: "3f7f064a04e3627d318f0bcf6e373e3249bcf37b",
  parent: "7e963e2f53b97bd8f952c4f569f533144cb82632",
  repository,
  root,
} as const satisfies ReplayCommit;

const workbenchShellSubscriptions = {
  cases: [
    {
      action: "split-use-value-leaves",
      equivalents: ["narrow-use-value-subscription"],
      expected: "enforced",
      file: "components/WorkSurfaceDock.tsx",
      line: 17,
      rationale:
        'The dock reads surfaces, pinnedMru, and pinnedLayout through surface-registry helpers called with the literal "pinned" zone, plus pinnedWidthFrac, while focus activation, focus layout, and WorkFocusShell\'s ResizeObserver publish focusMru, focusLayout, or focusSize alone through spread transitions that keep every other field. Leaf subscriptions keep every read and drop those renders; the resize-drag saving of the extracted memo child is a separate edit.',
      source: "use$(dock$.registry)",
    },
    {
      action: "split-use-value-leaves",
      equivalents: ["narrow-use-value-subscription"],
      expected: "enforced",
      file: "components/workbench/WorkFocusShell.tsx",
      line: 40,
      rationale:
        'The shell reads surfaces, focusMru, and focusLayout through surface-registry helpers called with the literal "focus" zone and reads focusSize only through peek() in an effect, yet its own ResizeObserver writes focusSize on every panel width change and pinned-dock activation and width drags write pinnedMru or pinnedWidthFrac alone. Leaf subscriptions keep every read and drop those renders of the shell and its FocusSurface subtree.',
      source: "use$(dock$.registry)",
    },
    {
      action: "split-use-value-leaves",
      equivalents: ["narrow-use-value-subscription"],
      expected: "non-enforced",
      file: "components/workbench/WorkbenchChrome.tsx",
      line: 37,
      rationale:
        "Both parents, WorkSurfaceDock and WorkFocusShell, subscribe to the whole registry and render this unmemoized chrome with fresh paneIds arrays, so every registry write still renders it; the saving needs the parent subscriptions split too.",
      source: "use$(dock$.registry)",
    },
  ],
  commit: "7b30487d172931999f20b7eb71bb8e132f071ce0",
  parent: "407b29632f9970593c2a389a78445b32d034256a",
  repository,
  root,
} as const satisfies ReplayCommit;

const terminalDockSubscriptions = {
  cases: [
    {
      action: "narrow-use-value-subscription",
      expected: "enforced",
      file: "components/herdr/HerdrTerminalModal.tsx",
      line: 942,
      rationale:
        "The modal reads only registry.surfaces, while focusSurface, setLayout, setFocusSize, and setPinnedWidthFrac publish registry objects that keep the surfaces array, so Legend notifies the whole-registry subscription but not a surfaces leaf. Its parent, App, subscribes to no dock$ path.",
      source: "use$(dock$.registry)",
    },
    {
      action: "narrow-use-value-subscription",
      equivalents: ["select-primitive-projection"],
      expected: "enforced",
      file: "components/terminal/TerminalSurface.tsx",
      line: 825,
      rationale:
        "surfaceById reads only state.surfaces and pinned is its only use, while MRU, layout, focus-size, and dock-width transitions keep the surfaces array, so a surfaces leaf drops those renders of every terminal whose memoized WorkbenchPane props are unchanged. The commit's boolean selector also skips surface-list changes that leave this surface's zone alone.",
      source: "use$(dock$.registry)",
    },
  ],
  commit: "dfa295f987ea1b104e8914abc9aa1cf27416596d",
  parent: "3e43694518470df3fd1b6f15f2a279736c3fb65d",
  repository,
  root,
} as const satisfies ReplayCommit;

const keyedLoomRoutes = {
  cases: [
    {
      expected: "excluded",
      file: "components/edges/CanvasLoom.tsx",
      line: 260,
      rationale:
        "The effect now skips equal-value obstacle writes and plans standalone routes into keyed loomRoutes$. The guard saves edge renders only when a geometry tick leaves every obstacle rect unchanged, a runtime fact, and the route planning is new provider-side work.",
      source: effect,
    },
    {
      expected: "excluded",
      file: "components/edges/CanvasLoom.tsx",
      line: 289,
      rationale: reactOnlyStrandBatch,
      source: "loomStrands$[spec.id]!.delete()",
    },
    {
      expected: "excluded",
      file: "components/edges/CanvasLoom.tsx",
      line: 338,
      rationale: reactOnlyStrandBatch,
      source: "loomStrands$[id]!.set(strand)",
    },
    {
      expected: "excluded",
      file: "components/edges/EtherEdge.tsx",
      line: 79,
      rationale:
        "The render-time document scan becomes presentation facts stamped at convert time. The edge still renders on the same props, so the saving is compute inside a render that still happens.",
      source: "state$.doc.peek()",
    },
    {
      action: "select-primitive-projection",
      expected: "non-enforced",
      file: "components/edges/EtherEdge.tsx",
      line: 140,
      rationale:
        "CanvasLoom publishes a new obstacle array on every geometry tick, and every edge routes against all of it. Cutting those renders needs a per-edge route whose path, label position, and detour flag keep their value across ticks, which the maintainer built as CanvasLoom's keyed loomRoutes$ publish; one primitive selector over live endpoint props cannot carry four outputs.",
      source: "use$(loomObstacles$)",
    },
    {
      action: "select-primitive-projection",
      expected: "non-enforced",
      file: "components/edges/EtherEdge.tsx",
      line: 141,
      rationale:
        "Corridors feed the route only for blocked edges, yet every edge re-renders on each corridor publish. Dropping the subscription needs the route planned in CanvasLoom's keyed loomRoutes$ publish, another edit.",
      source: "use$(loomCorridors$)",
    },
  ],
  commit: "2b9d21e0132dc9e6373293ab0c13bb729af36cfb",
  parent: "6f6648465d1e6293bdf8c6167ac2069943292e70",
  repository,
  root,
} as const satisfies ReplayCommit;

function ownAgentSlice(
  { file, line, source }: SubscriptionLocation,
  component: string,
): ScoredReplayCase {
  return {
    action: "narrow-use-value-subscription",
    equivalents: ["select-primitive-projection"],
    expected: "enforced",
    file,
    line,
    rationale: `${component} passes the whole chatCoarse$ map only to liveAttentionReasons, which reads pendingPermissionId at the node's own agent name and nothing else, and every chatCoarse$ writer sets one agent key. Subscribing to that key, or a sentinel for non-agent nodes, keeps the read and stops one agent's coarse write from rendering every mounted ${component}.`,
    source,
  };
}

const perAgentAttention = {
  cases: [
    ownAgentSlice(
      { file: "components/nodes/NodeShell.tsx", line: 370, source: "use$(chatCoarse$)" },
      "NodeShell",
    ),
    ownAgentSlice(
      { file: "components/nodes/TextNode.tsx", line: 299, source: "use$(chatCoarse$)" },
      "EntityCard",
    ),
    ownAgentSlice(
      { file: "components/terminal/TerminalCard.tsx", line: 74, source: "use$(chatCoarse$)" },
      "TerminalCard",
    ),
  ],
  commit: "c9098ae9528081d7a30115a610c5ce50faa4199a",
  parent: "c10ceeb6da9406177be892046d0cdee4079b4bb3",
  repository,
  root,
} as const satisfies ReplayCommit;

const claimedTaskIndex = {
  cases: [
    {
      action: "select-primitive-projection",
      expected: "non-enforced",
      file: "components/nodes/ClaimedTaskStrip.tsx",
      line: 17,
      rationale:
        "Every strip re-renders on each wholesale doc replacement to rescan nodes x tasks. The strip paints two facts, the task state hue and the brief, so no single primitive projection keeps every read, and claimedTaskForActorNode returns a fresh object per call; the maintainer's saving comes from a new canvas-wide index that publishes per-node keys behind a painted-fact equality.",
      source: "use$(state$.doc)",
    },
    {
      action: "select-primitive-projection",
      expected: "non-enforced",
      file: "components/nodes/ClaimedTaskStrip.tsx",
      line: 18,
      rationale:
        "actorRefs feeds the same per-node claim scan as the doc read on line 17, so its renders go away only with that projection's keyed index, another edit.",
      source: "use$(state$.actorRefs)",
    },
  ],
  commit: "d7fcb91ae3b4a3cb612291a30cbc6dc5ea762642",
  parent: "c9098ae9528081d7a30115a610c5ce50faa4199a",
  repository,
  root,
} as const satisfies ReplayCommit;

/** Every hook edit in the junto maintainer's renderer subscription and render-cost commits, classified against each parent tree. */
export const juntoReplayCommits: readonly ReplayCommit[] = [
  chatCoarseProjection,
  chatViewFieldSubscriptions,
  narrowNodeSubscriptions,
  selectionAndKernelRemints,
  blockerCauseSelector,
  workbenchShellSubscriptions,
  terminalDockSubscriptions,
  keyedLoomRoutes,
  perAgentAttention,
  claimedTaskIndex,
];
