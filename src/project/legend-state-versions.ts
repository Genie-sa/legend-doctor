import type { InstalledLegendState } from "../core/types.js";

const PRERELEASE_VERSION = /^3\.0\.0-(?<channel>alpha|beta)\.(?<build>\d+)$/u;
const MAJOR_VERSION = /^(?<major>\d+)\./u;

const FIRST_V3_MAJOR = 3;
/** `3.0.0-beta.35` is the first release whose react entry point exports `useValue`. */
const FIRST_USE_VALUE_BETA = 35;
/** The newest release whose exports were verified; later ones stay unknown until checked. */
const LAST_VERIFIED_BETA = 48;

/**
 * Exports of a published `@legendapp/state` version known only from a lockfile. Every published
 * release was checked: 2.x has neither `useValue` nor `./sync`; every 3.0.0 prerelease has `./sync`;
 * `useValue` arrives in beta.35 as an alias of `useSelector` and stays one through beta.48.
 */
export function lockedLegendState(version: string): InstalledLegendState {
  const exports = publishedExports(version);
  return { ...exports, source: "lockfile", version };
}

function majorVersion(version: string): number {
  return Number(MAJOR_VERSION.exec(version)?.groups?.["major"] ?? Number.NaN);
}

function publishedExports(
  version: string,
): Pick<InstalledLegendState, "syncExport" | "useValueExport"> {
  const major = majorVersion(version);
  if (major < FIRST_V3_MAJOR) {
    return { syncExport: "missing", useValueExport: "missing" };
  }
  const prerelease = PRERELEASE_VERSION.exec(version)?.groups;
  const build = Number(prerelease?.["build"] ?? Number.NaN);
  if (!prerelease || (prerelease["channel"] === "beta" && build > LAST_VERIFIED_BETA)) {
    return { syncExport: "unknown", useValueExport: "unknown" };
  }
  const hasUseValue = prerelease["channel"] === "beta" && build >= FIRST_USE_VALUE_BETA;
  return { syncExport: "available", useValueExport: hasUseValue ? "alias" : "missing" };
}
