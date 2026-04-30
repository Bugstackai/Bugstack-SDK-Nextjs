/**
 * `next.config.js` wrapper for bugstack — turns server-side source-map
 * emission on without the user having to touch their webpack config.
 *
 * Intended use:
 *
 *     // next.config.js
 *     const { withBugstack } = require('bugstack-sdk/next-config')
 *
 *     module.exports = withBugstack({
 *       // ...your existing Next config
 *     })
 *
 * Once wrapped, `next build` emits .map files alongside server bundles in
 * .next/server/. Pair with `bugstack sourcemaps upload` in your build
 * script to ship them to bugstack so the orchestrator can resolve
 * production stack frames back to source files.
 *
 * Anything you already pass under `webpack` is preserved and called first;
 * we only set `devtool` afterwards, and only for production server builds
 * (not dev, not client). Idempotent — wrapping twice is a no-op.
 */

// Minimal NextConfig shape — keeping it loose so we don't pull in `next`
// as a peer dependency just for this wrapper. The underlying type is
// import("next").NextConfig but consumers don't need to know that.
type WebpackConfig = { devtool?: string | false } & Record<string, unknown>;
type WebpackContext = {
  dev: boolean;
  isServer: boolean;
  nextRuntime?: "nodejs" | "edge";
};
type WebpackHook = (config: WebpackConfig, context: WebpackContext) => WebpackConfig;
type NextConfigLike = {
  webpack?: WebpackHook;
  [key: string]: unknown;
};

export interface BugstackNextOptions {
  /**
   * When true (default), enables server-side source-map emission.
   * Set false to opt back out — useful if you have your own devtool config
   * and want bugstack to leave it alone.
   */
  emitServerSourceMaps?: boolean;

  /**
   * `devtool` value to use for production server builds. Default
   * `"source-map"` (full external maps). Override to e.g. `"hidden-source-map"`
   * if you want maps emitted but no `# sourceMappingURL` comment in the JS.
   */
  serverDevtool?: string;
}

/**
 * Wrap a Next.js config to enable bugstack's source-map pipeline.
 * Pass-through if `emitServerSourceMaps` is false.
 */
export function withBugstack<C extends NextConfigLike>(
  nextConfig: C = {} as C,
  options: BugstackNextOptions = {},
): C {
  const emit = options.emitServerSourceMaps ?? true;
  if (!emit) return nextConfig;

  const serverDevtool = options.serverDevtool ?? "source-map";
  const userWebpack = nextConfig.webpack;

  const wrapped: WebpackHook = (config, context) => {
    // Run the user's hook first so we don't clobber custom resolve aliases,
    // plugins, etc. Their hook may also touch `devtool`; we override after.
    const next = userWebpack ? userWebpack(config, context) : config;

    if (context.isServer && !context.dev) {
      next.devtool = serverDevtool;
    }
    return next;
  };

  return {
    ...nextConfig,
    webpack: wrapped,
  };
}

// Default export aliases withBugstack so `require('bugstack-sdk/next-config')`
// also works as a callable wrapper without destructuring.
export default withBugstack;
