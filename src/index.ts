/**
 * BugStack Error Capture SDK
 *
 * Framework-agnostic error capture with adapters for Next.js, Express, and more.
 *
 * @packageDocumentation
 */

// Export core functionality (framework-agnostic)
export { ErrorCaptureClient, BugStackClient, isChunkLoadError } from "./core/client";
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

// Re-export Next.js adapter convenience aliases so that
// `import { withBugStack } from 'bugstack-sdk'` works out of the box.
export { withErrorCapture, withBugStack } from "./adapters/nextjs/index";
