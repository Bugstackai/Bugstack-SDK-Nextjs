import type {
  ErrorCaptureConfig,
  ResolvedConfig,
  CapturedError,
  ErrorReportPayload,
  SourceContext,
} from "./types";
import { SDK_VERSION } from "./core/sdk-version";
const DEFAULT_ENDPOINT = "http://localhost:3001/api/capture";
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_MAX_BODY_SIZE = 10000;

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
 */
export class ErrorCaptureClient {
  private config: ResolvedConfig;
  private static instance: ErrorCaptureClient | null = null;

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
      debug: config.debug ?? !isProduction,
      shouldCapture: config.shouldCapture,
      beforeSend: config.beforeSend,
    };
  }

  /**
   * Initialize the singleton client instance
   */
  static init(config: ErrorCaptureConfig): ErrorCaptureClient {
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
    ErrorCaptureClient.instance = null;
  }

  /**
   * Report an error to the BugStack service
   */
  async reportError(
    error: CapturedError,
    sourceContext?: SourceContext
  ): Promise<boolean> {
    if (!this.config.enabled) {
      this.log("Error capture is disabled, skipping report");
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

    const payload: ErrorReportPayload = {
      error: {
        ...errorToSend,
        projectId: this.config.projectId || errorToSend.projectId,
        environment: this.config.environment,
        metadata: {
          ...this.config.metadata,
          ...errorToSend.metadata,
        },
      },
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
          `Failed to report error: HTTP ${response.status} ${response.statusText}`
        );
        return false;
      }

      this.log(`Error reported successfully: ${error.id}`);
      return true;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logError(`Error report timed out after ${this.config.timeout}ms`);
      } else {
        this.logError("Failed to send error report:", err);
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

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[BugStack] ${message}`);
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
