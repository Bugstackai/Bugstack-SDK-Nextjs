/**
 * Single source of truth for the SDK's wire version.
 *
 * `__BUGSTACK_SDK_VERSION__` is replaced at build time by tsup's `define`
 * (see tsup.config.ts) with the literal `package.json#version`. The fallback
 * `"0.0.0-dev"` is only reachable when the package is consumed unbuilt
 * (e.g. ts-node against src/) — not a path we publish, but it keeps dev
 * ergonomics sane and avoids a hard ReferenceError.
 *
 * Every adapter and client pulls SDK_VERSION from here so a release bump
 * propagates atomically without hand-edits across files.
 */
declare const __BUGSTACK_SDK_VERSION__: string;

export const SDK_VERSION: string =
  typeof __BUGSTACK_SDK_VERSION__ !== "undefined" ? __BUGSTACK_SDK_VERSION__ : "0.0.0-dev";
