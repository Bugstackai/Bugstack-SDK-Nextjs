import type { CapturedError, SourceContext } from "./types";

/**
 * Queued error item
 */
interface QueuedError {
  /**
   * The error to send
   */
  error: CapturedError;

  /**
   * Source context (if available)
   */
  sourceContext?: SourceContext;

  /**
   * Number of send attempts
   */
  attempts: number;

  /**
   * Timestamp of last attempt
   */
  lastAttempt?: number;

  /**
   * Next retry timestamp
   */
  nextRetry: number;
}

/**
 * Function that sends an error to the service
 */
type SendFunction = (
  error: CapturedError,
  sourceContext?: SourceContext
) => Promise<boolean>;

/**
 * Retry queue with exponential backoff
 *
 * Handles failed error reports by queuing them and retrying with
 * exponentially increasing delays. Never blocks the host application.
 */
export class RetryQueue {
  /**
   * Queue of errors waiting to be sent
   */
  private queue: QueuedError[] = [];

  /**
   * Whether the queue is currently processing
   */
  private processing: boolean = false;

  /**
   * Maximum number of retry attempts
   */
  private maxRetries: number = 5;

  /**
   * Base backoff delay in milliseconds
   */
  private baseDelay: number = 1000; // 1 second

  /**
   * Maximum backoff delay in milliseconds
   */
  private maxDelay: number = 16000; // 16 seconds

  /**
   * Function to send errors
   */
  private sendFn: SendFunction;

  /**
   * Debug mode
   */
  private debug: boolean;

  /**
   * Processing interval ID
   */
  private intervalId?: NodeJS.Timeout;

  /**
   * Create a new retry queue
   *
   * @param sendFn - Function to send errors
   * @param options - Configuration options
   */
  constructor(
    sendFn: SendFunction,
    options?: {
      maxRetries?: number;
      baseDelay?: number;
      maxDelay?: number;
      debug?: boolean;
    }
  ) {
    this.sendFn = sendFn;
    this.maxRetries = options?.maxRetries ?? 5;
    this.baseDelay = options?.baseDelay ?? 1000;
    this.maxDelay = options?.maxDelay ?? 16000;
    this.debug = options?.debug ?? false;

    // Start processing queue periodically
    this.startProcessing();
  }

  /**
   * Enqueue an error for sending
   *
   * This is non-blocking and returns immediately.
   *
   * @param error - The error to send
   * @param sourceContext - Source context (optional)
   */
  enqueue(error: CapturedError, sourceContext?: SourceContext): void {
    const queuedError: QueuedError = {
      error,
      sourceContext,
      attempts: 0,
      nextRetry: Date.now(), // Send immediately on first attempt
    };

    this.queue.push(queuedError);
    this.log(`Enqueued error: ${error.id} (queue size: ${this.queue.length})`);

    // Trigger processing
    this.processQueue();
  }

  /**
   * Get the current queue size
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Clear all items from the queue
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Destroy the queue and stop processing
   */
  destroy(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.queue = [];
    this.processing = false;
  }

  /**
   * Start periodic queue processing
   */
  private startProcessing(): void {
    // Process queue every 500ms
    this.intervalId = setInterval(() => {
      this.processQueue();
    }, 500);

    // Ensure the interval doesn't prevent Node.js from exiting
    if (this.intervalId.unref) {
      this.intervalId.unref();
    }
  }

  /**
   * Process the queue
   *
   * This is called periodically and also immediately after enqueue.
   * Non-blocking - errors are caught and logged.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      const now = Date.now();

      // Find errors ready to be sent (nextRetry <= now)
      const readyErrors = this.queue.filter((item) => item.nextRetry <= now);

      if (readyErrors.length === 0) {
        return;
      }

      this.log(`Processing ${readyErrors.length} ready errors`);

      // Process each ready error
      for (const item of readyErrors) {
        await this.processItem(item);
      }
    } catch (err) {
      // Never let queue processing crash
      this.logError("Queue processing error:", err);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single queued error
   *
   * @param item - The queued error item
   */
  private async processItem(item: QueuedError): Promise<void> {
    try {
      item.attempts++;
      item.lastAttempt = Date.now();

      this.log(
        `Sending error ${item.error.id} (attempt ${item.attempts}/${this.maxRetries})`
      );

      // Try to send the error
      const success = await this.sendFn(item.error, item.sourceContext);

      if (success) {
        // Success - remove from queue
        this.log(`Successfully sent error: ${item.error.id}`);
        this.removeFromQueue(item);
      } else {
        // Failed - retry or give up
        this.handleFailure(item);
      }
    } catch (err) {
      // Error during send - retry or give up
      this.logError(`Error sending ${item.error.id}:`, err);
      this.handleFailure(item);
    }
  }

  /**
   * Handle a failed send attempt
   *
   * @param item - The queued error item
   */
  private handleFailure(item: QueuedError): void {
    if (item.attempts >= this.maxRetries) {
      // Max retries exceeded - give up
      this.logError(
        `Max retries exceeded for error ${item.error.id}, dropping`
      );
      this.removeFromQueue(item);
    } else {
      // Schedule retry with exponential backoff
      const delay = this.calculateBackoff(item.attempts);
      item.nextRetry = Date.now() + delay;

      this.log(
        `Scheduling retry for error ${item.error.id} in ${delay}ms (attempt ${item.attempts}/${this.maxRetries})`
      );
    }
  }

  /**
   * Calculate exponential backoff delay
   *
   * Backoff formula: min(baseDelay * 2^(attempts - 1), maxDelay)
   * - Attempt 1: 1s
   * - Attempt 2: 2s
   * - Attempt 3: 4s
   * - Attempt 4: 8s
   * - Attempt 5: 16s
   *
   * @param attempts - Number of attempts
   * @returns Delay in milliseconds
   */
  private calculateBackoff(attempts: number): number {
    const delay = this.baseDelay * Math.pow(2, attempts - 1);
    return Math.min(delay, this.maxDelay);
  }

  /**
   * Remove an item from the queue
   *
   * @param item - The item to remove
   */
  private removeFromQueue(item: QueuedError): void {
    const index = this.queue.indexOf(item);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  /**
   * Log a message (if debug mode is enabled)
   *
   * @param message - Message to log
   */
  private log(message: string): void {
    if (this.debug) {
      console.log(`[BugStack Queue] ${message}`);
    }
  }

  /**
   * Log an error (if debug mode is enabled)
   *
   * @param message - Message to log
   * @param error - Error object (optional)
   */
  private logError(message: string, error?: unknown): void {
    if (this.debug) {
      if (error) {
        console.error(`[BugStack Queue] ${message}`, error);
      } else {
        console.error(`[BugStack Queue] ${message}`);
      }
    }
  }

  /**
   * Get queue statistics (for debugging)
   */
  getStats(): {
    size: number;
    processing: boolean;
    items: Array<{
      errorId: string;
      attempts: number;
      nextRetry: number;
      timeUntilRetry: number;
    }>;
  } {
    const now = Date.now();

    return {
      size: this.queue.length,
      processing: this.processing,
      items: this.queue.map((item) => ({
        errorId: item.error.id,
        attempts: item.attempts,
        nextRetry: item.nextRetry,
        timeUntilRetry: Math.max(0, item.nextRetry - now),
      })),
    };
  }
}
