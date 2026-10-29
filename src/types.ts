import type { NextRequest } from "next/server";

/**
 * Configuration options for the BugStack error capture SDK
 */
export interface ErrorCaptureConfig {
  /**
   * API key for authenticating with the BugStack error service
   */
  apiKey: string;

  /**
   * URL of the BugStack error service endpoint
   * @default process.env.BUGSTACK_ENDPOINT || "https://dashboard.bugstack.ai/api/ingest/sdk"
   */
  endpoint?: string;

  /**
   * Unique identifier for your project
   */
  projectId?: string;

  /**
   * Environment name (e.g., "production", "staging", "development")
   * @default process.env.NODE_ENV || "development"
   */
  environment?: string;

  /**
   * Enable or disable error capture
   * Useful for disabling in certain environments
   * @default true
   */
  enabled?: boolean;

  /**
   * Whether to capture request body in error reports
   * @default true
   */
  captureRequestBody?: boolean;

  /**
   * Whether to capture query parameters in error reports
   * @default true
   */
  captureQueryParams?: boolean;

  /**
   * Whether to capture request headers in error reports
   * @default true
   */
  captureHeaders?: boolean;

  /**
   * Maximum size of request body to capture (in bytes)
   * Bodies larger than this will be truncated
   * @default 10000 (10KB)
   */
  maxBodySize?: number;

  /**
   * Additional fields to redact from request body and headers
   * Common sensitive fields are redacted by default
   */
  redactFields?: string[];

  /**
   * Custom metadata to include with every error report
   */
  metadata?: Record<string, unknown>;

  /**
   * Timeout for sending error reports (in milliseconds)
   * @default 5000
   */
  timeout?: number;

  /**
   * Whether to log SDK errors to console
   * @default true in development, false in production
   */
  debug?: boolean;

  /**
   * Custom error filter function
   * Return false to skip reporting certain errors
   */
  shouldCapture?: (error: Error, request: NextRequest) => boolean;

  /**
   * Hook called before sending error report
   * Can be used to modify or enrich error data
   */
  beforeSend?: (error: CapturedError) => CapturedError | null;
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  projectId: string;
  environment: string;
  enabled: boolean;
  captureRequestBody: boolean;
  captureQueryParams: boolean;
  captureHeaders: boolean;
  maxBodySize: number;
  redactFields: string[];
  metadata: Record<string, unknown>;
  timeout: number;
  debug: boolean;
  shouldCapture?: (error: Error, request: NextRequest) => boolean;
  beforeSend?: (error: CapturedError) => CapturedError | null;
}

/**
 * Captured error data sent to the error service
 */
export interface CapturedError {
  /**
   * Unique identifier for this error instance
   */
  id: string;

  /**
   * Error message
   */
  message: string;

  /**
   * Error name/type (e.g., "TypeError", "ReferenceError")
   */
  name: string;

  /**
   * Full stack trace
   */
  stack?: string;

  /**
   * Parsed stack frames for easier analysis
   */
  stackFrames?: StackFrame[];

  /**
   * ISO 8601 timestamp when the error occurred
   */
  timestamp: string;

  /**
   * API route path (e.g., "/api/users/[id]")
   */
  route: string;

  /**
   * HTTP method (GET, POST, etc.)
   */
  method: string;

  /**
   * HTTP status code
   * @default 500
   */
  statusCode: number;

  /**
   * Full request URL
   */
  url: string;

  /**
   * Query parameters (sanitized)
   */
  queryParams?: Record<string, string>;

  /**
   * Request body (sanitized and truncated)
   */
  requestBody?: unknown;

  /**
   * Request headers (sanitized)
   */
  requestHeaders?: Record<string, string>;

  /**
   * Environment (production, staging, development)
   */
  environment: string;

  /**
   * Project identifier
   */
  projectId?: string;

  /**
   * Route parameters (e.g., { id: "123" })
   */
  routeParams?: Record<string, string>;

  /**
   * Additional custom metadata
   */
  metadata?: Record<string, unknown>;

  /**
   * SDK version that captured this error
   */
  sdkVersion: string;

  /**
   * Node.js version
   */
  nodeVersion: string;

  /**
   * Next.js version (if available)
   */
  nextVersion?: string;
}

/**
 * Parsed stack frame for easier debugging
 */
export interface StackFrame {
  /**
   * Function name
   */
  function?: string;

  /**
   * File path
   */
  file?: string;

  /**
   * Line number
   */
  line?: number;

  /**
   * Column number
   */
  column?: number;

  /**
   * Whether this frame is from node_modules
   */
  isNodeModule?: boolean;

  /**
   * Whether this frame is from internal Node.js code
   */
  isInternal?: boolean;
}

/**
 * Payload sent to the error service
 */
export interface ErrorReportPayload {
  /**
   * The captured error data
   */
  error: CapturedError;

  /**
   * Source code context around the error (if available)
   */
  sourceContext?: SourceContext;
}

/**
 * Source code context around the error location
 */
export interface SourceContext {
  /**
   * File path
   */
  filePath: string;

  /**
   * Line number where error occurred
   */
  lineNumber: number;

  /**
   * Lines of code before the error line
   */
  preContext: string[];

  /**
   * The line where the error occurred
   */
  contextLine: string;

  /**
   * Lines of code after the error line
   */
  postContext: string[];
}

/**
 * Next.js App Router route handler type
 */
export type NextRouteHandler<T = unknown> = (
  request: NextRequest,
  context: RouteContext<T>
) => Response | Promise<Response>;

/**
 * Route context passed to Next.js handlers
 */
export interface RouteContext<T = unknown> {
  params: T extends Record<string, string> ? T : Record<string, string>;
}

/**
 * Options that can be passed to withErrorCapture per-route
 */
export interface RouteOptions {
  /**
   * Override the status code reported for errors in this route
   */
  statusCode?: number;

  /**
   * Additional metadata specific to this route
   */
  metadata?: Record<string, unknown>;

  /**
   * Custom error filter for this route
   */
  shouldCapture?: (error: Error) => boolean;
}

// Legacy type aliases for backwards compatibility
export type BugStackConfig = ErrorCaptureConfig;
