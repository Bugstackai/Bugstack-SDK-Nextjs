# bugstack-sdk

Error capture SDK for Next.js 14+ App Router API routes. Automatically captures errors with full context and reports them to the BugStack service for AI-powered fix generation.

**Get your API key at:** https://dashboard.bugstack.ai

## Features

- **Zero-config wrapping** - Simply wrap your route handlers with `withErrorCapture`
- **Full error context** - Captures stack traces, request body, headers, query params
- **Automatic sanitization** - Sensitive data (passwords, tokens, etc.) is automatically redacted
- **Non-blocking** - Error reporting happens asynchronously without slowing down responses
- **TypeScript first** - Full type safety with comprehensive type definitions
- **Production ready** - Configurable timeouts, error handling, and kill switches

## Installation

```bash
npm install bugstack-sdk
# or
pnpm add bugstack-sdk
# or
yarn add bugstack-sdk
```

## Quick Start

### 1. Initialize the client (once, in a shared file)

```typescript
// lib/bugstack.ts
import { ErrorCaptureClient } from "bugstack-sdk";

export const bugstack = ErrorCaptureClient.init({
  apiKey: process.env.BUGSTACK_API_KEY!,
  projectId: "my-project",
  // Optional: customize endpoint
  // endpoint: "https://your-bugstack-server.com/api/capture",
});
```

### 2. Wrap your API routes

```typescript
// app/api/users/route.ts
import { NextResponse } from "next/server";
import { withErrorCapture } from "bugstack-sdk";
import "@/lib/bugstack"; // Ensure client is initialized

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

### 3. Dynamic routes with params

```typescript
// app/api/users/[id]/route.ts
import { NextResponse } from "next/server";
import { withErrorCapture } from "bugstack-sdk";
import "@/lib/bugstack";

export const GET = withErrorCapture<{ id: string }>(
  async (request, { params }) => {
    const user = await db.users.findUnique({
      where: { id: params.id },
    });

    if (!user) {
      throw new Error("User not found");
    }

    return NextResponse.json({ user });
  }
);
```

## Configuration

### Full Configuration Options

```typescript
import { ErrorCaptureClient } from "bugstack-sdk";

ErrorCaptureClient.init({
  // Required
  apiKey: "your-api-key",

  // Optional - defaults shown
  endpoint: "http://localhost:3001/api/capture",
  projectId: "",
  environment: process.env.NODE_ENV, // "development", "production", etc.
  enabled: true, // Set to false to disable capture

  // Request capture options
  captureRequestBody: true,
  captureQueryParams: true,
  captureHeaders: true,
  maxBodySize: 10000, // 10KB max body capture

  // Additional fields to redact (added to defaults)
  redactFields: ["customSecret", "internalToken"],

  // Custom metadata included with every error
  metadata: {
    service: "api",
    version: "1.0.0",
  },

  // Network options
  timeout: 5000, // 5 second timeout for error reporting

  // Debug logging (defaults to true in development)
  debug: true,

  // Custom filter - return false to skip certain errors
  shouldCapture: (error, request) => {
    // Don't capture 404s
    if (error.message.includes("not found")) {
      return false;
    }
    return true;
  },

  // Transform errors before sending
  beforeSend: (capturedError) => {
    // Add custom data
    capturedError.metadata = {
      ...capturedError.metadata,
      customField: "value",
    };
    return capturedError;
    // Return null to skip this error
  },
});
```

### Environment Variables

The SDK automatically reads these environment variables:

```bash
# Required
BUGSTACK_API_KEY=your-api-key

# Optional
BUGSTACK_ENDPOINT=https://bugstack-error-service.onrender.com/api/capture
BUGSTACK_PROJECT_ID=my-project
NODE_ENV=production
```

**Note:** The default endpoint is `http://localhost:3001/api/capture` for local development. Set `BUGSTACK_ENDPOINT` to the production URL shown above for deployed applications.

### Per-Route Options

You can override options for specific routes:

```typescript
export const POST = withErrorCapture(
  async (request) => {
    // handler code
  },
  undefined, // Use existing client config
  {
    // Route-specific options
    statusCode: 400, // Report as 400 instead of 500
    metadata: {
      operation: "createUser",
      critical: true,
    },
    shouldCapture: (error) => {
      // Route-specific filter
      return error.name !== "ValidationError";
    },
  }
);
```

## Captured Error Data

Each error report includes:

```typescript
interface CapturedError {
  id: string;                    // Unique error ID (err_xxx_xxx)
  name: string;                  // Error name (TypeError, etc.)
  message: string;               // Error message
  stack: string;                 // Full stack trace
  stackFrames: StackFrame[];     // Parsed stack frames
  timestamp: string;             // ISO 8601 timestamp
  route: string;                 // API route path
  method: string;                // HTTP method
  statusCode: number;            // HTTP status code
  url: string;                   // Full request URL
  queryParams: object;           // Query parameters (sanitized)
  requestBody: unknown;          // Request body (sanitized)
  requestHeaders: object;        // Headers (sanitized)
  routeParams: object;           // Dynamic route params
  environment: string;           // Environment name
  projectId: string;             // Project identifier
  sdkVersion: string;            // SDK version
  nodeVersion: string;           // Node.js version
  nextVersion: string;           // Next.js version
  metadata: object;              // Custom metadata
}
```

## Automatic Data Sanitization

The SDK automatically redacts sensitive fields from:
- Request headers (Authorization, Cookie, etc.)
- Request body
- Query parameters

**Default redacted fields:**
- password, secret, token
- apikey, api_key, apiKey
- authorization, auth, credential
- credit_card, creditcard, card_number
- cvv, ssn, social_security

Add custom fields via `redactFields` config option.

## Error Handling

The SDK is designed to never interfere with your application:

- **Network failures** - Silently ignored, your app continues normally
- **Timeouts** - Configurable, defaults to 5 seconds
- **SDK errors** - Caught and logged (in debug mode), never thrown
- **Re-throws original error** - Next.js still handles the error response

## Advanced Usage

### Manual Error Reporting

```typescript
import { ErrorCaptureClient } from "bugstack-sdk";

const client = ErrorCaptureClient.getInstance();

if (client) {
  await client.reportError({
    id: "manual_001",
    name: "CustomError",
    message: "Something went wrong",
    timestamp: new Date().toISOString(),
    route: "/api/custom",
    method: "POST",
    statusCode: 500,
    url: "https://example.com/api/custom",
    environment: "production",
    sdkVersion: "1.0.0",
    nodeVersion: process.version,
  });
}
```

### Stack Trace Utilities

```typescript
import {
  parseStackTrace,
  getFirstAppFrame,
  getAppFrames,
} from "bugstack-sdk";

const frames = parseStackTrace(error.stack);
const firstAppFrame = getFirstAppFrame(frames); // First non-node_modules frame
const appFrames = getAppFrames(frames); // All application frames
```

### Sanitization Utilities

```typescript
import {
  sanitizeHeaders,
  sanitizeQueryParams,
  sanitizeObject,
} from "bugstack-sdk";

const safeHeaders = sanitizeHeaders(request.headers);
const safeParams = sanitizeQueryParams(new URL(request.url));
const safeBody = sanitizeObject(requestBody);
```

## TypeScript Support

Full type definitions are included:

```typescript
import type {
  ErrorCaptureConfig,
  CapturedError,
  StackFrame,
  RouteOptions,
  NextRouteHandler,
  RouteContext,
} from "bugstack-sdk";
```

## Compatibility

- **Next.js**: 14.0.0+
- **Node.js**: 18.0.0+
- **TypeScript**: 5.0.0+ (optional)

## License

MIT
