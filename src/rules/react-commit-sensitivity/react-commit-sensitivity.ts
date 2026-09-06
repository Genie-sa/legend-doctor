import { directTransitionContext, isTransitionReference } from "./direct-transitions.js";
import { findAncestor, isRuntimeFunctionLike, visit } from "../../core/ast.js";
import {
  hasNoDependencyArray,
  isReactEffectCall,
  resolveLifecycleCallback,
} from "./effect-lifecycle.js";
import type { HookImports } from "../../core/imports.js";
import type { RuntimeFunctionLike } from "../../core/ast.js";
import { isImportedReactCall } from "./binding-resolution.js";
import { refIdentityMayChange } from "./ref-identity.js";
import ts from "typescript";

export interface ReactCommitContext {
  directTransitionCallbacks: ReadonlyMap<RuntimeFunctionLike, readonly RuntimeFunctionLike[]>;
  eventTransitionCallbacks: ReadonlyMap<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
  effectCalls: readonly ts.CallExpression[];
  lifecycleRegions: ReadonlySet<ts.Node>;
  sensitiveOwners: ReadonlySet<RuntimeFunctionLike>;
}

interface CommitScan {
  readonly effectCalls: ts.CallExpression[];
  readonly lifecycleRegions: Set<ts.Node>;
  readonly nonTransitionSensitiveOwners: Set<RuntimeFunctionLike>;
  readonly sensitiveOwners: Set<RuntimeFunctionLike>;
  readonly transitionOwners: Set<RuntimeFunctionLike>;
}

interface TransitionCallbackMaps {
  readonly direct: Map<RuntimeFunctionLike, readonly RuntimeFunctionLike[]>;
  readonly event: Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>;
}

export function collectReactCommitContext(
  sourceFile: ts.SourceFile,
  imports: HookImports,
): ReactCommitContext {
  const scan: CommitScan = {
    effectCalls: [],
    lifecycleRegions: new Set(),
    nonTransitionSensitiveOwners: new Set(),
    sensitiveOwners: new Set(),
    transitionOwners: new Set(),
  };
  visit(sourceFile, (node) => {
    collectCommitNode(node, scan, imports);
  });
  const transitions = transitionCallbackMaps(scan, imports);
  return {
    directTransitionCallbacks: transitions.direct,
    effectCalls: scan.effectCalls,
    eventTransitionCallbacks: transitions.event,
    lifecycleRegions: scan.lifecycleRegions,
    sensitiveOwners: scan.sensitiveOwners,
  };
}

function collectCommitNode(node: ts.Node, scan: CommitScan, imports: HookImports): void {
  if (ts.isJsxAttribute(node) && node.name.getText() === "ref") {
    collectRefAttribute(node, scan, imports);
    return;
  }
  if (ts.isCallExpression(node) && isReactEffectCall(node, imports)) {
    collectEffectCall(node, scan, imports);
    return;
  }
  if (isTransitionReference(node, imports)) {
    markRuntimeAncestors(node, scan.sensitiveOwners);
    markRuntimeAncestors(node, scan.transitionOwners);
  }
}

function markCommitSensitive(node: ts.Node, scan: CommitScan): void {
  markRuntimeAncestors(node, scan.sensitiveOwners);
  markRuntimeAncestors(node, scan.nonTransitionSensitiveOwners);
}

function collectRefAttribute(node: ts.JsxAttribute, scan: CommitScan, imports: HookImports): void {
  const expression =
    node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : null;
  const owner = expression ? findAncestor(node, isRuntimeFunctionLike) : null;
  if (expression && owner && refIdentityMayChange(expression, owner, imports)) {
    markCommitSensitive(node, scan);
  }
}

function collectEffectCall(node: ts.CallExpression, scan: CommitScan, imports: HookImports): void {
  scan.lifecycleRegions.add(node);
  const owner = findAncestor(node, isRuntimeFunctionLike);
  const callback =
    owner && node.arguments[0]
      ? resolveLifecycleCallback(node.arguments[0], { imports, owner, seen: new Set() })
      : null;
  if (callback) {
    scan.lifecycleRegions.add(callback);
  }
  if (isImportedReactCall(node, imports, "useEffect")) {
    scan.effectCalls.push(node);
  }
  if (hasNoDependencyArray(node)) {
    markCommitSensitive(node, scan);
  }
}

function transitionCallbackMaps(scan: CommitScan, imports: HookImports): TransitionCallbackMaps {
  const direct = new Map<RuntimeFunctionLike, readonly RuntimeFunctionLike[]>();
  const event = new Map<RuntimeFunctionLike, ReadonlySet<RuntimeFunctionLike>>();
  for (const owner of scan.transitionOwners) {
    if (scan.nonTransitionSensitiveOwners.has(owner)) {
      continue;
    }
    const transitions = directTransitionContext(owner, imports);
    if (transitions) {
      direct.set(owner, transitions.callbacks);
      event.set(owner, transitions.eventCallbacks);
    }
  }
  return { direct, event };
}

function markRuntimeAncestors(node: ts.Node, owners: Set<RuntimeFunctionLike>): void {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current)) {
      owners.add(current);
    }
  }
}
