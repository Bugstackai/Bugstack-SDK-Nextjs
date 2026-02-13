/**
 * BugStack Error Capture SDK
 *
 * Framework-agnostic error capture with adapters for Next.js, Express, and more.
 *
 * @packageDocumentation
 */

// Export core functionality (framework-agnostic)
export { ErrorCaptureClient, BugStackClient } from "./core/client";
export {
  generateErrorFingerprint,
  generateFingerprintFromParts,
} from "./core/fingerprint";
export { ErrorDeduplicator } from "./core/deduplicator";
export { RetryQueue } from "./core/queue";

// Export utilities
export {
  sanitizeHeaders,
  sanitizeQueryParams,
  sanitizeObject,
  truncateBody,
  safeParseBody,
} from "./core/utils/sanitize";
export {
  parseStackTrace,
  getFirstAppFrame,
  getAppFrames,
  formatStackFrames,
} from "./core/utils/stack-parser";

// Export types
export type {
  ErrorCaptureConfig,
  BugStackConfig,
  ResolvedConfig,
  CapturedError,
  StackFrame,
  ErrorReportPayload,
  SourceContext,
  NextRouteHandler,
  RouteContext,
  RouteOptions,
} from "./core/types";

// Note: Framework-specific adapters are exported via package.json subpath exports
// - @bugstack/sdk/next - Next.js adapter
// - @bugstack/sdk/express - Express adapter
// - @bugstack/sdk/generic - Generic Node.js adapter
