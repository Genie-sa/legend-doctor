import type { HookPresentationConsumer, HookReturnMembers } from "../child-contract/model.js";
import {
  subscriptionSites,
  subscriptionSitesAreMaterial,
} from "../../analysis/verdicts/site-subscription-verdict.js";
import { EMPTY_NODES } from "../../analysis/constants.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import type { StateCandidate } from "../../analysis/model.js";
import type { SubscriptionSites } from "../../analysis/verdicts/site-subscription-verdict.js";
import { collectHookImports } from "../../core/imports.js";
import { collectPureProjectionImports } from "../../analysis/owner-scan.js";
import { collectReactCommitContext } from "../react-commit-sensitivity/react-commit-sensitivity.js";
import { collectStateUsage } from "../../analysis/state-usage.js";
import { consumerBindingName } from "./consumer-binding.js";
import { findAncestor } from "../../core/ast.js";
import { isRuntimeOwner } from "../hook-keyed-cursor-contract/binding-references.js";
import { jsxElementCount } from "../state-proofs/jsx-subtrees.js";
import { runtimeFunctionName } from "../../analysis/ast-helpers.js";
import ts from "typescript";

interface PresentationBinding {
  readonly owner: RuntimeFunctionLike;
  readonly valueName: string;
}

interface PresentationConsumerQuery {
  readonly call: ts.CallExpression;
  readonly members: HookReturnMembers;
  readonly scope: {
    readonly broadOwnerJsx: number;
    readonly pureProjectionImports: ReadonlySet<string>;
  };
  readonly sourceFile: ts.SourceFile;
}

export function presentationConsumerFor(
  query: PresentationConsumerQuery,
): HookPresentationConsumer | "unsafe" {
  const binding = presentationBinding(query);
  if (!binding) {
    return "unsafe";
  }
  const sites = presentationSites(query, binding);
  const consumerName = runtimeFunctionName(binding.owner);
  return sites && consumerName ? presentationConsumer(consumerName, sites) : "unsafe";
}

function presentationConsumer(
  consumerName: string,
  sites: SubscriptionSites,
): HookPresentationConsumer {
  return {
    consumerNames: [consumerName],
    derivedBindings: sites.derivedBindings,
    renderSites: sites.sites.length,
  };
}

function presentationBinding({
  call,
  members,
  scope,
}: PresentationConsumerQuery): PresentationBinding | null {
  const owner = findAncestor(call, isRuntimeOwner);
  const declaration = call.parent;
  if (
    !owner ||
    members.setter !== null ||
    jsxElementCount(owner) < scope.broadOwnerJsx ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== call ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  const valueName = consumerBindingName(declaration.name, members.value);
  return valueName === null || valueName === "unsupported" ? null : { owner, valueName };
}

function presentationSites(
  { call, scope, sourceFile }: PresentationConsumerQuery,
  { owner, valueName }: PresentationBinding,
): SubscriptionSites | null {
  const imports = collectHookImports(sourceFile);
  const reactCommit = collectReactCommitContext(sourceFile, imports);
  const state: StateCandidate = { call, owner, setterName: null, valueName };
  const usage = collectStateUsage(state, {
    effectNodes: reactCommit.lifecycleRegions,
    imports,
    persistenceSinks: EMPTY_NODES,
  });
  if (!presentationUsageIsSafe(owner, usage, reactCommit.sensitiveOwners)) {
    return null;
  }
  const sites = subscriptionSites(usage, {
    allowUnresolvedComponentCallSite: true,
    childContracts: null,
    hostTags: imports,
    pureProjectionImports: new Set([
      ...collectPureProjectionImports(sourceFile),
      ...scope.pureProjectionImports,
    ]),
    state,
  });
  return sites?.sites.length && subscriptionSitesAreMaterial(sites.sites, state) ? sites : null;
}

function presentationUsageIsSafe(
  owner: RuntimeFunctionLike,
  usage: ReturnType<typeof collectStateUsage>,
  sensitiveOwners: ReadonlySet<RuntimeFunctionLike>,
): boolean {
  return (
    !sensitiveOwners.has(owner) &&
    usage.localRenderReads + usage.transportedOccurrences > 0 &&
    usage.localRenderReads === usage.directRenderNodes.length &&
    usage.effectReads === 0 &&
    usage.effectWrites === 0 &&
    usage.deferredReads === 0 &&
    usage.setterReferences === 0 &&
    !usage.escaped &&
    !usage.repeatedTransport &&
    !usage.shadowed &&
    !usage.unstableTransport
  );
}
