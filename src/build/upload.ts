/**
 * Build-time source map uploader.
 *
 * Walks a directory of compiled output looking for `.map` files and POSTs
 * each one to the bugstack source-map ingest endpoint. The companion
 * `bugstack-sdk/next-config` wrapper enables emission of these maps for
 * Next.js server bundles; once uploaded, the orchestrator can resolve
 * production stack frames like ".next/server/chunks/8393.js:1:8734" back
 * to source-file positions ("app/api/orders/route.ts:42:5") and actually
 * generate fixes for bundled errors.
 *
 * This module is import-safe in any Node 18+ environment. It uses no
 * runtime dependencies — `node:fs/promises` + global `fetch`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { execSync } from "node:child_process";

export interface UploadSourceMapsOptions {
  /**
   * Project SDK key. Required. Reads BUGSTACK_PROJECT_API_KEY or
   * BUGSTACK_API_KEY when not supplied explicitly.
   */
  apiKey?: string;

  /**
   * Base URL of the bugstack ingest service. Reads BUGSTACK_ENDPOINT or
   * derives from ERROR_SERVICE_URL when not supplied. The uploader appends
   * `/api/sourcemaps/upload` to whatever base it gets.
   */
  endpoint?: string;

  /**
   * Release identifier (typically a commit SHA). Lets multiple deploys
   * coexist in the source-map table so old errors still resolve against
   * old maps. Auto-detected in this order:
   *   1. BUGSTACK_RELEASE
   *   2. RENDER_GIT_COMMIT
   *   3. VERCEL_GIT_COMMIT_SHA
   *   4. GITHUB_SHA
   *   5. `git rev-parse HEAD` (when a git checkout is present)
   */
  release?: string | null;

  /**
   * Directory to walk for `.map` files. Defaults to `.next/server`.
   * Override for non-Next projects (e.g. `dist` for tsc, `build` for CRA).
   */
  serverDir?: string;

  /**
   * Max concurrent uploads. Higher means faster builds, more pressure on
   * the ingest endpoint. Default 6 — tuned for Render's typical bandwidth.
   */
  concurrency?: number;

  /**
   * Per-file size cap in bytes. Maps larger than this are skipped with a
   * warning rather than failing. Default 8 MiB — covers typical
   * `.next/server/chunks/*.js.map` outputs comfortably.
   */
  maxBytes?: number;

  /**
   * Logger. Defaults to console. Pass a no-op logger to silence the
   * "[bugstack] …" lines in scripted environments.
   */
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface UploadResult {
  uploaded: number;
  skipped: number;
  failed: number;
  totalBytes: number;
  elapsedMs: number;
  failures: Array<{ bundleFile: string; error: string }>;
}

const DEFAULT_SERVER_DIR = ".next/server";
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ENDPOINT_PATH = "/api/sourcemaps/upload";

function resolveRelease(explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit;
  const fromEnv =
    process.env.BUGSTACK_RELEASE ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function resolveEndpoint(explicit?: string): string | null {
  const base =
    explicit ||
    process.env.BUGSTACK_ENDPOINT ||
    (process.env.ERROR_SERVICE_URL ? process.env.ERROR_SERVICE_URL : null);
  if (!base) return null;
  // Strip trailing slashes + any trailing /api/capture or /capture so the
  // same env var that points the SDK at ingestion also works for sourcemaps.
  const normalised = base
    .replace(/\/+$/, "")
    .replace(/\/api\/capture$/, "")
    .replace(/\/capture$/, "");
  return normalised + ENDPOINT_PATH;
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(path)));
    } else if (entry.name.endsWith(".map")) {
      out.push(path);
    }
  }
  return out;
}

async function pool<T, R>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

function bundleFileFor(mapPath: string, serverDir: string): string {
  // Strip the serverDir prefix and the .map suffix; normalise Windows
  // backslashes so the bundleFile key stored on the server is portable
  // regardless of where the build ran.
  return relative(serverDir, mapPath)
    .replace(/\.map$/, "")
    .split(sep)
    .join("/");
}

/**
 * Upload every `.map` file under `serverDir` to the bugstack source-map
 * endpoint. Tolerant: never throws on individual file failures, returns
 * a summary the caller can decide what to do with.
 *
 * Throws only on hard configuration errors (no API key, no resolvable
 * endpoint, serverDir totally missing).
 */
export async function uploadSourceMaps(
  options: UploadSourceMapsOptions = {},
): Promise<UploadResult> {
  const apiKey =
    options.apiKey ||
    process.env.BUGSTACK_PROJECT_API_KEY ||
    process.env.BUGSTACK_API_KEY;
  const endpoint = resolveEndpoint(options.endpoint);
  const release = resolveRelease(options.release);
  const serverDir = options.serverDir || DEFAULT_SERVER_DIR;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const log = options.log || ((m: string) => console.log(m));
  const warn = options.warn || ((m: string) => console.warn(m));

  if (!apiKey) {
    throw new Error(
      "uploadSourceMaps: missing project API key. Set BUGSTACK_PROJECT_API_KEY or pass {apiKey} explicitly.",
    );
  }
  if (!endpoint) {
    throw new Error(
      "uploadSourceMaps: missing endpoint. Set BUGSTACK_ENDPOINT (or ERROR_SERVICE_URL) or pass {endpoint} explicitly.",
    );
  }

  const start = Date.now();
  const mapFiles = await walk(serverDir);

  if (mapFiles.length === 0) {
    log(
      `[bugstack] No .map files found under ${serverDir}. Make sure withBugstack() is wrapping your next.config or that source-map emission is otherwise enabled.`,
    );
    return { uploaded: 0, skipped: 0, failed: 0, totalBytes: 0, elapsedMs: 0, failures: [] };
  }

  log(
    `[bugstack] Uploading ${mapFiles.length} source map(s) to ${endpoint} (release=${release || "none"})...`,
  );

  const results = await pool(mapFiles, concurrency, async (mapPath) => {
    const bundleFile = bundleFileFor(mapPath, serverDir);
    const stats = await stat(mapPath);
    if (stats.size > maxBytes) {
      return {
        ok: false as const,
        bundleFile,
        bytes: 0,
        skipped: true,
        error: `Skipped — ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds maxBytes`,
      };
    }
    const mapJson = await readFile(mapPath, "utf8");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BugStack-API-Key": apiKey,
        },
        body: JSON.stringify({ bundleFile, mapJson, release }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false as const,
          bundleFile,
          bytes: 0,
          skipped: false,
          error: `HTTP ${res.status} ${text.slice(0, 200)}`,
        };
      }
      return { ok: true as const, bundleFile, bytes: stats.size, skipped: false };
    } catch (err) {
      return {
        ok: false as const,
        bundleFile,
        bytes: 0,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const uploaded = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => !r.ok && r.skipped).length;
  const failed = results.length - uploaded - skipped;
  const totalBytes = results.reduce((n, r) => n + (r.ok ? r.bytes : 0), 0);
  const failures = results
    .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok && !r.skipped)
    .map((r) => ({ bundleFile: r.bundleFile, error: r.error }));
  const elapsedMs = Date.now() - start;

  log(
    `[bugstack] Uploaded ${uploaded}/${results.length} maps (${(totalBytes / 1024 / 1024).toFixed(
      1,
    )}MB) in ${(elapsedMs / 1000).toFixed(1)}s.`,
  );
  if (skipped > 0) {
    warn(`[bugstack] Skipped ${skipped} map(s) over the size cap.`);
  }
  if (failures.length > 0) {
    warn(`[bugstack] ${failures.length} upload(s) failed:`);
    for (const f of failures.slice(0, 10)) {
      warn(`  - ${f.bundleFile}: ${f.error}`);
    }
    if (failures.length > 10) {
      warn(`  …and ${failures.length - 10} more`);
    }
  }

  return { uploaded, skipped, failed, totalBytes, elapsedMs, failures };
}
