import type { GoldStateGroupCase } from "../contracts.js";

export const formbricksStateGroups = [
  {
    file: "bulk-edit-options-modal.tsx",
    line: 74,
    members: ["textareaValue", "validationError"],
    rationale: "Text and its validation error are reset and edited as one modal draft.",
    target: "formbricks-bulk-options",
  },
  {
    file: "generate-personal-link-modal.tsx",
    line: 55,
    members: ["selectedSurveyId", "generatedUrl"],
    rationale:
      "Selection and generated URL share one modal-close reset but retain their command snapshot across the async generation boundary.",
    target: "formbricks-personal-link-modal",
  },
  {
    file: "when-to-send-card.tsx",
    line: 42,
    members: ["isEditActionModalOpen", "editingActionClass"],
    rationale:
      "The persistent edit payload and visibility flag form one atomic dialog model behind one bounded payload gate.",
    target: "formbricks-when-to-send",
  },
  {
    file: "feedback-records-table.tsx",
    line: 113,
    members: ["drawerRecordId", "isDrawerOpen"],
    rationale:
      "The undefined-initialized record cursor and visibility flag form one always-mounted drawer model.",
    target: "formbricks-feedback-records",
  },
] as const satisfies readonly GoldStateGroupCase[];
