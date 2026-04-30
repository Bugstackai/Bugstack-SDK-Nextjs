#!/usr/bin/env node
// Tiny shebang stub — keeps the `npx bugstack ...` entry point working
// without having to wrestle tsup into preserving a shebang on the bundled
// output. Adding/removing CLI logic happens in src/build/cli.ts; this
// file only ever needs to require the built artifact.
require("../dist/build/cli.js");
