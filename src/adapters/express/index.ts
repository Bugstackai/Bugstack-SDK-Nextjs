/**
 * BugStack SDK - Express Adapter
 *
 * Error capture middleware for Express.js applications
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { ErrorCaptureClient } from "../../core/client";
import type { ErrorCaptureConfig, CapturedError } from "../../core/types";
import { parseStackTrace, getFirstAppFrame } from "../../core/utils/stack-parser";
import { sanitizeObject, truncateBody } from "../../core/utils/sanitize";

const SDK_VERSION = "0.2.0";

/**
 * Generate a unique error ID
 */
function generateErrorId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return `err_${timestamp}_${random}`;
}

/**
 * Get Node.js version
 */
function getNodeVersion(): string {
  try {
    return process.version;
  } catch {
    return "unknown";
  }
}

/**
 * Get Express version
 */
function getExpressVersion(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("express/package.json");
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Sanitize headers for Express
 */
function sanitizeExpressHeaders(
  headers: Request["headers"],
  client?: ErrorCaptureClient | null
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const SENSITIVE_HEADERS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-bugstack-api-key",
    "proxy-authorization",
    "www-authenticate",
  ]);

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_HEADERS.has(lowerKey)) {
      sanitized[key] = "[REDACTED]";
    } else if (client?.shouldRedact(key)) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.join(", ");
    } else {
      sanitized[key] = String(value);
    }
  }

  return sanitized;
}

/**
 * Sanitize query parameters
 */
function sanitizeExpressQuery(
  query: Request["query"],
  client?: ErrorCaptureClient | null
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(query)) {
    if (client?.shouldRedact(key)) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.join(", ");
    } else {
      sanitized[key] = String(value);
    }
  }

  return sanitized;
}

/**
 * Build captured error from Express context
 */
function buildCapturedError(
  error: Error,
  req: Request,
  client: ErrorCaptureClient
): CapturedError {
  const config = client.getConfig();
  const stackFrames = parseStackTrace(error.stack);
  const firstAppFrame = getFirstAppFrame(stackFrames);

  const capturedError: CapturedError = {
    id: generateErrorId(),
    name: error.name || "Error",
    message: error.message,
    stack: error.stack,
    stackFrames,
    timestamp: new Date().toISOString(),
    route: req.route?.path || req.path || req.url,
    method: req.method,
    statusCode: 500,
    url: req.originalUrl || req.url,
    environment: config.environment,
    projectId: config.projectId,
    sdkVersion: SDK_VERSION,
    nodeVersion: getNodeVersion(),
  };

  // Add Express version if available
  const expressVersion = getExpressVersion();
  if (expressVersion) {
    capturedError.metadata = {
      ...capturedError.metadata,
      expressVersion,
    };
  }

  // Add route params if available
  if (req.params && Object.keys(req.params).length > 0) {
    capturedError.routeParams = req.params as Record<string, string>;
  }

  // Add query params if configured
  if (config.captureQueryParams && req.query && Object.keys(req.query).length > 0) {
    capturedError.queryParams = sanitizeExpressQuery(req.query, client);
  }

  // Add headers if configured
  if (config.captureHeaders) {
    capturedError.requestHeaders = sanitizeExpressHeaders(req.headers, client);
  }

  // Add request body if configured
  if (config.captureRequestBody && req.body) {
    const sanitizedBody = sanitizeObject(req.body, client);
    const bodyResult = truncateBody(sanitizedBody, config.maxBodySize);
    capturedError.requestBody = bodyResult.body;
    if (bodyResult.truncated) {
      capturedError.metadata = {
        ...capturedError.metadata,
        bodyTruncated: true,
      };
    }
  }

  // Add source location from first app frame
  if (firstAppFrame) {
    capturedError.metadata = {
      ...capturedError.metadata,
      sourceLocation: {
        file: firstAppFrame.file,
        line: firstAppFrame.line,
        column: firstAppFrame.column,
        function: firstAppFrame.function,
      },
    };
  }

  return capturedError;
}

/**
 * Express error handling middleware
 *
 * This middleware captures errors and reports them to BugStack.
 * It must be registered AFTER all routes and other middleware.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { bugstackErrorHandler } from '@bugstack/sdk/express';
 *
 * const app = express();
 *
 * // ... your routes and middleware
 *
 * // Register BugStack error handler (must be last)
 * app.use(bugstackErrorHandler({
 *   apiKey: 'your-api-key',
 *   projectId: 'your-project-id',
 *   autoFix: true
 * }));
 * ```
 */
export function bugstackErrorHandler(
  config?: ErrorCaptureConfig
): ErrorRequestHandler {
  // Initialize client if config provided and not already initialized
  if (config && !ErrorCaptureClient.isInitialized()) {
    ErrorCaptureClient.init(config);
  }

  // Return Express error middleware
  return (err: Error, req: Request, _res: Response, next: NextFunction): void => {
    const client = ErrorCaptureClient.getInstance();

    if (client && client.getConfig().enabled) {
      // Build and report error asynchronously (don't block response)
      const capturedError = buildCapturedError(err, req, client);

      client.reportError(capturedError).catch(() => {
        // Silently ignore capture/report failures
      });
    }

    // Pass error to next error handler (or default Express error handler)
    next(err);
  };
}

/**
 * Express middleware to initialize BugStack client
 *
 * Use this if you want to initialize the client separately from the error handler
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { initBugStack, bugstackErrorHandler } from '@bugstack/sdk/express';
 *
 * const app = express();
 *
 * // Initialize client early
 * app.use(initBugStack({
 *   apiKey: 'your-api-key',
 *   projectId: 'your-project-id',
 *   autoFix: true
 * }));
 *
 * // ... your routes
 *
 * // Register error handler
 * app.use(bugstackErrorHandler());
 * ```
 */
export function initBugStack(config: ErrorCaptureConfig) {
  if (!ErrorCaptureClient.isInitialized()) {
    ErrorCaptureClient.init(config);
  }

  // Return a no-op middleware
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next();
  };
}

/**
 * Wrap an Express route handler with error capture
 *
 * This is an alternative to using the error middleware. It catches errors
 * in async route handlers and reports them to BugStack.
 *
 * @example
 * ```typescript
 * import { wrapExpressHandler } from '@bugstack/sdk/express';
 *
 * app.get('/api/users/:id', wrapExpressHandler(async (req, res) => {
 *   const user = await getUser(req.params.id);
 *   res.json(user);
 * }));
 * ```
 */
export function wrapExpressHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res, next);
    } catch (error) {
      // Pass to error handling middleware
      next(error);
    }
  };
}

// Re-export types and client for convenience
export type { ErrorCaptureConfig, CapturedError } from "../../core/types";
export { ErrorCaptureClient, BugStackClient } from "../../core/client";
