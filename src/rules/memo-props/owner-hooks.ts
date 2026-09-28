import { lexicalBinding } from "../../core/lexical-bindings.js";
import ts from "typescript";
import { unwrapTransparentExpression } from "../../core/analysis-ast.js";

/** Hooks whose results this rule can reason about, keyed by the export a call resolves to. */
export type OwnerHook =
  | "use"
  | "useCallback"
  | "useContext"
  | "useId"
  | "useMemo"
  | "useObservable"
  | "useReducer"
  | "useRef"
  | "useState"
  | "useTransition"
  | "useValue";

const REACT_HOOKS: ReadonlyMap<string, OwnerHook> = new Map<string, OwnerHook>([
  ["use", "use"],
  ["useCallback", "useCallback"],
  ["useContext", "useContext"],
  ["useId", "useId"],
  ["useMemo", "useMemo"],
  ["useReducer", "useReducer"],
  ["useRef", "useRef"],
  ["useState", "useState"],
  ["useTransition", "useTransition"],
]);

const LEGEND_HOOKS: ReadonlyMap<string, OwnerHook> = new Map<string, OwnerHook>([
  ["use$", "useValue"],
  ["useLocalObservable", "useObservable"],
  ["useObservable", "useObservable"],
  ["useSelector", "useValue"],
  ["useValue", "useValue"],
]);

const HOOKS_BY_MODULE: ReadonlyMap<string, ReadonlyMap<string, OwnerHook>> = new Map([
  ["react", REACT_HOOKS],
  ["@legendapp/state/react", LEGEND_HOOKS],
]);

/** The React or Legend State hook a call resolves to through its import, or null. */
export function ownerHookName(call: ts.CallExpression): OwnerHook | null {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const binding = lexicalBinding(callee);
    return binding?.kind === "import"
      ? (HOOKS_BY_MODULE.get(binding.moduleSpecifier)?.get(binding.importedName) ?? null)
      : null;
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) {
    return null;
  }
  const namespace = lexicalBinding(callee.expression);
  return namespace?.kind === "import" &&
    (namespace.importedName === "*" || namespace.importedName === "default")
    ? (HOOKS_BY_MODULE.get(namespace.moduleSpecifier)?.get(callee.name.text) ?? null)
    : null;
}
