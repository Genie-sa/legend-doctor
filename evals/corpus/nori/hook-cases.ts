import type { GoldHookCase } from "../contracts.js";

export const noriHookCases = [
  {
    action: "use-observable",
    file: "components/bookmark/BookmarkItem.tsx",
    hook: "useState",
    line: 115,
    name: "menuOpen",
    rationale:
      "The flag reaches only AnchorMenu's `visible` prop; closing the menu writes it alone, so a leaf subscriber closes it without rerendering the memoized tile, its favicon, and its title.",
    target: "nori",
  },
  {
    action: "keep-effect",
    file: "components/home/BookmarkPager.tsx",
    hook: "useEffect",
    line: 224,
    name: null,
    rationale:
      "The effect only updates pager refs and scrolls the committed `useAnimatedRef` pager; `selectedListIndex` and `pageWidth` already rerender the owner through its view model, so it causes no render and an observable reaction would remove none.",
    target: "nori",
  },
  {
    action: "use-observable",
    file: "components/sheet/BookmarkEditorSheet.tsx",
    hook: "useState",
    line: 32,
    name: "metadataLoading",
    rationale:
      "The flag only labels the save button, while the owner recomputes tag suggestions over every bookmark and renders the whole form; the true write before the metadata fetch no longer rerenders that owner.",
    target: "nori",
  },
  {
    action: "keep-effect",
    file: "components/sheet/SettingsSheet.tsx",
    hook: "useEffect",
    line: 30,
    name: null,
    rationale:
      "Resetting the Reanimated `scrollOffset` shared value renders nothing, and `page` already rerenders the whole sheet title, header, and body, so no Legend reaction removes a render or effect pass.",
    target: "nori",
  },
] as const satisfies readonly GoldHookCase[];
