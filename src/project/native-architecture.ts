import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const NATIVE_PLATFORMS = ["android", "ios", "macos", "windows"] as const;
const EXPO_MANAGED_PLATFORMS: readonly NativePlatform[] = ["android", "ios"];
const EXPO_CONFIG_SCRIPTS = [
  "app.config.cjs",
  "app.config.js",
  "app.config.json",
  "app.config.mjs",
  "app.config.ts",
];
const APP_DELEGATE = /^AppDelegate\.(?:mm?|swift)$/u;
const APP_PROJECT_ENTRY = {
  android: /^settings\.gradle(?:\.kts)?$/u,
  ios: /^Podfile$/u,
  macos: /^Podfile$/u,
  windows: /\.sln$/u,
} as const satisfies Readonly<Record<NativePlatform, RegExp>>;
/** `newArchEnabled` in an app config, gradle.properties, or Podfile.properties.json. */
const NEW_ARCH_FLAG = /\bnewArchEnabled['"]?\s*[:=]\s*['"]?(?<enabled>true|false)\b/u;
/** An assignment, not a comparison: `ENV['RCT_NEW_ARCH_ENABLED'] = '1'`. */
const PODFILE_NEW_ARCH_ASSIGNMENT =
  /ENV\[\s*['"]RCT_NEW_ARCH_ENABLED['"]\s*\]\s*=(?!=)\s*['"]?(?<value>[01])['"]?/u;
const APP_DELEGATE_LEGACY_OVERRIDE =
  /newArchEnabled\s*(?:\(\)\s*->\s*Bool\s*)?\{\s*return\s+(?:NO|false)\b/u;

type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

export interface HostOptions {
  /** Expo SDK 53 and 54 enable the New Architecture unless the app config turns it off. */
  readonly expoDefaultsToNewArchitecture: boolean;
}

/**
 * Whether the app host in `directory` runs the New Architecture on every platform it builds, or null when the
 * directory holds no native project or Expo app config. Only explicit configuration or a documented default counts.
 */
export async function hostRunsNewArchitecture(
  directory: string,
  options: HostOptions,
): Promise<boolean | null> {
  const platforms = await nativePlatforms(directory);
  const expoConfig = await readExpoConfig(directory);
  if (platforms.length === 0 && expoConfig === null) {
    return null;
  }
  const managed =
    expoConfig !== null && EXPO_MANAGED_PLATFORMS.some((platform) => !platforms.includes(platform));
  const verdicts = await Promise.all(
    platforms.map((platform) => platformRunsNewArchitecture(directory, platform)),
  );
  return (
    verdicts.every(Boolean) && (!managed || managedRunsNewArchitecture(expoConfig ?? "", options))
  );
}

function managedRunsNewArchitecture(expoConfig: string, options: HostOptions): boolean {
  const flag = NEW_ARCH_FLAG.exec(expoConfig)?.groups?.["enabled"];
  return flag === undefined ? options.expoDefaultsToNewArchitecture : flag === "true";
}

async function platformRunsNewArchitecture(
  directory: string,
  platform: NativePlatform,
): Promise<boolean> {
  const platformDirectory = path.join(directory, platform);
  if (platform === "android") {
    const properties = await readText(path.join(platformDirectory, "gradle.properties"));
    return NEW_ARCH_FLAG.exec(properties ?? "")?.groups?.["enabled"] === "true";
  }
  return platform !== "windows" && applePlatformRunsNewArchitecture(platformDirectory);
}

/** CocoaPods settings must enable it, and no app delegate may switch it back off. */
async function applePlatformRunsNewArchitecture(platformDirectory: string): Promise<boolean> {
  const [podfile, podProperties, delegates] = await Promise.all([
    readText(path.join(platformDirectory, "Podfile")),
    readText(path.join(platformDirectory, "Podfile.properties.json")),
    appDelegateSources(platformDirectory),
  ]);
  if (delegates.some((source) => APP_DELEGATE_LEGACY_OVERRIDE.test(source))) {
    return false;
  }
  const propertiesFlag = NEW_ARCH_FLAG.exec(podProperties ?? "")?.groups?.["enabled"];
  const podfileValue = PODFILE_NEW_ARCH_ASSIGNMENT.exec(podfile ?? "")?.groups?.["value"];
  const settings = new Set([
    propertiesFlag === undefined ? null : propertiesFlag === "true",
    podfileValue === undefined ? null : podfileValue === "1",
  ]);
  return settings.has(true) && !settings.has(false);
}

/** Native module packages ship platform sources too; only an app project has a build entry point. */
async function nativePlatforms(directory: string): Promise<NativePlatform[]> {
  const projects = await Promise.all(
    NATIVE_PLATFORMS.map(async (platform) => {
      const entries = await readdir(path.join(directory, platform)).catch(() => []);
      return entries.some((name) => APP_PROJECT_ENTRY[platform].test(name)) ? [platform] : [];
    }),
  );
  return projects.flat();
}

/** App delegates sit in the platform directory or one target directory below it. */
async function appDelegateSources(platformDirectory: string): Promise<string[]> {
  const entries = await readdir(platformDirectory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  const delegates = entries.filter(
    (entry) =>
      entry.isFile() &&
      APP_DELEGATE.test(entry.name) &&
      path.relative(platformDirectory, entry.parentPath).split(path.sep).length <= 1,
  );
  const sources = await Promise.all(
    delegates.map((entry) => readText(path.join(entry.parentPath, entry.name))),
  );
  return sources.filter((source) => source !== null);
}

/** An app.json counts only with an `expo` key; any app.config script is an Expo config. */
async function readExpoConfig(directory: string): Promise<string | null> {
  const appJson = await readText(path.join(directory, "app.json"));
  if (appJson !== null && hasExpoKey(appJson)) {
    return appJson;
  }
  const scripts = await Promise.all(
    EXPO_CONFIG_SCRIPTS.map((name) => readText(path.join(directory, name))),
  );
  return scripts.find((script) => script !== null) ?? null;
}

function hasExpoKey(appJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(appJson);
    return parsed instanceof Object && Object.hasOwn(parsed, "expo");
  } catch {
    // A malformed app.json configures nothing.
    return false;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    // A missing file declares no configuration.
    return null;
  }
}
