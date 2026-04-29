import type { NextRequest } from "next/server";
import { ErrorCaptureClient } from "./client";
import type {
  ErrorCaptureConfig,
  CapturedError,
  RouteOptions,
  RouteContext,
} from "./types";
import { sanitizeHeaders, sanitizeQueryParams, safeParseBody } from "./sanitize";
import { parseStackTrace, getFirstAppFrame } from "./stack-parser";
import { SDK_VERSION } from "./core/sdk-version";

/**
 * Generate a unique error ID
 */
function generateErrorId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 9);
  return `err_${timestamp}_${random}`;
}

/**
 * Extract route path from request URL
 */
function extractRoute(request: NextRequest): string {
  try {
    const url = new URL(request.url);
    return url.pathname;
  } catch {
    return "unknown";
  }
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
 * Try to get Next.js version from package
 */
function getNextVersion(): string | undefined {
  try {
    // This is a best-effort attempt
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("next/package.json");
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Build the captured error object
 */
async function buildCapturedError(
  error: Error,
  request: NextRequest,
  context: RouteContext | undefined,
  client: ErrorCaptureClient,
  routeOptions?: RouteOptions
): Promise<CapturedError> {
  const config = client.getConfig();
  const url = new URL(request.url);
  const stackFrames = parseStackTrace(error.stack);
  const firstAppFrame = getFirstAppFrame(stackFrames);

  const capturedError: CapturedError = {
    id: generateErrorId(),
    name: error.name || "Error",
    message: error.message,
    stack: error.stack,
    stackFrames,
    timestamp: new Date().toISOString(),
    route: extractRoute(request),
    method: request.method,
    statusCode: routeOptions?.statusCode ?? 500,
    url: request.url,
    environment: config.environment,
    projectId: config.projectId,
    sdkVersion: SDK_VERSION,
    nodeVersion: getNodeVersion(),
    nextVersion: getNextVersion(),
  };

  // Add route params if available
  if (context?.params && Object.keys(context.params).length > 0) {
    capturedError.routeParams = context.params as Record<string, string>;
  }

  // Add query params if configured
  if (config.captureQueryParams && url.searchParams.toString()) {
    capturedError.queryParams = sanitizeQueryParams(url, client);
  }

  // Add headers if configured
  if (config.captureHeaders) {
    capturedError.requestHeaders = sanitizeHeaders(request.headers, client);
  }

  // Add request body if configured
  if (config.captureRequestBody && hasBody(request.method)) {
    const bodyResult = await safeParseBody(request, config.maxBodySize, client);
    if (bodyResult) {
      capturedError.requestBody = bodyResult.body;
      if (bodyResult.truncated) {
        capturedError.metadata = {
          ...capturedError.metadata,
          bodyTruncated: true,
        };
      }
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

  // Merge route-specific metadata
  if (routeOptions?.metadata) {
    capturedError.metadata = {
      ...capturedError.metadata,
      ...routeOptions.metadata,
    };
  }

  return capturedError;
}

/**
 * Check if HTTP method typically has a body
 */
function hasBody(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

/**
 * Type for the wrapped handler function
 */
type WrappedHandler<T> = (
  request: NextRequest,
  context: RouteContext<T>
) => Response | Promise<Response>;

/**
 * Wrap a Next.js App Router API route handler with error capture
 *
 * @example
 * ```typescript
 * // Basic usage
 * export const GET = withErrorCapture(async (request) => {
 *   return NextResponse.json({ data: "hello" });
 * });
 *
 * // With configuration (first call only)
 * export const GET = withErrorCapture(
 *   async (request) => {
 *     return NextResponse.json({ data: "hello" });
 *   },
 *   { apiKey: "your-api-key" }
 * );
 *
 * // With route-specific options
 * export const POST = withErrorCapture(
 *   async (request) => {
 *     return NextResponse.json({ data: "created" });
 *   },
 *   undefined,
 *   { statusCode: 400, metadata: { operation: "create" } }
 * );
 * ```
 */
export function withErrorCapture<T = Record<string, string>>(
  handler: WrappedHandler<T>,
  config?: ErrorCaptureConfig,
  routeOptions?: RouteOptions
): WrappedHandler<T> {
  // Initialize client if config provided and not already initialized
  if (config && !ErrorCaptureClient.isInitialized()) {
    ErrorCaptureClient.init(config);
  }

  return async (
    request: NextRequest,
    context: RouteContext<T>
  ): Promise<Response> => {
    const client = ErrorCaptureClient.getInstance();

    try {
      // Execute the original handler
      const response = await handler(request, context);
      return response;
    } catch (error) {
      // Normalize error to Error instance
      const err = error instanceof Error ? error : new Error(String(error));

      // Only capture if client is initialized and enabled
      if (client) {
        const clientConfig = client.getConfig();

        // Check shouldCapture filter (global)
        if (clientConfig.shouldCapture && !clientConfig.shouldCapture(err, request)) {
          throw error; // Re-throw without capturing
        }

        // Check shouldCapture filter (route-specific)
        if (routeOptions?.shouldCapture && !routeOptions.shouldCapture(err)) {
          throw error; // Re-throw without capturing
        }

        // Build and report error asynchronously (don't block response)
        buildCapturedError(err, request, context as RouteContext, client, routeOptions)
          .then((capturedError) => {
            return client.reportError(capturedError);
          })
          .catch(() => {
            // Silently ignore capture/report failures
            // The original error should still propagate
          });
      }

      // Re-throw the original error so Next.js handles it
      throw error;
    }
  };
}

// Legacy alias for backwards compatibility
export const withBugStack = withErrorCapture;
