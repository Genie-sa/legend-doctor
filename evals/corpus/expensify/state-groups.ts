import type { GoldStateGroupCase } from "../contracts.js";

export const expensifyStateGroups = [
  {
    file: "index.tsx",
    line: 47,
    members: ["isMouseDown", "initialScrollLeft", "initialScrollTop", "initialX", "initialY"],
    rationale:
      "The pointer-down command writes one listener-only snapshot group; migrate every member together so that event removes one owner render and listener callbacks keep one current ref model.",
    target: "expensify-image-view",
  },
  {
    file: "AddressPage.tsx",
    line: 47,
    members: ["currentCountry", "state", "city", "zipcode"],
    rationale: "The cascading address fields must remain one atomic observable draft.",
    target: "expensify-address",
  },
  {
    file: "AddressStep.tsx",
    line: 71,
    members: ["currentCountry", "state", "city", "zipcode"],
    rationale:
      "TypeScript casts are transport-only; the cascading address fields remain one atomic draft at the AddressForm boundary.",
    target: "expensify-bank-address-step",
  },
  {
    file: "FileUpload.tsx",
    line: 41,
    members: ["containerHeight", "uploadViewHeight", "altMethodsHeight"],
    rationale:
      "All three measurements drive one derived visibility decision and should produce one observable layout model.",
    target: "expensify-camera-file-upload",
  },
  {
    file: "WorkspaceTravelInvoicingSection.tsx",
    line: 84,
    members: ["isDisableConfirmModalVisible", "isOutstandingBalanceModalVisible"],
    rationale:
      "The two modal flags are possibly co-written on exclusive early-return branches; once both are observable no write can publish apart from React's original commit.",
    target: "expensify-travel-invoicing",
  },
] as const satisfies readonly GoldStateGroupCase[];
