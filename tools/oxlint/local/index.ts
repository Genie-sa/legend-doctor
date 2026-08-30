import { eslintCompatPlugin } from "@oxlint/plugins";

import { noBannedTypeAssertionsRule } from "./rules/no-banned-type-assertions.ts";
import { noInOperatorRule } from "./rules/no-in-operator.ts";
import { noOptionalFunctionParametersRule } from "./rules/no-optional-function-parameters.ts";
import { noReexportOnlyModulesRule } from "./rules/no-reexport-only-modules.ts";
import { noSwitchRule } from "./rules/no-switch.ts";

/**
 * Project-local Oxlint rules. Original implementations of generic concepts
 * from typeonce-dev/ai-automation, which is unlicensed and therefore not
 * vendored; only the Effect-agnostic ideas are carried over.
 */
const localPlugin = eslintCompatPlugin({
  meta: { name: "local" },
  rules: {
    "no-banned-type-assertions": noBannedTypeAssertionsRule,
    "no-in-operator": noInOperatorRule,
    "no-optional-function-parameters": noOptionalFunctionParametersRule,
    "no-reexport-only-modules": noReexportOnlyModulesRule,
    "no-switch": noSwitchRule,
  },
});

export default localPlugin;
