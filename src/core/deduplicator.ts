/**
 * Client-side error deduplicator
 *
 * Prevents the same error (identified by fingerprint) from being sent
 * multiple times within a configurable time window. This helps avoid
 * flooding the BugStack service with duplicate errors.
 */
export class ErrorDeduplicator {
  /**
   * Cache of fingerprint → timestamp mapping
   * Key: error fingerprint (hex string)
   * Value: timestamp (ms) when error was last sent
   */
  private cache: Map<string, number>;

  /**
   * Time window in milliseconds
   * Errors with the same fingerprint within this window are considered duplicates
   */
  private window: number;

  /**
   * Interval ID for cleanup task
   */
  private cleanupIntervalId?: NodeJS.Timeout;

  /**
   * Create a new deduplicator
   *
   * @param window - Deduplication window in milliseconds (default: 5 minutes)
   */
  constructor(window: number = 5 * 60 * 1000) {
    this.cache = new Map();
    this.window = window;

    // Start automatic cleanup every minute
    this.startCleanup();
  }

  /**
   * Check if an error should be sent
   *
   * @param fingerprint - Error fingerprint
   * @returns true if error should be sent, false if it's a duplicate
   */
  shouldSend(fingerprint: string): boolean {
    const now = Date.now();
    const lastSent = this.cache.get(fingerprint);

    if (lastSent !== undefined) {
      const elapsed = now - lastSent;

      // If error was sent within the window, it's a duplicate
      if (elapsed < this.window) {
        return false;
      }
    }

    // Mark this fingerprint as sent
    this.cache.set(fingerprint, now);
    return true;
  }

  /**
   * Mark an error as sent (manually)
   *
   * This can be used to pre-populate the cache or update the timestamp
   * after a successful send.
   *
   * @param fingerprint - Error fingerprint
   */
  markSent(fingerprint: string): void {
    this.cache.set(fingerprint, Date.now());
  }

  /**
   * Check if an error fingerprint is in the cache
   *
   * @param fingerprint - Error fingerprint
   * @returns true if fingerprint exists and is within the window
   */
  has(fingerprint: string): boolean {
    const lastSent = this.cache.get(fingerprint);
    if (lastSent === undefined) {
      return false;
    }

    const elapsed = Date.now() - lastSent;
    return elapsed < this.window;
  }

  /**
   * Get the number of entries in the cache
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Remove expired entries from the cache
   *
   * This is called automatically every minute, but can also be
   * called manually to free up memory.
   */
  cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    // Find expired entries
    for (const [fingerprint, timestamp] of this.cache.entries()) {
      const elapsed = now - timestamp;
      if (elapsed >= this.window) {
        toDelete.push(fingerprint);
      }
    }

    // Delete expired entries
    for (const fingerprint of toDelete) {
      this.cache.delete(fingerprint);
    }
  }

  /**
   * Start automatic cleanup task
   *
   * Runs cleanup every minute to remove expired entries
   */
  private startCleanup(): void {
    // Run cleanup every minute
    this.cleanupIntervalId = setInterval(() => {
      this.cleanup();
    }, 60 * 1000);

    // Ensure the interval doesn't prevent Node.js from exiting
    if (this.cleanupIntervalId.unref) {
      this.cleanupIntervalId.unref();
    }
  }

  /**
   * Stop automatic cleanup task
   *
   * This should be called when shutting down to prevent memory leaks
   */
  destroy(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
    this.cache.clear();
  }

  /**
   * Get cache statistics (for debugging)
   */
  getStats(): {
    size: number;
    window: number;
    entries: Array<{ fingerprint: string; age: number }>;
  } {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([fingerprint, timestamp]) => ({
      fingerprint,
      age: now - timestamp,
    }));

    return {
      size: this.cache.size,
      window: this.window,
      entries,
    };
  }
}
