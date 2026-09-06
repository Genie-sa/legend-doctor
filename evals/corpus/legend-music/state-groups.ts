import type { GoldStateGroupCase } from "../contracts.js";

export const legendMusicStateGroups = [
  {
    file: "components/MediaLibrary/Sidebar.tsx",
    line: 65,
    members: ["tempPlaylistId", "tempPlaylistName"],
    rationale:
      "The temporary playlist cursor and editable name open and reset as one atomic draft while controlled text edits update only the name leaf.",
    target: "legend-music",
  },
  {
    file: "components/MediaLibrary/Sidebar.tsx",
    line: 68,
    members: ["editingPlaylistId", "editingPlaylistName"],
    rationale:
      "The rename cursor and editable name open and reset as one atomic draft while controlled text edits update only the name leaf.",
    target: "legend-music",
  },
] as const satisfies readonly GoldStateGroupCase[];
