import type { DerivedMemo, ObservableMemoInput } from "./derived-memos.js";
import type { HookImports } from "../../core/imports.js";
import type { LegendPracticeFinding } from "../../core/types.js";
import { derivedMemoDeclaration } from "./derived-memos.js";
import { isProvablyPrimitive } from "./primitive-results.js";
import ts from "typescript";
import { visit } from "../../core/ast.js";

export interface DerivedUseValueScan {
  readonly fileName: string;
  readonly imports: HookImports;
  readonly observableBindings: ReadonlySet<string>;
  readonly sourceFile: ts.SourceFile;
}

export function findDerivedUseValuePractices(scan: DerivedUseValueScan): LegendPracticeFinding[] {
  if (scan.imports.useMemo.size === 0 && scan.imports.reactNamespaces.size === 0) {
    return [];
  }
  const findings: LegendPracticeFinding[] = [];
  visit(scan.sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node)) {
      return;
    }
    const memo = derivedMemoDeclaration(node, scan);
    if (memo && returnsOnlyPrimitives(memo)) {
      findings.push(derivedObservableFinding(memo, scan));
    }
  });
  return findings;
}

function returnsOnlyPrimitives(memo: DerivedMemo): boolean {
  const scope = { callback: memo.callback, owner: memo.owner };
  return memo.results.every((result) => isProvablyPrimitive(result, scope));
}

function derivedObservableFinding(
  memo: DerivedMemo,
  scan: DerivedUseValueScan,
): LegendPracticeFinding {
  const { sourceFile } = scan;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    memo.call.getStart(sourceFile),
  );
  const name = memo.derivedName;
  const dependencyList = memo.inputs.map((input) => input.localName).join(", ");
  const subscriptions = joinNames(
    memo.inputs.map((input) => `\`useValue(${input.observable.getText(sourceFile)})\``),
  );
  const substitutions = joinNames(
    memo.inputs.map(
      (input) => `\`${input.observable.getText(sourceFile)}.get()\` for \`${input.localName}\``,
    ),
  );
  return {
    action: "derive-computed-observable",
    confidence: "certain",
    disposition: "change",
    evidence: [
      inputEvidence(memo.inputs, sourceFile),
      "every memo dependency is one of those subscriptions, so a computed observable tracks exactly the declared inputs",
      "the memo returns only primitive expressions, so an unchanged result skips the rerender useMemo could not",
    ],
    location: { column: character + 1, file: scan.fileName, line: line + 1 },
    message:
      `Replace \`const ${name} = useMemo(…, [${dependencyList}])\` and the ${subscriptions} ` +
      `subscription${memo.inputs.length === 1 ? "" : "s"} it depends on with ` +
      `\`const ${name}$ = useObservable(() => …)\` reading ${substitutions}, then ` +
      `\`const ${name} = useValue(${name}$)\`; the computed reruns only when those observables ` +
      "change and the component rerenders only when the primitive result changes.",
    practice: "reactivity",
  };
}

function inputEvidence(inputs: readonly ObservableMemoInput[], sourceFile: ts.SourceFile): string {
  const names = joinNames(inputs.map((input) => `\`${input.localName}\``));
  const paths = joinNames(inputs.map((input) => `\`${input.observable.getText(sourceFile)}\``));
  return inputs.length === 1
    ? `${names} is a useValue subscription to the proven observable path ${paths} and is read only inside this memo`
    : `${names} are useValue subscriptions to the proven observable paths ${paths} and each is read only inside this memo`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
