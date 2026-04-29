import type {
  ErrorCaptureConfig,
  ResolvedConfig,
  CapturedError,
  ErrorReportPayload,
  SourceContext,
} from "./types";
import { generateErrorFingerprint } from "./fingerprint";
import { ErrorDeduplicator } from "./deduplicator";
import { RetryQueue } from "./queue";

const SDK_VERSION = "0.2.0";
const DEFAULT_ENDPOINT = "http://localhost:3001/api/capture";
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_MAX_BODY_SIZE = 10000;
const DEFAULT_DEDUPLICATION_WINDOW = 5 * 60 * 1000; // 5 minutes

/**
 * Default sensitive fields to redact from requests
 */
const DEFAULT_REDACT_FIELDS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "apiKey",
  "authorization",
  "auth",
  "credential",
  "private",
  "credit_card",
  "creditcard",
  "card_number",
  "cvv",
  "ssn",
  "social_security",
];

/**
 * BugStack Error Capture Client
 *
 * Singleton client for capturing and reporting errors to the BugStack service.
 * Now includes client-side deduplication and retry queue with exponential backoff.
 */
export class ErrorCaptureClient {
  private config: ResolvedConfig;
  private static instance: ErrorCaptureClient | null = null;
  private deduplicator: ErrorDeduplicator;
  private retryQueue: RetryQueue;

  constructor(config: ErrorCaptureConfig) {
    const isProduction = process.env.NODE_ENV === "production";

    this.config = {
      apiKey: config.apiKey,
      endpoint:
        config.endpoint ??
        process.env.BUGSTACK_ENDPOINT ??
        DEFAULT_ENDPOINT,
      projectId: config.projectId ?? process.env.BUGSTACK_PROJECT_ID ?? "",
      environment:
        config.environment ?? process.env.NODE_ENV ?? "development",
      autoFix: config.autoFix ?? false,
      enabled: config.enabled ?? true,
      captureRequestBody: config.captureRequestBody ?? false,
      captureQueryParams: config.captureQueryParams ?? true,
      captureHeaders: config.captureHeaders ?? true,
      maxBodySize: config.maxBodySize ?? DEFAULT_MAX_BODY_SIZE,
      redactFields: [
        ...DEFAULT_REDACT_FIELDS,
        ...(config.redactFields ?? []),
      ],
      metadata: config.metadata ?? {},
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      deduplicationWindow:
        config.deduplicationWindow ?? DEFAULT_DEDUPLICATION_WINDOW,
      debug: config.debug ?? !isProduction,
      shouldCapture: config.shouldCapture,
      beforeSend: config.beforeSend,
      dropChunkErrors: config.dropChunkErrors ?? true,
    };

    // Initialize deduplicator
    this.deduplicator = new ErrorDeduplicator(this.config.deduplicationWindow);

    // Initialize retry queue with send function bound to this instance
    this.retryQueue = new RetryQueue(
      (error, sourceContext) => this.sendErrorToService(error, sourceContext),
      {
        maxRetries: 5,
        baseDelay: 1000,
        maxDelay: 16000,
        debug: this.config.debug,
      }
    );

    this.log("BugStack client initialized", {
      endpoint: this.config.endpoint,
      projectId: this.config.projectId,
      environment: this.config.environment,
      autoFix: this.config.autoFix,
      deduplicationWindow: this.config.deduplicationWindow,
    });
  }

  /**
   * Initialize the singleton client instance
   */
  static init(config: ErrorCaptureConfig): ErrorCaptureClient {
    // Clean up existing instance if present
    if (ErrorCaptureClient.instance) {
      ErrorCaptureClient.instance.destroy();
    }

    ErrorCaptureClient.instance = new ErrorCaptureClient(config);
    return ErrorCaptureClient.instance;
  }

  /**
   * Get the singleton client instance
   */
  static getInstance(): ErrorCaptureClient | null {
    return ErrorCaptureClient.instance;
  }

  /**
   * Check if the client has been initialized
   */
  static isInitialized(): boolean {
    return ErrorCaptureClient.instance !== null;
  }

  /**
   * Reset the client (mainly for testing)
   */
  static reset(): void {
    if (ErrorCaptureClient.instance) {
      ErrorCaptureClient.instance.destroy();
    }
    ErrorCaptureClient.instance = null;
  }

  /**
   * Report an error to the BugStack service
   *
   * This method includes deduplication and queuing for resilience.
   *
   * @param error - The captured error
   * @param sourceContext - Source code context (optional)
   * @returns Promise that resolves to true if error was accepted (not deduplicated)
   */
  async reportError(
    error: CapturedError,
    sourceContext?: SourceContext
  ): Promise<boolean> {
    if (!this.config.enabled) {
      this.log("Error capture is disabled, skipping report");
      return false;
    }

    // Default-drop chunk-load errors. They're stale-tab artifacts, not bugs,
    // and they have no source frames the orchestrator could ever fix.
    if (this.config.dropChunkErrors && isChunkLoadError(error)) {
      this.log(`Dropped chunk-load error: ${error.message}`);
      return false;
    }

    // Apply beforeSend hook if provided
    let errorToSend = error;
    if (this.config.beforeSend) {
      const modified = this.config.beforeSend(error);
      if (modified === null) {
        this.log("Error filtered by beforeSend hook");
        return false;
      }
      errorToSend = modified;
    }

    // Generate fingerprint for deduplication
    const fingerprint = generateErrorFingerprint(errorToSend);
    errorToSend.fingerprint = fingerprint;

    // Check deduplication
    if (!this.deduplicator.shouldSend(fingerprint)) {
      this.log(`Error deduplicated: ${error.id} (fingerprint: ${fingerprint})`);
      return false;
    }

    this.log(`Reporting error: ${error.id} (fingerprint: ${fingerprint})`);

    // Add project metadata
    errorToSend.projectId = this.config.projectId || errorToSend.projectId;
    errorToSend.environment = this.config.environment;
    errorToSend.metadata = {
      ...this.config.metadata,
      ...errorToSend.metadata,
      autoFix: this.config.autoFix,
    };

    // Enqueue for sending (non-blocking)
    this.retryQueue.enqueue(errorToSend, sourceContext);

    return true;
  }

  /**
   * Send an error to the service (internal method)
   *
   * This is used by the retry queue. Returns true on success, false on failure.
   *
   * @param error - The error to send
   * @param sourceContext - Source context (optional)
   * @returns Promise that resolves to true on success
   */
  private async sendErrorToService(
    error: CapturedError,
    sourceContext?: SourceContext
  ): Promise<boolean> {
    const payload: ErrorReportPayload = {
      error,
      sourceContext,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeout
      );

      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BugStack-API-Key": this.config.apiKey,
          "X-BugStack-SDK-Version": SDK_VERSION,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.logError(
          `Failed to send error: HTTP ${response.status} ${response.statusText}`
        );
        return false;
      }

      this.log(`Error sent successfully: ${error.id}`);
      return true;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logError(`Error send timed out after ${this.config.timeout}ms`);
      } else {
        this.logError("Failed to send error:", err);
      }
      return false;
    }
  }

  /**
   * Get the resolved configuration
   */
  getConfig(): ResolvedConfig {
    return { ...this.config };
  }

  /**
   * Check if a field should be redacted
   */
  shouldRedact(fieldName: string): boolean {
    const lowerField = fieldName.toLowerCase();
    return this.config.redactFields.some(
      (redact) =>
        lowerField.includes(redact.toLowerCase()) ||
        redact.toLowerCase().includes(lowerField)
    );
  }

  /**
   * Get the SDK version
   */
  static getVersion(): string {
    return SDK_VERSION;
  }

  /**
   * Get client statistics (for debugging)
   */
  getStats(): {
    deduplicator: ReturnType<ErrorDeduplicator["getStats"]>;
    retryQueue: ReturnType<RetryQueue["getStats"]>;
  } {
    return {
      deduplicator: this.deduplicator.getStats(),
      retryQueue: this.retryQueue.getStats(),
    };
  }

  /**
   * Clean up resources
   *
   * Should be called when shutting down to prevent memory leaks
   */
  destroy(): void {
    this.deduplicator.destroy();
    this.retryQueue.destroy();
  }

  private log(message: string, data?: Record<string, unknown>): void {
    if (this.config.debug) {
      if (data) {
        console.log(`[BugStack] ${message}`, data);
      } else {
        console.log(`[BugStack] ${message}`);
      }
    }
  }

  private logError(message: string, error?: unknown): void {
    if (this.config.debug) {
      if (error) {
        console.error(`[BugStack] ${message}`, error);
      } else {
        console.error(`[BugStack] ${message}`);
      }
    }
  }
}

// Legacy alias for backwards compatibility
export const BugStackClient = ErrorCaptureClient;

/**
 * Recognise the family of "browser failed to load a code-split chunk" errors.
 * Webpack and Vite emit slightly different messages; the regex covers both.
 *
 * Exported (via re-export from index.ts) so callers can reuse the same check
 * in their own error boundaries when deciding whether to soft-reload.
 */
export function isChunkLoadError(
  error: { name?: string; message?: string }
): boolean {
  if (!error) return false;
  if (error.name === "ChunkLoadError") return true;
  const msg = error.message || "";
  return (
    /Loading chunk\s+[\w-]+\s+failed/i.test(msg) ||
    /Loading CSS chunk\s+[\w-]+\s+failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  );
}
