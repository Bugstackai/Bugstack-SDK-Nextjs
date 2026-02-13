/**
 * BugStack SDK Core
 *
 * Framework-agnostic error capture core
 */

// Client
export { ErrorCaptureClient, BugStackClient } from "./client";

// Fingerprinting and deduplication
export { generateErrorFingerprint, generateFingerprintFromParts } from "./fingerprint";
export { ErrorDeduplicator } from "./deduplicator";
export { RetryQueue } from "./queue";

// Utilities
export {
  sanitizeHeaders,
  sanitizeQueryParams,
  sanitizeObject,
  truncateBody,
  safeParseBody
} from "./utils/sanitize";
export {
  parseStackTrace,
  getFirstAppFrame,
  getAppFrames,
  formatStackFrames
} from "./utils/stack-parser";

// Types
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
} from "./types";
