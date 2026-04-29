# Changelog

All notable changes to `bugstack-sdk` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
