/**
 * `bugstack` CLI entry point.
 *
 * One command for now — `bugstack sourcemaps upload` — but the dispatch
 * is structured so additional subcommands can land without a breaking
 * change. Reads config from flags first, env vars second; everything has
 * a sensible default so the typical CI invocation is just:
 *
 *     bugstack sourcemaps upload
 */

import { parseArgs } from "node:util";
import { uploadSourceMaps, type UploadSourceMapsOptions } from "./upload";

function printHelp(): void {
  console.log(`bugstack — source-map upload + maintenance CLI

USAGE
  bugstack sourcemaps upload [options]
  bugstack --help

OPTIONS (sourcemaps upload)
  --api-key <key>         Project SDK key. Default: BUGSTACK_PROJECT_API_KEY env.
  --endpoint <url>        Base URL of the bugstack ingest service. Default:
                          BUGSTACK_ENDPOINT env, or ERROR_SERVICE_URL.
  --release <id>          Release identifier (commit SHA / version). Default:
                          BUGSTACK_RELEASE env, RENDER_GIT_COMMIT,
                          VERCEL_GIT_COMMIT_SHA, GITHUB_SHA, or git rev-parse HEAD.
  --server-dir <path>     Directory to walk for .map files. Default: .next/server.
  --concurrency <n>       Max concurrent uploads. Default: 6.
  --max-bytes <n>         Per-file size cap in bytes. Default: 8388608 (8 MiB).
  --quiet                 Suppress info logs (warnings still printed).

EXIT CODES
  0  Always — upload failures are reported but never fail the build by
     design. Source maps are an optimisation, not a release gate.
`);
}

async function runSourceMapsUpload(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "api-key": { type: "string" },
        endpoint: { type: "string" },
        release: { type: "string" },
        "server-dir": { type: "string" },
        concurrency: { type: "string" },
        "max-bytes": { type: "string" },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
  } catch (err) {
    console.error(`bugstack: ${(err as Error).message}`);
    return 2;
  }

  if (parsed.values.help) {
    printHelp();
    return 0;
  }

  const opts: UploadSourceMapsOptions = {
    apiKey: parsed.values["api-key"],
    endpoint: parsed.values.endpoint,
    release: parsed.values.release,
    serverDir: parsed.values["server-dir"],
    concurrency: parsed.values.concurrency ? Number(parsed.values.concurrency) : undefined,
    maxBytes: parsed.values["max-bytes"] ? Number(parsed.values["max-bytes"]) : undefined,
  };
  if (parsed.values.quiet) {
    opts.log = () => {};
  }

  try {
    await uploadSourceMaps(opts);
    return 0;
  } catch (err) {
    // Distinguish hard config errors (missing key, bad endpoint) from per-
    // file failures: only the former should surface as a non-zero exit.
    // Per-file failures stay inside uploadSourceMaps and resolve with a
    // logged summary.
    console.warn(
      `[bugstack] Skipping source-map upload: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.warn(`[bugstack] (This is a soft skip — your build will still succeed.)`);
    return 0;
  }
}

async function main(): Promise<number> {
  const [, , command, subcommand, ...rest] = process.argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }

  if (command === "sourcemaps" && subcommand === "upload") {
    return runSourceMapsUpload(rest);
  }

  console.error(`bugstack: unknown command "${[command, subcommand].filter(Boolean).join(" ")}"`);
  printHelp();
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`bugstack: unexpected error — ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
  },
);
