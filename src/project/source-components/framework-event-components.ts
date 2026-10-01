import type { ModuleRecordDraft, StyledComponentCandidate } from "./model.js";
import ts from "typescript";

/** `styled.input` renders the host element its lowercase member names. */
const INTRINSIC_TAG = /^[a-z]/u;

type StyledTarget = Pick<StyledComponentCandidate, "factory" | "intrinsic" | "targetRoot">;

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

export function styledComponentTarget(initializer: ts.Expression): StyledTarget | null {
  if (!ts.isTaggedTemplateExpression(initializer)) {
    return null;
  }
  const { tag } = initializer;
  if (ts.isPropertyAccessExpression(tag)) {
    return intrinsicStyledTarget(tag);
  }
  return ts.isCallExpression(tag) ? wrappedStyledTarget(tag) : null;
}

function intrinsicStyledTarget(tag: ts.PropertyAccessExpression): StyledTarget | null {
  return ts.isIdentifier(tag.expression) && INTRINSIC_TAG.test(tag.name.text)
    ? { factory: tag.expression.text, intrinsic: true, targetRoot: tag.name.text }
    : null;
}

function wrappedStyledTarget(tag: ts.CallExpression): StyledTarget | null {
  if (!ts.isIdentifier(tag.expression) || tag.arguments.length !== 1) {
    return null;
  }
  const [target] = tag.arguments;
  if (!target) {
    return null;
  }
  const root = styledTargetRoot(target);
  return ts.isIdentifier(root)
    ? { factory: tag.expression.text, intrinsic: false, targetRoot: root.text }
    : null;
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
  const components = styledComponentSet(draft, candidate);
  if (!components) {
    return;
  }
  components.add(candidate.name);
  if (candidate.exported) {
    draft.localExports.set(candidate.name, candidate.name);
  }
}

function styledComponentSet(
  draft: ModuleRecordDraft,
  { intrinsic, targetRoot }: StyledComponentCandidate,
): Set<string> | null {
  if (intrinsic) {
    return draft.hostElementComponents;
  }
  const binding = draft.imports.get(targetRoot);
  const provenTarget = binding
    ? isFrameworkEventModuleSpecifier(binding.moduleSpecifier)
    : draft.frameworkEventComponents.has(targetRoot);
  return provenTarget ? draft.frameworkEventComponents : null;
}
