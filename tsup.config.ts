import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/nextjs/index.ts",
    "src/adapters/express/index.ts",
    "src/adapters/generic/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  treeshake: true,
  external: ["next", "express"],
  esbuildOptions(options) {
    options.platform = "node";
  },
});
