/**
 * BugStack SDK - Generic Adapter
 *
 * Generic error capture for any Node.js application
 * Use this for non-Express, non-Next.js applications
 */

import { ErrorCaptureClient } from "../../core/client";
import type { ErrorCaptureConfig, CapturedError } from "../../core/types";
import { parseStackTrace, getFirstAppFrame } from "../../core/utils/stack-parser";

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
 * Build a basic captured error from an Error object
 */
function buildCapturedError(
  error: Error,
  client: ErrorCaptureClient,
  metadata?: Record<string, unknown>
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
    route: "generic",
    method: "N/A",
    statusCode: 500,
    url: "N/A",
    environment: config.environment,
    projectId: config.projectId,
    sdkVersion: SDK_VERSION,
    nodeVersion: getNodeVersion(),
  };

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

  // Merge additional metadata
  if (metadata) {
    capturedError.metadata = {
      ...capturedError.metadata,
      ...metadata,
    };
  }

  return capturedError;
}

/**
 * Initialize BugStack for a generic Node.js application
 *
 * @example
 * ```typescript
 * import { initBugStack, captureError } from '@bugstack/sdk/generic';
 *
 * initBugStack({
 *   apiKey: 'your-api-key',
 *   projectId: 'your-project-id',
 *   autoFix: true
 * });
 *
 * // Later, capture errors manually
 * try {
 *   // your code
 * } catch (error) {
 *   captureError(error, { operation: 'processData' });
 * }
 * ```
 */
export function initBugStack(config: ErrorCaptureConfig): ErrorCaptureClient {
  return ErrorCaptureClient.init(config);
}

/**
 * Manually capture and report an error
 *
 * @param error - The error to capture
 * @param metadata - Optional metadata to attach to the error
 * @returns Promise that resolves to true if error was accepted (not deduplicated)
 *
 * @example
 * ```typescript
 * import { captureError } from '@bugstack/sdk/generic';
 *
 * try {
 *   await processData();
 * } catch (error) {
 *   await captureError(error, {
 *     operation: 'processData',
 *     userId: user.id
 *   });
 *   throw error; // Re-throw if needed
 * }
 * ```
 */
export async function captureError(
  error: Error | unknown,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  const client = ErrorCaptureClient.getInstance();

  if (!client) {
    console.warn(
      "[BugStack] Client not initialized. Call initBugStack() first."
    );
    return false;
  }

  // Normalize to Error instance
  const err = error instanceof Error ? error : new Error(String(error));

  // Build and report error
  const capturedError = buildCapturedError(err, client, metadata);
  return client.reportError(capturedError);
}

/**
 * Capture an exception (alias for captureError)
 */
export const captureException = captureError;

/**
 * Wrap a function with automatic error capture
 *
 * @param fn - The function to wrap
 * @param metadata - Optional metadata to attach to any errors
 * @returns Wrapped function that captures errors
 *
 * @example
 * ```typescript
 * import { wrapFunction } from '@bugstack/sdk/generic';
 *
 * const processData = wrapFunction(
 *   async (data) => {
 *     // your code that might throw
 *   },
 *   { operation: 'processData' }
 * );
 *
 * // Errors will be automatically captured
 * await processData(someData);
 * ```
 */
export function wrapFunction<T extends (...args: any[]) => any>(
  fn: T,
  metadata?: Record<string, unknown>
): T {
  return ((...args: any[]) => {
    try {
      const result = fn(...args);

      // Handle async functions
      if (result instanceof Promise) {
        return result.catch((error) => {
          captureError(error, metadata);
          throw error; // Re-throw after capturing
        });
      }

      return result;
    } catch (error) {
      captureError(error, metadata);
      throw error; // Re-throw after capturing
    }
  }) as T;
}

/**
 * Install global error handlers
 *
 * This captures unhandled errors and promise rejections globally
 *
 * @example
 * ```typescript
 * import { initBugStack, installGlobalHandlers } from '@bugstack/sdk/generic';
 *
 * initBugStack({
 *   apiKey: 'your-api-key',
 *   projectId: 'your-project-id',
 *   autoFix: true
 * });
 *
 * // Capture all unhandled errors
 * installGlobalHandlers();
 * ```
 */
export function installGlobalHandlers(): void {
  // Capture uncaught exceptions
  process.on("uncaughtException", (error) => {
    captureError(error, { type: "uncaughtException" }).then(() => {
      // Give time for error to be sent before exiting
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    });
  });

  // Capture unhandled promise rejections
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    captureError(error, { type: "unhandledRejection" }).catch(() => {
      // Ignore capture failures
    });
  });
}

/**
 * Create a context-aware error capture function
 *
 * Useful for capturing errors with consistent metadata
 *
 * @example
 * ```typescript
 * import { createErrorCapture } from '@bugstack/sdk/generic';
 *
 * const captureDbError = createErrorCapture({
 *   component: 'database',
 *   service: 'user-service'
 * });
 *
 * try {
 *   await db.query('...');
 * } catch (error) {
 *   await captureDbError(error, { query: '...' });
 * }
 * ```
 */
export function createErrorCapture(baseMetadata: Record<string, unknown>) {
  return (error: Error | unknown, additionalMetadata?: Record<string, unknown>) => {
    return captureError(error, {
      ...baseMetadata,
      ...additionalMetadata,
    });
  };
}

// Re-export core functionality
export { ErrorCaptureClient, BugStackClient } from "../../core/client";
export type { ErrorCaptureConfig, CapturedError } from "../../core/types";
