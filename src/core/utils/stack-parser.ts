import type { StackFrame } from "../types";

/**
 * Regular expression to parse V8 stack trace frames
 * Handles formats like:
 *   at functionName (file:line:column)
 *   at file:line:column
 *   at async functionName (file:line:column)
 */
const V8_STACK_FRAME_REGEX =
  /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+))\)?$/;

/**
 * Check if a file path is from node_modules
 */
function isNodeModule(filePath: string): boolean {
  return filePath.includes("node_modules");
}

/**
 * Check if a file path is internal Node.js code
 */
function isInternalCode(filePath: string): boolean {
  return (
    filePath.startsWith("node:") ||
    filePath.startsWith("internal/") ||
    !filePath.includes("/")
  );
}

/**
 * Clean up function names
 */
function cleanFunctionName(name: string | undefined): string | undefined {
  if (!name) return undefined;

  // Remove common prefixes
  return name
    .replace(/^Object\./, "")
    .replace(/^Module\./, "")
    .replace(/^__webpack_require__\./, "")
    .replace(/^webpack_require\./, "")
    .trim();
}

/**
 * Parse a V8 stack trace into structured frames
 */
export function parseStackTrace(stack: string | undefined): StackFrame[] {
  if (!stack) return [];

  const lines = stack.split("\n");
  const frames: StackFrame[] = [];

  for (const line of lines) {
    const match = V8_STACK_FRAME_REGEX.exec(line);

    if (match) {
      const [, functionName, file, lineStr, columnStr] = match;

      const frame: StackFrame = {
        function: cleanFunctionName(functionName),
        file: file ?? undefined,
        line: lineStr ? parseInt(lineStr, 10) : undefined,
        column: columnStr ? parseInt(columnStr, 10) : undefined,
      };

      if (frame.file) {
        frame.isNodeModule = isNodeModule(frame.file);
        frame.isInternal = isInternalCode(frame.file);
      }

      frames.push(frame);
    }
  }

  return frames;
}

/**
 * Get the first application frame (non-node_modules, non-internal)
 */
export function getFirstAppFrame(frames: StackFrame[]): StackFrame | undefined {
  return frames.find((frame) => !frame.isNodeModule && !frame.isInternal);
}

/**
 * Filter stack frames to only include application code
 */
export function getAppFrames(frames: StackFrame[]): StackFrame[] {
  return frames.filter((frame) => !frame.isNodeModule && !frame.isInternal);
}

/**
 * Format stack frames back to a string (useful for cleaned stack traces)
 */
export function formatStackFrames(frames: StackFrame[]): string {
  return frames
    .map((frame) => {
      const location = [frame.file, frame.line, frame.column]
        .filter(Boolean)
        .join(":");

      if (frame.function) {
        return `    at ${frame.function} (${location})`;
      }
      return `    at ${location}`;
    })
    .join("\n");
}
