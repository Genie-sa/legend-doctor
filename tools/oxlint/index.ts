import { eslintCompatPlugin } from "@oxlint/plugins";

import { noAmbientNondeterminismRule } from "./rules/no-ambient-nondeterminism.ts";
import { noAsyncContextEnterWithRule } from "./rules/no-async-context-enter-with.ts";
import { noBannedTypeAssertionsRule } from "./rules/no-banned-type-assertions.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noInOperatorRule } from "./rules/no-in-operator.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noPartialRecordSatisfiesRule } from "./rules/no-partial-record-satisfies.ts";
import { noPathPrefixContainmentRule } from "./rules/no-path-prefix-containment.ts";
import { noReexportOnlyModulesRule } from "./rules/no-reexport-only-modules.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noSwallowedRejectionRule } from "./rules/no-swallowed-rejection.ts";
import { noSwitchRule } from "./rules/no-switch.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noUnvalidatedJsonDomainCastRule } from "./rules/no-unvalidated-json-domain-cast.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";
import { noForeignDirectiveRule, requireDescriptionRule } from "./rules/suppression-hygiene.ts";

/**
 * House lint rules for legend-doctor. Every rule lives in ./rules with a
 * RuleTester suite beside it; run them with
 * `node --test tools/oxlint/rules/*.test.ts`.
 *
 * Provenance. The determinism, path-containment, JSON-boundary, promise-hygiene,
 * type-totality and suppression-hygiene rules are original implementations written
 * against our own test suite. The remaining rules are vendored, with local edits,
 * from dmmulroy/anti-slop under the MIT licence, whose notice follows.
 *
 *   Copyright (c) 2026 Dillon Mulroy
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */
const housePlugin = eslintCompatPlugin({
  meta: { name: "house" },
  rules: {
    "no-ambient-nondeterminism": noAmbientNondeterminismRule,
    "no-async-context-enter-with": noAsyncContextEnterWithRule,
    "no-banned-type-assertions": noBannedTypeAssertionsRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
    "no-foreign-directive": noForeignDirectiveRule,
    "no-in-operator": noInOperatorRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-module-mocking": noModuleMockingRule,
    "no-object-parameters": noObjectParametersRule,
    "no-partial-record-satisfies": noPartialRecordSatisfiesRule,
    "no-path-prefix-containment": noPathPrefixContainmentRule,
    "no-reexport-only-modules": noReexportOnlyModulesRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-reflect-get": noReflectGetRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
    "no-swallowed-rejection": noSwallowedRejectionRule,
    "no-switch": noSwitchRule,
    "no-unknown-parameters": noUnknownParametersRule,
    "no-unknown-returns": noUnknownReturnsRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-unvalidated-json-domain-cast": noUnvalidatedJsonDomainCastRule,
    "no-widen-then-assert": noWidenThenAssertRule,
    "require-description": requireDescriptionRule,
    "require-safety-comment-for-type-assertion": requireSafetyCommentForTypeAssertionRule,
  },
});

export default housePlugin;
