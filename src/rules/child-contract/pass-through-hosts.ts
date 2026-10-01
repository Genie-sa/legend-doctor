import ts from "typescript";

/**
 * React Native primitives that render their children inside a native view without reading or
 * cloning them. `TouchableWithoutFeedback`, `TouchableHighlight`, and `TouchableNativeFeedback`
 * clone their only child, so they are deliberately absent.
 */
const NATIVE_PASS_THROUGH_HOSTS = new Set([
  "ImageBackground",
  "KeyboardAvoidingView",
  "Modal",
  "Pressable",
  "SafeAreaView",
  "ScrollView",
  "Text",
  "TouchableOpacity",
  "View",
]);

/** React Native, its web build, and Legend's reactive `$`-prefixed builds of the same primitives. */
const NATIVE_HOST_MODULES = new Set([
  "@legendapp/state/react-native",
  "react-native",
  "react-native-web",
]);

const LEGEND_WEB_MODULE = "@legendapp/state/react-web";

const LEGEND_WEB_NAMESPACE = "$React";

const NAMESPACE_IMPORT = "*";

interface ImportBinding {
  readonly exportedName: string;
  readonly moduleName: string;
}

/**
 * Whether the element renders a host that passes its children through untouched: an intrinsic
 * element, a React Native pass-through primitive imported by the file that renders it, or a Legend
 * `$React` intrinsic.
 */
export function rendersPassThroughHost(element: ts.JsxOpeningLikeElement): boolean {
  const tag = element.tagName.getText();
  const [root = tag, member, ...nested] = tag.split(".");
  if (member === undefined && /^[a-z]/u.test(tag)) {
    return true;
  }
  const binding = nested.length === 0 ? importBinding(element.getSourceFile(), root) : null;
  return binding !== null && bindingIsPassThroughHost(binding, member);
}

function bindingIsPassThroughHost(
  { exportedName, moduleName }: ImportBinding,
  member: string | undefined,
): boolean {
  if (moduleName === LEGEND_WEB_MODULE) {
    return exportedName === LEGEND_WEB_NAMESPACE && /^[a-z]/u.test(member ?? "");
  }
  const primitive = member ?? exportedName;
  return (
    NATIVE_HOST_MODULES.has(moduleName) &&
    (member === undefined) === (exportedName !== NAMESPACE_IMPORT) &&
    NATIVE_PASS_THROUGH_HOSTS.has(primitive.replace(/^\$/u, ""))
  );
}

function importBinding(sourceFile: ts.SourceFile, localName: string): ImportBinding | null {
  for (const statement of sourceFile.statements) {
    const binding = ts.isImportDeclaration(statement)
      ? declarationBinding(statement, localName)
      : null;
    if (binding) {
      return binding;
    }
  }
  return null;
}

function declarationBinding(
  declaration: ts.ImportDeclaration,
  localName: string,
): ImportBinding | null {
  const clause = declaration.importClause;
  const exportedName =
    clause && !clause.isTypeOnly ? importedName(clause.namedBindings, localName) : null;
  return exportedName && ts.isStringLiteral(declaration.moduleSpecifier)
    ? { exportedName, moduleName: declaration.moduleSpecifier.text }
    : null;
}

function importedName(
  bindings: ts.NamedImportBindings | undefined,
  localName: string,
): string | null {
  if (bindings && ts.isNamespaceImport(bindings)) {
    return bindings.name.text === localName ? NAMESPACE_IMPORT : null;
  }
  const element = bindings?.elements.find(
    (candidate) => !candidate.isTypeOnly && candidate.name.text === localName,
  );
  return element ? (element.propertyName ?? element.name).text : null;
}
