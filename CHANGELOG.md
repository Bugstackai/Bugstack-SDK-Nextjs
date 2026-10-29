# Changelog

All notable changes to `bugstack-sdk` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.2.2] — 2026-10-29

### Fixed
- **Errors reach bugstack without setting an endpoint.** The default
  endpoint was `http://localhost:3001/api/capture`, so an app that did not
  pass `endpoint` or set `BUGSTACK_ENDPOINT` reported nothing. It is now
  `https://dashboard.bugstack.ai/api/ingest/sdk`, the ingest endpoint, which accepts this SDK's payload and its
  `X-BugStack-API-Key` header. Source-map uploads derive
  `https://dashboard.bugstack.ai/api/ingest/sdk/api/sourcemaps/upload` from it. An explicit `endpoint` or
  `BUGSTACK_ENDPOINT` still wins.
- **The package's homepage is bugstack.ai.** npm listed the GitHub README
  as the homepage; it now links to https://bugstack.ai.

## [2.2.1] — 2026-04-30

### Fixed
- **`bugstack` CLI is now installed on the user's `PATH`.** In `2.2.0`,
  npm dropped the `bin[bugstack]` entry at publish time because the path
  was prefixed with `./`, so `npx bugstack sourcemaps upload` and global
  installs could not resolve the binary. Path normalized to
  `bin/bugstack.cjs`.

## [2.2.0] — 2026-04-29

### Added
- **Source-map upload pipeline for production builds.** Customers can now
  upload server-side source maps to bugstack so the orchestrator resolves
  bundled stack frames (`.next/server/chunks/8393.js:1:8734`) back to
  source-file positions (`app/api/orders/route.ts:42:5`) — turning the
  "Could not identify primary file" failure mode into auto-fixable
  errors. Two-step setup:
    1. Wrap your `next.config.js`:
       ```js
       const { withBugstack } = require('bugstack-sdk/next-config')
       module.exports = withBugstack({ /* your config */ })
       ```
       This enables `webpack.devtool = 'source-map'` for production
       server builds, preserving any existing webpack hook.
    2. Append to your `build` script:
       ```json
       "build": "next build && bugstack sourcemaps upload"
       ```
       The CLI walks `.next/server/**/*.map`, uploads each with the
       active release identifier, and never fails the build.
- New `bugstack` CLI binary (registered via `bin`) — `bugstack sourcemaps
  upload [--api-key X] [--release Y] [--endpoint Z] [--server-dir D]
  [--concurrency N] [--max-bytes N] [--quiet]`. Auto-detects release from
  `BUGSTACK_RELEASE`, `RENDER_GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`,
  `GITHUB_SHA`, or `git rev-parse HEAD` in that order.
- New programmatic API: `import { uploadSourceMaps } from 'bugstack-sdk/build'`
  for callers who want to invoke the uploader from a custom Node script
  rather than via the CLI.
- New entry: `bugstack-sdk/next-config` exports `withBugstack(config,
  options?)` — the Next.js config wrapper. Idempotent and pass-through
  when `emitServerSourceMaps: false`.

### Internal
- New tsup entries for `src/build/upload`, `src/build/cli`, and
  `src/next-config`. Bin stub at `bin/bugstack.cjs` requires the built
  CLI so the shebang concern stays in checked-in JavaScript and out of
  the bundler's hands.

## [2.1.0] — 2026-04-29

### Added
- **Chunk-load error telemetry.** `ChunkLoadError` and the related family
  (`Loading chunk N failed`, `Loading CSS chunk N failed`,
  `Failed to fetch dynamically imported module`,
  `Importing a module script failed`) are now detected and routed to a
  lightweight telemetry endpoint instead of the main fix pipeline. They
  aren't real bugs (stale-tab artifacts after a redeploy) and have no
  source frames the orchestrator could fix, so they were wasting LLM
  cycles when they hit `/api/capture`. The new path lets the dashboard
  render a deploy-health spike detector while keeping the noise out of
  the bug feed.
- New config option `dropChunkErrors` (default `false`) — set to `true`
  to disable telemetry forwarding entirely and silently discard chunk
  errors instead.
- New config option `chunkErrorsEndpoint` (default auto-derived from the
  main `endpoint` — `/api/capture` becomes `/api/chunk-errors`). Override
  if your error service splits telemetry across hosts.
- New exported helper `isChunkLoadError(error)` so callers can reuse the
  same detection logic in their own browser-side error boundaries (e.g.
  to soft-reload the page on first occurrence).

### Fixed
- The wire header `X-BugStack-SDK-Version` reported `0.2.0` since pre-2.0,
  regardless of the actual installed version. Now injected at build time
  from `package.json` via `tsup`'s `define`, so it stays in sync on every
  release.

### Changed
- Default behavior of `reportError` for chunk-load errors is now route-to-
  telemetry. Previously these went into the main capture pipeline (where
  they'd create unfixable rows the orchestrator would burn cycles on).
  This is a soft behavior change: customer code is unaffected, but the
  destination endpoint differs. Hosted customers (api.bugstack.ai) get
  the new endpoint automatically; self-hosted error-service deployments
  should pull the matching error-service release for the
  `/api/chunk-errors` ingest route.

## [2.0.2] — 2026-02-27

Previous published baseline.
