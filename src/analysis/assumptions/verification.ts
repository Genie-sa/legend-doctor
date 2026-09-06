import type { StateAssumption, Verification } from "../../core/types.js";

const HARNESS = "legend-doctor/runtime";

/**
 * A confirmed answer replaced a proof the tool refused to make; the conversion it produced is the
 * one worth measuring. The recipe names the harness and the exact comparison to run before keeping it.
 */
export function verificationFor(
  assumption: StateAssumption,
  subject: string,
  ownerFile: string,
): Verification {
  const drive =
    assumption.updateSites > 0
      ? `drive every write site listed in the question's research (${assumption.updateSites} setter call sites) through the DOM: clicks, inputs, or the events those handlers listen to`
      : "drive one full mount and, when the effect has a cleanup, one unmount";
  return {
    expect:
      assumption.ifConfirmed === "use-mount"
        ? "the setup runs exactly once per mount in both versions, and the DOM after mount is identical"
        : `renders of the owner per update drop from one per write to zero (or one, when the owner still reads the value); the leaf subscriber renders instead; the DOM after every step is identical between versions`,
    harness: HARNESS,
    steps: [
      `import { mountDom, count } from "${HARNESS}" in a node:test file; mountDom gives a jsdom root, render, click, input, and signal helpers, and count tallies renders by name`,
      `keep the current ${subject} as the "before" component (copy it into the test with a count(renders, "before") call at the top of its body), and apply ${assumption.ifConfirmed} from the finding in ${ownerFile} as the "after" component with count(renders, "after")`,
      `mount each version once under StrictMode (mountDom(context, true)) and ${drive}; snapshot container.innerHTML after every step`,
      "compare: identical DOM snapshots for every step, and the render tallies described in expect",
      `record the measured counts in the confirmation's note for ${assumption.id}; a failed comparison means the answer was wrong: change it to "no" and revert the edit`,
    ],
  };
}
