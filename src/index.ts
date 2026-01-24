/**
 * BugStack Error Capture SDK
 *
 * Capture and report errors from Next.js API routes to the BugStack service.
 *
 * @packageDocumentation
 */

// Main exports
export { withErrorCapture, withBugStack } from "./wrapper";
export { ErrorCaptureClient, BugStackClient } from "./client";

// Type exports
export type {
  // Main configuration types
  ErrorCaptureConfig,
  BugStackConfig,
  ResolvedConfig,
  RouteOptions,

  // Error types
  CapturedError,
  StackFrame,
  ErrorReportPayload,
  SourceContext,

  // Next.js types
  NextRouteHandler,
  RouteContext,
} from "./types";

// Utility exports (for advanced usage)
export { parseStackTrace, getFirstAppFrame, getAppFrames } from "./stack-parser";
export { sanitizeHeaders, sanitizeQueryParams, sanitizeObject } from "./sanitize";
