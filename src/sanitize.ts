import { ErrorCaptureClient } from "./client";

const REDACT_PLACEHOLDER = "[REDACTED]";
const TRUNCATE_PLACEHOLDER = "[TRUNCATED]";

/**
 * Sensitive headers that are always redacted
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-bugstack-api-key",
  "proxy-authorization",
  "www-authenticate",
]);

/**
 * Sanitize headers by removing sensitive values
 */
export function sanitizeHeaders(
  headers: Headers,
  client?: ErrorCaptureClient | null
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();

    // Always redact known sensitive headers
    if (SENSITIVE_HEADERS.has(lowerKey)) {
      sanitized[key] = REDACT_PLACEHOLDER;
      return;
    }

    // Check against custom redact fields
    if (client?.shouldRedact(key)) {
      sanitized[key] = REDACT_PLACEHOLDER;
      return;
    }

    sanitized[key] = value;
  });

  return sanitized;
}

/**
 * Sanitize query parameters by redacting sensitive values
 */
export function sanitizeQueryParams(
  url: URL,
  client?: ErrorCaptureClient | null
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  url.searchParams.forEach((value, key) => {
    if (client?.shouldRedact(key)) {
      sanitized[key] = REDACT_PLACEHOLDER;
    } else {
      sanitized[key] = value;
    }
  });

  return sanitized;
}

/**
 * Recursively sanitize an object by redacting sensitive fields
 */
export function sanitizeObject(
  obj: unknown,
  client?: ErrorCaptureClient | null,
  maxDepth = 10,
  currentDepth = 0
): unknown {
  // Prevent infinite recursion
  if (currentDepth > maxDepth) {
    return TRUNCATE_PLACEHOLDER;
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) =>
      sanitizeObject(item, client, maxDepth, currentDepth + 1)
    );
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (client?.shouldRedact(key)) {
      sanitized[key] = REDACT_PLACEHOLDER;
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeObject(value, client, maxDepth, currentDepth + 1);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Truncate a string or object to a maximum size
 */
export function truncateBody(
  data: unknown,
  maxSize: number
): { body: unknown; truncated: boolean } {
  const serialized = JSON.stringify(data);

  if (serialized.length <= maxSize) {
    return { body: data, truncated: false };
  }

  // For strings, truncate directly
  if (typeof data === "string") {
    return {
      body: data.slice(0, maxSize) + `... ${TRUNCATE_PLACEHOLDER}`,
      truncated: true,
    };
  }

  // For objects, try to preserve structure but indicate truncation
  return {
    body: {
      __truncated: true,
      __originalSize: serialized.length,
      __maxSize: maxSize,
      preview: serialized.slice(0, maxSize),
    },
    truncated: true,
  };
}

/**
 * Safely parse request body with error handling
 */
export async function safeParseBody(
  request: Request,
  maxSize: number,
  client?: ErrorCaptureClient | null
): Promise<{ body: unknown; truncated: boolean } | null> {
  try {
    // Clone the request to avoid consuming the body
    const cloned = request.clone();
    const contentType = cloned.headers.get("content-type") ?? "";

    // Handle JSON bodies
    if (contentType.includes("application/json")) {
      const text = await cloned.text();

      if (text.length > maxSize) {
        return {
          body: {
            __truncated: true,
            __originalSize: text.length,
            preview: text.slice(0, maxSize),
          },
          truncated: true,
        };
      }

      try {
        const parsed = JSON.parse(text);
        const sanitized = sanitizeObject(parsed, client);
        return truncateBody(sanitized, maxSize);
      } catch {
        // Not valid JSON, return as text
        return truncateBody(text, maxSize);
      }
    }

    // Handle form data
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      try {
        const formData = await cloned.formData();
        const data: Record<string, unknown> = {};

        formData.forEach((value, key) => {
          if (value instanceof File) {
            data[key] = {
              type: "file",
              name: value.name,
              size: value.size,
              mimeType: value.type,
            };
          } else if (client?.shouldRedact(key)) {
            data[key] = REDACT_PLACEHOLDER;
          } else {
            data[key] = value;
          }
        });

        return truncateBody(data, maxSize);
      } catch {
        return { body: "[FormData parsing failed]", truncated: false };
      }
    }

    // Handle text bodies
    if (contentType.includes("text/")) {
      const text = await cloned.text();
      return truncateBody(text, maxSize);
    }

    // For other content types, just note the type
    return {
      body: {
        __contentType: contentType,
        __note: "Body not captured for this content type",
      },
      truncated: false,
    };
  } catch (err) {
    // Body may have already been consumed or other error
    return null;
  }
}
