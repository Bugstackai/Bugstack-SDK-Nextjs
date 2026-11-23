import { defineConfig } from "tsup";
import { readFileSync } from "fs";

// Read the package version once at config-load and inject it into the build
// as a literal. This keeps the SDK's wire-header version (the constant in
// client.ts) automatically in sync with package.json on every release —
// no more stale "0.2.0" header drift across major bumps.
const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

export default defineConfig([{
  entry: [
    "src/index.ts",
    "src/adapters/nextjs/index.ts",
    "src/adapters/express/index.ts",
    "src/adapters/generic/index.ts",
    "src/build/upload.ts",
    "src/build/cli.ts",
    "src/next-config/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: false, // "rimraf dist" in the build script: two configs must not clean each other's output
  sourcemap: true,
  minify: false,
  splitting: false,
  treeshake: true,
  external: ["next", "express"],
  define: {
    __BUGSTACK_SDK_VERSION__: JSON.stringify(pkg.version),
  },
  esbuildOptions(options) {
    options.platform = "node";
  },
},
// bugstack-sdk/browser: runs in the customer's page, so it is built for the
// browser, on its own (no node built-ins, no shared chunks).
{
  entry: { "browser/index": "src/browser/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  sourcemap: true,
  minify: false,
  splitting: false,
  treeshake: true,
  platform: "browser",
  target: "es2019",
}]);
