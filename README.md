# bugstack-sdk

Framework-agnostic error capture SDK for Node.js. Automatically captures errors with full context and reports them to BugStack for AI-powered fix generation.

**Get your API key at:** [dashboard.bugstack.ai](https://dashboard.bugstack.ai)

## Features

- **Multiple frameworks** — First-class support for Next.js, Express, and generic Node.js
- **Full error context** — Captures stack traces, request body, headers, query params, route params
- **Automatic sanitization** — Sensitive data (passwords, tokens, API keys) is redacted automatically
- **Non-blocking** — Error reporting is async and never slows down your responses
- **Deduplication** — Same errors are batched within a configurable time window
- **Retry queue** — Failed reports are retried with exponential backoff
- **TypeScript first** — Full type safety with comprehensive type definitions

## Installation

```bash
npm install --save-exact bugstack-sdk
```

## Quick Start

### Next.js (App Router)

**1. Initialize the client once:**

```typescript
// lib/bugstack.ts
import { ErrorCaptureClient } from "bugstack-sdk";

ErrorCaptureClient.init({
  apiKey: process.env.BUGSTACK_API_KEY!,
  endpoint: "https://dashboard.bugstack.ai/api/ingest/sdk",
});
```

**2. Wrap your API route handlers:**

```typescript
// app/api/users/route.ts
import { NextResponse } from "next/server";
import { withErrorCapture } from "bugstack-sdk/next";
import "@/lib/bugstack"; // ensures client is initialized

export const GET = withErrorCapture(async (request) => {
  const users = await db.users.findMany();
  return NextResponse.json({ users });
});

export const POST = withErrorCapture(async (request) => {
  const body = await request.json();
  const user = await db.users.create({ data: body });
  return NextResponse.json({ user }, { status: 201 });
});
```

**3. Dynamic routes with params:**

```typescript
// app/api/users/[id]/route.ts
import { NextResponse } from "next/server";
import { withErrorCapture } from "bugstack-sdk/next";
import "@/lib/bugstack";

export const GET = withErrorCapture<{ id: string }>(
  async (request, { params }) => {
    const user = await db.users.findUnique({ where: { id: params.id } });
    if (!user) throw new Error("User not found");
    return NextResponse.json({ user });
  }
);
```

---

### Express

**Option A: Error handler middleware (recommended)**

```typescript
import express from "express";
import { bugstackErrorHandler } from "bugstack-sdk/express";

const app = express();

// Your routes
app.get("/api/users", async (req, res) => {
  const users = await db.users.findMany();
  res.json({ users });
});

// Add BugStack error handler AFTER all routes
app.use(
  bugstackErrorHandler({
    apiKey: process.env.BUGSTACK_API_KEY!,
    endpoint: "https://dashboard.bugstack.ai/api/ingest/sdk",
  })
);
```

**Option B: Wrap individual route handlers**

```typescript
import { initBugStack, wrapExpressHandler } from "bugstack-sdk/express";

// Initialize once
app.use(
  initBugStack({
    apiKey: process.env.BUGSTACK_API_KEY!,
    endpoint: "https://dashboard.bugstack.ai/api/ingest/sdk",
  })
);

// Wrap specific routes
app.get("/api/users/:id", wrapExpressHandler(async (req, res) => {
  const user = await getUser(req.params.id);
  res.json(user);
}));
```

---

### Generic Node.js

For any Node.js application (scripts, workers, serverless functions, etc.):

```typescript
import { initBugStack, captureError, installGlobalHandlers } from "bugstack-sdk/generic";

// Initialize once
initBugStack({
  apiKey: process.env.BUGSTACK_API_KEY!,
  endpoint: "https://dashboard.bugstack.ai/api/ingest/sdk",
});

// Optional: catch uncaught exceptions and unhandled rejections globally
installGlobalHandlers();

// Capture errors manually in try/catch blocks
try {
  await processData();
} catch (error) {
  await captureError(error, { operation: "processData" });
}
```

**Wrap functions for automatic capture:**

```typescript
import { wrapFunction } from "bugstack-sdk/generic";

const processData = wrapFunction(
  async (data: Input) => {
    // errors thrown here are automatically captured
    return transform(data);
  },
  { operation: "processData" }
);
```

**Create scoped capture functions:**

```typescript
import { createErrorCapture } from "bugstack-sdk/generic";

const captureDbError = createErrorCapture({ component: "database" });

try {
  await db.query("SELECT ...");
} catch (error) {
  await captureDbError(error, { query: "SELECT ..." });
}
```

---

## Source Maps for Production (Next.js)

By default, server-side errors in a Next.js production build come back with stack frames that point at compiled chunks like `.next/server/chunks/8393.js:1:8734`. The bugstack orchestrator can't fix what it can't locate — so without source maps, those errors land in your dashboard as "Could not identify primary file from error" and never auto-fix.

Uploading source maps closes that loop. The orchestrator resolves bundled frames back to source-file positions (`app/api/orders/route.ts:42:5`) before deciding which file to patch.

### Two-step setup

**1. Wrap your `next.config.js`:**

```js
const { withBugstack } = require('bugstack-sdk/next-config')

module.exports = withBugstack({
  // your existing Next.js config
})
```

This enables `webpack.devtool = 'source-map'` for production server builds (no effect on dev or client). Any existing `webpack` hook you have is preserved and runs first.

**2. Append the upload command to your `build` script:**

```json
{
  "scripts": {
    "build": "next build && bugstack sourcemaps upload"
  }
}
```

The CLI walks `.next/server/**/*.map`, uploads each to bugstack keyed by the active release, and **never fails the build** — source maps are an optimisation, not a release gate.

### Required environment

The CLI needs two env vars at build time. Set them in your CI / hosting provider:

| Variable | Purpose |
|---|---|
| `BUGSTACK_PROJECT_API_KEY` | Your project SDK key (find it in your project settings on the bugstack dashboard). |
| `BUGSTACK_ENDPOINT` | Base URL of the bugstack ingest service. The CLI appends `/api/sourcemaps/upload` automatically. |

Release identifiers are auto-detected from `BUGSTACK_RELEASE`, `RENDER_GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, or `git rev-parse HEAD` — in that order. Override with `--release <id>` if you have a different versioning scheme.

### Verifying

After your next deploy with these env vars set, the build log should print something like:

```
[bugstack] Uploading 68 source map(s) to https://… (release=a9ad704)…
[bugstack] Uploaded 68/68 maps (10.0MB) in 4.2s.
```

When a server-side error captures next, the row's stack trace and proposed fix will reference real source files (`app/api/.../route.ts`) instead of bundled chunks.

### Programmatic API

If you'd rather drive the upload from a custom script:

```ts
import { uploadSourceMaps } from 'bugstack-sdk/build'

await uploadSourceMaps({
  apiKey: process.env.BUGSTACK_PROJECT_API_KEY,
  endpoint: process.env.BUGSTACK_ENDPOINT,
  release: process.env.GIT_SHA,
  serverDir: '.next/server',  // override for non-Next builds
})
```

### Other build systems

The CLI defaults to `.next/server` but accepts `--server-dir <path>` so it works for any directory of compiled `.js` + `.js.map` pairs (e.g. `dist/` for tsc, `build/` for CRA, custom esbuild outputs). The `withBugstack` wrapper is Next.js-specific; for other frameworks, enable source-map emission in your bundler config and run the CLI directly.

---

## Other Languages

BugStack also provides SDKs for:

| Language | Package | Install |
|----------|---------|---------|
| Python | [bugstack](https://pypi.org/project/bugstack/) | `pip install bugstack` |
| Ruby | [bugstack](https://rubygems.org/gems/bugstack) | `gem install bugstack` |
| Go | [bugstack-go](https://github.com/MasonBachmann7/Bugstack-SDK-Go) | `go get github.com/MasonBachmann7/bugstack-go` |

---

## Configuration

### Full Options

```typescript
import { ErrorCaptureClient } from "bugstack-sdk";

ErrorCaptureClient.init({
  // Required
  apiKey: "your-api-key",

  // Endpoint (defaults to the bugstack ingest endpoint)
  endpoint: "https://dashboard.bugstack.ai/api/ingest/sdk",

  // Optional — defaults shown
  projectId: "",
  environment: process.env.NODE_ENV,     // "development", "production", etc.
  enabled: true,                         // set false to disable capture entirely

  // Request capture
  captureRequestBody: true,
  captureQueryParams: true,
  captureHeaders: true,
  maxBodySize: 10000,                    // 10KB max body capture

  // Additional fields to redact (added to built-in defaults)
  redactFields: ["customSecret", "internalToken"],

  // Custom metadata included with every error
  metadata: { service: "api", version: "1.0.0" },

  // Network
  timeout: 5000,                         // 5s timeout for error reporting
  deduplicationWindow: 5 * 60 * 1000,   // 5 min window for dedup

  // Debug logging (defaults to true in development)
  debug: false,

  // Custom filter — return false to skip certain errors
  shouldCapture: (error, request) => {
    if (error.message.includes("not found")) return false;
    return true;
  },

  // Transform errors before sending
  beforeSend: (capturedError) => {
    capturedError.metadata = { ...capturedError.metadata, custom: "value" };
    return capturedError; // return null to skip
  },
});
```

### Environment Variables

The SDK reads these automatically:

```bash
BUGSTACK_API_KEY=your-api-key                                              # Required
BUGSTACK_ENDPOINT=https://dashboard.bugstack.ai/api/ingest/sdk  # Optional
BUGSTACK_PROJECT_ID=my-project                                             # Optional
NODE_ENV=production                                                        # Optional
```

### Per-Route Options (Next.js)

```typescript
export const POST = withErrorCapture(
  async (request) => { /* ... */ },
  undefined,  // use existing client config
  {
    statusCode: 400,
    metadata: { operation: "createUser" },
    shouldCapture: (error) => error.name !== "ValidationError",
  }
);
```

---

## Automatic Sanitization

The SDK redacts sensitive data from headers, request bodies, and query params.

**Built-in redacted fields:**
`password`, `secret`, `token`, `apikey`, `api_key`, `apiKey`, `authorization`, `auth`, `credential`, `private`, `credit_card`, `creditcard`, `card_number`, `cvv`, `ssn`, `social_security`

**Always-redacted headers:**
`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `proxy-authorization`

Add custom fields via the `redactFields` config option.

---

## Error Resilience

The SDK never interferes with your application:

- **Network failures** — Silently retried (up to 5 times with exponential backoff)
- **Timeouts** — Configurable, defaults to 5 seconds
- **SDK errors** — Caught and logged in debug mode, never thrown to your app
- **Original error preserved** — The wrapper re-throws the original error so your framework handles the response normally

---

## Captured Data

Each error report includes:

| Field | Description |
|-------|-------------|
| `id` | Unique error ID |
| `fingerprint` | Stable hash for deduplication |
| `name` | Error type (TypeError, etc.) |
| `message` | Error message |
| `stack` | Full stack trace |
| `stackFrames` | Parsed stack frames with file, line, column |
| `route` | API route path |
| `method` | HTTP method |
| `statusCode` | HTTP status code |
| `url` | Full request URL |
| `queryParams` | Sanitized query parameters |
| `requestBody` | Sanitized request body |
| `requestHeaders` | Sanitized headers |
| `routeParams` | Dynamic route parameters |
| `environment` | Environment name |
| `projectId` | Project identifier |
| `metadata` | Custom metadata |

---

## TypeScript

All types are exported:

```typescript
import type {
  ErrorCaptureConfig,
  CapturedError,
  StackFrame,
  RouteOptions,
  RouteContext,
  ErrorReportPayload,
  SourceContext,
} from "bugstack-sdk";
```

## Compatibility

- **Next.js**: 14.0.0+
- **Express**: 4.x or 5.x
- **Node.js**: 18.0.0+
- **TypeScript**: 5.0.0+ (optional)

## License

MIT
