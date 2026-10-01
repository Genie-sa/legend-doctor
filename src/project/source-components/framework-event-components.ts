import type { ModuleRecordDraft, StyledComponentCandidate } from "./model.js";
import ts from "typescript";

export function isFrameworkEventModuleSpecifier(specifier: string): boolean {
  return (
    specifier === "react-native" ||
    specifier === "react-native-web" ||
    specifier === "@radix-ui/react-dropdown-menu" ||
    specifier === "@radix-ui/react-switch" ||
    specifier === "@base-ui/react" ||
    specifier.startsWith("@base-ui/react/")
  );
}

export function styledComponentTarget(
  initializer: ts.Expression,
): { factory: string; targetRoot: string } | null {
  if (!ts.isTaggedTemplateExpression(initializer)) {
    return null;
  }
  const { tag } = initializer;
  if (!ts.isCallExpression(tag) || !ts.isIdentifier(tag.expression) || tag.arguments.length !== 1) {
    return null;
  }
  const [target] = tag.arguments;
  if (!target) {
    return null;
  }
  const root = styledTargetRoot(target);
  return ts.isIdentifier(root) ? { factory: tag.expression.text, targetRoot: root.text } : null;
}

function styledTargetRoot(target: ts.Expression): ts.Expression {
  let root = target;
  while (ts.isPropertyAccessExpression(root)) {
    root = root.expression;
  }
  return root;
}

export function applyStyledComponentCandidates(
  draft: ModuleRecordDraft,
  styledFactories: ReadonlySet<string>,
): void {
  for (const candidate of draft.styledComponentCandidates) {
    applyStyledComponentCandidate(draft, styledFactories, candidate);
  }
}

function applyStyledComponentCandidate(
  draft: ModuleRecordDraft,
  styledFactories: ReadonlySet<string>,
  candidate: StyledComponentCandidate,
): void {
  if (
    !styledFactories.has(candidate.factory) ||
    draft.shadowedImports.has(candidate.factory) ||
    draft.shadowedImports.has(candidate.targetRoot)
  ) {
    return;
  }
  const binding = draft.imports.get(candidate.targetRoot);
  const provenTarget = binding
    ? isFrameworkEventModuleSpecifier(binding.moduleSpecifier)
    : draft.frameworkEventComponents.has(candidate.targetRoot);
  if (!provenTarget) {
    return;
  }
  draft.frameworkEventComponents.add(candidate.name);
  if (candidate.exported) {
    draft.localExports.set(candidate.name, candidate.name);
  }
}
