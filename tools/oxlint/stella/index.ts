import { eslintCompatPlugin } from "@oxlint/plugins";

import { rules as noAmbientNondeterminismRules } from "./no-ambient-nondeterminism.ts";
import { rules as noAsyncContextEnterWithRules } from "./no-async-context-enter-with.ts";
import { rules as noPartialRecordSatisfiesRules } from "./no-partial-record-satisfies.ts";
import { rules as noPathPrefixContainmentRules } from "./no-path-prefix-containment.ts";
import { rules as noSwallowedRejectionRules } from "./no-swallowed-rejection.ts";
import { rules as noUnvalidatedJsonDomainCastRules } from "./no-unvalidated-json-domain-cast.ts";
import { rules as suppressionHygieneRules } from "./suppression-hygiene.ts";

/**
 * Generic rules vendored from stella (Apache-2.0, see ./LICENSE), curated for
 * a deterministic Node CLI: path containment, JSON boundary validation,
 * promise hygiene, type-totality, and suppression hygiene.
 */
const stellaPlugin = eslintCompatPlugin({
	meta: { name: "stella" },
	rules: {
		...noAmbientNondeterminismRules,
		...noAsyncContextEnterWithRules,
		...noPartialRecordSatisfiesRules,
		...noPathPrefixContainmentRules,
		...noSwallowedRejectionRules,
		...noUnvalidatedJsonDomainCastRules,
		...suppressionHygieneRules,
	},
});

export default stellaPlugin;
