import type { CapturedError } from "./types";

/**
 * Generate a stable fingerprint (hash) for an error
 *
 * The fingerprint is used for deduplication - same errors should produce
 * the same fingerprint. This is based on:
 * - Error type/name
 * - Route where error occurred
 * - First line of stack trace (usually the line that caused the error)
 *
 * @param error - The captured error object
 * @returns A hex string fingerprint
 */
export function generateErrorFingerprint(error: CapturedError): string {
  // Build a stable key from error properties
  const errorType = error.name || "Error";
  const route = error.route || "unknown";
  const stackFirstLine = getStackFirstLine(error.stack);

  const key = `${errorType}:${route}:${stackFirstLine}`;

  // Generate a simple hash
  return simpleHash(key);
}

/**
 * Extract the first meaningful line from a stack trace
 * This is usually the line where the error actually occurred
 *
 * @param stack - The stack trace string
 * @returns First line of stack or "unknown"
 */
function getStackFirstLine(stack?: string): string {
  if (!stack) return "unknown";

  const lines = stack.split("\n");

  // Find first line that looks like a stack frame
  // (starts with "at " in V8 stack traces)
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("at ")) {
      return trimmed;
    }
  }

  // Fallback: use first non-empty line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "unknown";
}

/**
 * Simple string hash function
 *
 * This is a basic implementation of the DJB2 hash algorithm.
 * It's not cryptographically secure, but it's fast and produces
 * reasonably distributed hashes for our use case.
 *
 * @param str - String to hash
 * @returns Hex string hash
 */
function simpleHash(str: string): string {
  let hash = 5381;

  for (let i = 0; i < str.length; i++) {
    // hash * 33 + char
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Convert to unsigned 32-bit integer and then to hex
  const unsignedHash = hash >>> 0;
  return unsignedHash.toString(16).padStart(8, "0");
}

/**
 * Generate a fingerprint from error-like object
 *
 * This is a convenience function for generating fingerprints from
 * minimal error information (e.g., during server-side processing)
 *
 * @param errorName - Error type/name
 * @param route - Route where error occurred
 * @param stack - Stack trace
 * @returns Hex string fingerprint
 */
export function generateFingerprintFromParts(
  errorName: string,
  route: string,
  stack?: string
): string {
  const stackFirstLine = getStackFirstLine(stack);
  const key = `${errorName}:${route}:${stackFirstLine}`;
  return simpleHash(key);
}
