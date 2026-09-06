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
] as const satisfies readonly GoldStateGroupCase[];
