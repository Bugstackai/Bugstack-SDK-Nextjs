/**
 * Caught-and-logged errors reach Bugstack.
 *
 * A `catch` that writes `console.error("[billing] grant failed", err)` and
 * carries on is the commonest way an application handles a failure, and a log
 * line is something nobody reads. Uncaught-exception handlers never see these
 * errors because nothing re-throws them. On Bugstack's own repository, 12 of 16
 * loud bugs it missed in one month were errors caught, logged and carried on
 * from.
 *
 * This module forwards them through the same client every other capture path
 * uses (`ErrorCaptureClient.reportError`), so they get the same `beforeSend`,
 * the same fingerprint dedup and the same transport. Three sources feed it:
 *
 *   - `console.error`, wrapped once per process when a client is initialised
 *     (on by default; `captureConsoleErrors: false` turns it off);
 *   - pino, through `bugstackPinoHooks()` (error and fatal);
 *   - winston, through `bugstackWinstonFormat()` (error and above).
 *
 * Rules, each tested in test/logged-errors.test.ts:
 *
 *   - THE CONSOLE LINE IS WRITTEN EXACTLY AS BEFORE, first, with the same
 *     arguments and `this`. Forwarding happens after, and never throws.
 *   - WHAT IS FORWARDED: a call carrying an Error (as an argument, or as the
 *     `err` / `error` field of an object argument, the pino shape), or a string
 *     holding a stack trace (`console.error("failed", err.stack)`). A plain
 *     message with neither is noise by default and stays a console line;
 *     `{ messages: true }` forwards it too, as its text.
 *   - NOT FORWARDED, counted per rule in `loggedErrorStats()`: the SDK's own
 *     `[BugStack…]` lines, Node's process warnings (`(node:1) [DEP0169]
 *     DeprecationWarning: …`, which Node writes through console.error), lines
 *     matching `ignore`, an error an adapter already reported
 *     (`markErrorReported`), the same site and message again within
 *     `repeatWindowMs`, and anything past `maxPerMinute`.
 *   - ANCHORED AT THE LOGGING SITE. The fingerprint is error type + route +
 *     first stack frame. A driver error has the same first frame wherever it
 *     was caught, so the report is a new `LoggedError` whose stack starts at
 *     the line that logged it. The original rides along as `cause` and, as
 *     `causeName` / `causeStack`, in metadata.
 *   - NEVER TWICE. Forwarding is deferred one macrotask, so a catch that logs
 *     and then calls `captureError` in the same tick sends once.
 *   - NEVER LOOPS. A console.error raised while reporting (by `beforeSend`, or
 *     by the SDK's own debug logging) is written and not forwarded.
 *   - REDACTED. The text of a logged line goes through the client's
 *     `redactFields` (`password=…`, `token: …`) and `Bearer …` is masked.
 *     Only message text and stacks are sent, never the other log arguments.
 *
 * State lives on `globalThis` under a registered symbol: each package entry
 * point (`bugstack-sdk`, `bugstack-sdk/generic`, …) is bundled on its own, and
 * there must still be one console wrap and one "already reported" set per
 * process.
 */

import type { CapturedError } from "./types";
import { parseStackTrace, getFirstAppFrame } from "./utils/stack-parser";
import { SDK_VERSION } from "./sdk-version";

/** Options for `captureConsoleErrors`. Every field is optional. */
export interface LoggedErrorOptions {
  /**
   * Also forward a console.error (or logger error) that carries no Error and
   * no stack trace, as its message text. Off by default: many libraries write
   * plain lines through console.error that are not failures of your app.
   * @default false
   */
  messages?: boolean;
  /**
   * At most this many logged errors are forwarded per minute, per process.
   * @default 20
   */
  maxPerMinute?: number;
  /**
   * The same logging site with the same message is forwarded at most once per
   * this window (milliseconds). A message-only line repeats per site alone,
   * because its text usually carries ids.
   * @default 300000 (5 minutes)
   */
  repeatWindowMs?: number;
  /**
   * Lines whose text matches any of these stay console lines.
   */
  ignore?: Array<string | RegExp>;
}

/** Where a logged error came from. */
export type LoggedErrorSource = "console-error" | "pino" | "winston";

/** Why a logged error was not forwarded, counted per rule. */
export type LoggedErrorDropRule =
  | "no_error_argument"
  | "sdk_line"
  | "node_warning"
  | "ignored"
  | "already_reported"
  | "repeat"
  | "rate_limited"
  | "no_client";

export interface ResolvedLoggedErrorOptions {
  console: boolean;
  messages: boolean;
  maxPerMinute: number;
  repeatWindowMs: number;
  ignore: Array<string | RegExp>;
}

export const DEFAULT_MAX_PER_MINUTE = 20;
export const DEFAULT_REPEAT_WINDOW_MS = 5 * 60_000;
const MAX_REMEMBERED = 500;
const MESSAGE_MAX = 300;
const ANCHORED_MESSAGE_MAX = 500;
const CAUSE_STACK_MAX = 2000;

/** Resolve the `captureConsoleErrors` config value. */
export function resolveLoggedErrorOptions(
  value: boolean | LoggedErrorOptions | undefined,
): ResolvedLoggedErrorOptions {
  const opts = typeof value === "object" && value !== null ? value : {};
  return {
    console: value !== false,
    messages: opts.messages ?? false,
    maxPerMinute: opts.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE,
    repeatWindowMs: opts.repeatWindowMs ?? DEFAULT_REPEAT_WINDOW_MS,
    ignore: opts.ignore ?? [],
  };
}

/**
 * What a client hands this module: its config, its redaction rule and its
 * report function. Structural, so this module never imports the client.
 */
export interface LoggedErrorSink {
  options: ResolvedLoggedErrorOptions;
  environment: string;
  projectId: string;
  redactFields: string[];
  report: (error: CapturedError) => unknown;
}

type Stats = {
  forwarded: number;
  messageOnly: number;
  dropped: Record<LoggedErrorDropRule, number>;
};

type Shared = {
  reported: WeakSet<object>;
  sink: LoggedErrorSink | null;
  consoleOriginal: ((...args: unknown[]) => void) | null;
  consoleWrapper: ((...args: unknown[]) => void) | null;
  busy: boolean;
  windowStart: number;
  inWindow: number;
  lastSent: Map<string, number>;
  stats: Stats;
  now: () => number;
};

const SHARED_KEY = Symbol.for("bugstack-sdk.logged-errors");

function emptyStats(): Stats {
  return {
    forwarded: 0,
    messageOnly: 0,
    dropped: {
      no_error_argument: 0,
      sdk_line: 0,
      node_warning: 0,
      ignored: 0,
      already_reported: 0,
      repeat: 0,
      rate_limited: 0,
      no_client: 0,
    },
  };
}

function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  let s = g[SHARED_KEY];
  if (!s) {
    s = {
      reported: new WeakSet(),
      sink: null,
      consoleOriginal: null,
      consoleWrapper: null,
      busy: false,
      windowStart: 0,
      inWindow: 0,
      lastSent: new Map(),
      stats: emptyStats(),
      now: Date.now,
    };
    g[SHARED_KEY] = s;
  }
  return s;
}

const defer: (fn: () => void) => void =
  typeof setImmediate === "function" ? (fn) => void setImmediate(fn) : (fn) => void setTimeout(fn, 0);

/**
 * Say this error was already sent to Bugstack, so a console line or logger
 * call for the same error object is not sent again. The SDK's adapters call
 * it; call it yourself if you report an error through your own wrapper.
 */
export function markErrorReported(error: unknown): void {
  try {
    if (error !== null && typeof error === "object") shared().reported.add(error);
  } catch {
    /* never throws */
  }
}

/** Forwarded and dropped counts since the process started, dropped counted per rule. */
export function loggedErrorStats(): {
  consoleInstalled: boolean;
  forwarded: number;
  messageOnly: number;
  dropped: Record<LoggedErrorDropRule, number>;
} {
  const s = shared();
  return {
    consoleInstalled: s.consoleWrapper !== null && s.sink !== null && s.sink.options.console,
    forwarded: s.stats.forwarded,
    messageOnly: s.stats.messageOnly,
    dropped: { ...s.stats.dropped },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isError(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (value === null || typeof value !== "object") return false;
  try {
    const v = value as { message?: unknown; stack?: unknown };
    return typeof v.message === "string" && typeof v.stack === "string";
  } catch {
    return false;
  }
}

/** The Error in a log call: an argument, or an `err` / `error` field of an object argument. */
export function findError(args: readonly unknown[]): Error | undefined {
  for (const a of args) if (isError(a)) return a;
  for (const a of args) {
    if (a === null || typeof a !== "object" || Array.isArray(a)) continue;
    try {
      const o = a as Record<string, unknown>;
      for (const k of ["err", "error", "cause"]) if (isError(o[k])) return o[k] as Error;
    } catch {
      /* a getter that throws is not an error to report */
    }
  }
  return undefined;
}

/** A stack trace as text: an `XxxError: …` header line followed by an `at …` frame. */
const STACK_TEXT = /(^|\n)\s*([A-Za-z_$][\w$.]*(?:Error|Exception)\b[^\n]*)\n\s+at \S/;

/** An Error rebuilt from a string holding a stack trace, or undefined. */
export function findStackText(args: readonly unknown[]): Error | undefined {
  for (const a of args) {
    if (typeof a !== "string") continue;
    const m = STACK_TEXT.exec(a);
    if (!m) continue;
    const header = m[2]!.trim();
    const colon = header.indexOf(":");
    const err = new Error(colon > 0 ? header.slice(colon + 1).trim() : header);
    err.name = colon > 0 ? header.slice(0, colon).trim() : "Error";
    err.stack = a.slice(m.index + m[1]!.length).trim();
    return err;
  }
  return undefined;
}

/**
 * The text of a log call: its strings, numbers and booleans, plus an
 * `error` / `message` / `reason` / `err` / `msg` string field of an object
 * argument (the `{ error: err.message }` shape). Empty when there is nothing
 * to say.
 */
export function messageOfArgs(args: readonly unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === "string") parts.push(a);
    else if (typeof a === "number" || typeof a === "boolean") parts.push(String(a));
    else if (a !== null && typeof a === "object" && !Array.isArray(a) && !isError(a)) {
      try {
        const o = a as Record<string, unknown>;
        for (const k of ["error", "message", "reason", "err", "msg"]) {
          if (typeof o[k] === "string" && (o[k] as string).length > 0) {
            parts.push(o[k] as string);
            break;
          }
        }
      } catch {
        /* skip */
      }
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
}

/** `[billing.grant] failed` → `log:billing.grant`; anything else → `log`. */
export function logRoute(label: string | undefined): string {
  const tag = label?.match(/^\s*\[([A-Za-z0-9_.:/-]{1,60})\]/)?.[1];
  return tag ? `log:${tag}` : "log";
}

/** The SDK's own log lines: `[BugStack] …`, `[BugStack Queue] …`, `[bugstack] …`. */
const SDK_LINE = /^\s*\[bugstack[^\]]*\]/i;

/**
 * Node's process-warning line, which its default warning handler writes
 * through console.error. A warning is not an error. (On Bugstack's own
 * services the only message-only forward in the first hour was DEP0169 from
 * `url.parse()`, 7 times, as its own incident.)
 */
const NODE_WARNING_LINE = /^\s*\(node:\d+\)\s+(?:\[[A-Z0-9_]+\]\s+)?\w*Warning:/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mask `field=value` and `field: value` for every redact field, and bearer
 * tokens. The rest of the SDK redacts request fields by name; a log line has
 * no fields, so the same names are matched where they appear as keys.
 */
export function redactText(text: string, redactFields: readonly string[]): string {
  let out = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
  if (redactFields.length > 0) {
    const names = redactFields.filter((f) => f.length > 0).map(escapeRegExp).join("|");
    if (names) {
      const re = new RegExp(
        `(["']?\\b\\w*(?:${names})\\w*["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&)}\\]]+)`,
        "gi",
      );
      out = out.replace(re, "$1[REDACTED]");
    }
  }
  return out;
}

function firstFrame(stack: string | undefined): string {
  return (stack ?? "").split("\n").find((l) => /^\s+at /.test(l))?.trim() ?? "";
}

/**
 * Drop the leading frames that belong to a logging library or this SDK, so
 * the first frame is the application line that logged. Keeps the stack as it
 * was when every frame would go.
 */
function trimLibraryFrames(stack: string): string {
  const lines = stack.split("\n");
  const header: string[] = [];
  let i = 0;
  while (i < lines.length && !/^\s+at /.test(lines[i]!)) header.push(lines[i++]!);
  let j = i;
  while (j < lines.length && /node_modules|[/\\]bugstack-sdk[/\\]|\(node:internal|^\s+at node:internal/.test(lines[j]!)) j++;
  if (j >= lines.length) return stack;
  return [...header, ...lines.slice(j)].join("\n");
}

/**
 * The logging site's own words: the first string of the call, unless it only
 * repeats the error (`console.error(err.message)`, `console.error(err.stack)`).
 */
function siteOf(label: string | undefined, cause: Error): string {
  if (label === undefined) return "";
  const first = label.split("\n")[0]!.trim();
  if (!first || first === cause.message || first === `${cause.name}: ${cause.message}`) return "";
  return first.slice(0, 200);
}

function matchesIgnore(text: string, ignore: ReadonlyArray<string | RegExp>): boolean {
  for (const p of ignore) {
    try {
      if (typeof p === "string" ? text.includes(p) : p.test(text)) return true;
    } catch {
      /* a bad pattern ignores nothing */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

type Pending = {
  anchored: Error;
  cause: Error | null;
  label: string | undefined;
  source: LoggedErrorSource;
  messageOnly: boolean;
};

/**
 * Look at one log call and, when it carries an error, mint the anchored error
 * now (so its stack starts at `boundary`'s caller) and forward it one
 * macrotask later. Never throws.
 */
export function captureLoggedCall(
  args: readonly unknown[],
  source: LoggedErrorSource,
  boundary: Function,
): void {
  const s = shared();
  if (s.busy) return;
  try {
    const sink = s.sink;
    if (!sink) {
      s.stats.dropped.no_client += 1;
      return;
    }
    const label = args.find((a): a is string => typeof a === "string");
    if (label !== undefined && SDK_LINE.test(label)) {
      s.stats.dropped.sdk_line += 1;
      return;
    }
    if (label !== undefined && NODE_WARNING_LINE.test(label)) {
      s.stats.dropped.node_warning += 1;
      return;
    }
    const cause = findError(args) ?? findStackText(args) ?? null;
    if (
      sink.options.ignore.length > 0 &&
      matchesIgnore(`${messageOfArgs(args)} ${cause ? `${cause.name}: ${cause.message}` : ""}`, sink.options.ignore)
    ) {
      s.stats.dropped.ignored += 1;
      return;
    }
    let message: string;
    if (cause) {
      message = `${siteOf(label, cause) || source}: ${cause.message}`;
    } else {
      message = sink.options.messages ? messageOfArgs(args) : "";
      if (!message) {
        s.stats.dropped.no_error_argument += 1;
        return;
      }
    }
    // Minted HERE so its stack starts at the caller of `boundary`.
    const anchored = new Error(redactText(message, sink.redactFields).slice(0, ANCHORED_MESSAGE_MAX));
    anchored.name = "LoggedError";
    const capture = (Error as { captureStackTrace?: (t: object, f?: Function) => void }).captureStackTrace;
    if (capture) capture(anchored, boundary);
    if (anchored.stack) anchored.stack = trimLibraryFrames(anchored.stack);
    if (cause) (anchored as { cause?: unknown }).cause = cause;
    const pending: Pending = { anchored, cause, label, source, messageOnly: !cause };
    defer(() => forward(pending));
  } catch {
    /* the log line was written; forwarding is best-effort */
  }
}

function forward(p: Pending): void {
  const s = shared();
  const sink = s.sink;
  if (!sink) {
    s.stats.dropped.no_client += 1;
    return;
  }
  try {
    if (p.cause && s.reported.has(p.cause)) {
      s.stats.dropped.already_reported += 1;
      return;
    }
    const now = s.now();
    const key = p.messageOnly
      ? `${firstFrame(p.anchored.stack)}|message-only`
      : `${firstFrame(p.anchored.stack)}|${p.anchored.message}`;
    const last = s.lastSent.get(key);
    if (last !== undefined && now - last < sink.options.repeatWindowMs) {
      s.stats.dropped.repeat += 1;
      return;
    }
    if (now - s.windowStart >= 60_000) {
      s.windowStart = now;
      s.inWindow = 0;
    }
    if (s.inWindow >= sink.options.maxPerMinute) {
      s.stats.dropped.rate_limited += 1;
      return;
    }
    s.inWindow += 1;
    s.lastSent.set(key, now);
    if (s.lastSent.size > MAX_REMEMBERED) {
      const oldest = s.lastSent.keys().next().value;
      if (oldest !== undefined) s.lastSent.delete(oldest);
    }
    if (p.cause) s.reported.add(p.cause);

    const captured = buildLoggedCapturedError(p, sink);
    s.busy = true;
    try {
      const result = sink.report(captured);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(() => {});
      }
      s.stats.forwarded += 1;
      if (p.messageOnly) s.stats.messageOnly += 1;
    } finally {
      s.busy = false;
    }
  } catch {
    /* a report that cannot be built or sent must never break the code that logged */
  }
}

function nodeVersion(): string {
  try {
    return typeof process !== "undefined" && process.version ? process.version : "unknown";
  } catch {
    return "unknown";
  }
}

function buildLoggedCapturedError(p: Pending, sink: LoggedErrorSink): CapturedError {
  const stackFrames = parseStackTrace(p.anchored.stack);
  const firstAppFrame = getFirstAppFrame(stackFrames);
  const route = logRoute(p.label);
  const metadata: Record<string, unknown> = {
    source: p.source,
    handled: true,
    ...(firstAppFrame && {
      sourceLocation: {
        file: firstAppFrame.file,
        line: firstAppFrame.line,
        column: firstAppFrame.column,
        function: firstAppFrame.function,
      },
    }),
  };
  if (p.cause) {
    metadata.causeName = p.cause.name;
    if (p.cause.stack) metadata.causeStack = redactText(p.cause.stack, sink.redactFields).slice(0, CAUSE_STACK_MAX);
  } else {
    metadata.messageOnly = true;
  }
  return {
    id: `err_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`,
    name: p.anchored.name,
    message: p.anchored.message,
    stack: p.anchored.stack,
    stackFrames,
    timestamp: new Date().toISOString(),
    route,
    method: "LOG",
    statusCode: 500,
    url: route,
    environment: sink.environment,
    projectId: sink.projectId,
    sdkVersion: SDK_VERSION,
    nodeVersion: nodeVersion(),
    metadata,
  };
}

// ---------------------------------------------------------------------------
// console.error
// ---------------------------------------------------------------------------

/**
 * Point logged-error forwarding at a client (the SDK calls this from
 * `ErrorCaptureClient`'s constructor) and wrap console.error once per process
 * when `options.console` is on. A second call only swaps the sink.
 */
export function attachLoggedErrorSink(sink: LoggedErrorSink): void {
  try {
    const s = shared();
    s.sink = sink;
    if (sink.options.console) installConsoleWrapper(s);
  } catch {
    /* never throws into init */
  }
}

/**
 * Detach `sink` (a client being destroyed). The console wrapper is removed
 * when nothing has wrapped console.error on top of it since; otherwise it
 * stays in place and passes every call straight through.
 */
export function detachLoggedErrorSink(sink: LoggedErrorSink): void {
  try {
    const s = shared();
    if (s.sink !== sink) return;
    s.sink = null;
    if (s.consoleWrapper && typeof console !== "undefined" && console.error === s.consoleWrapper && s.consoleOriginal) {
      console.error = s.consoleOriginal as typeof console.error;
      s.consoleWrapper = null;
      s.consoleOriginal = null;
    }
  } catch {
    /* never throws */
  }
}

function installConsoleWrapper(s: Shared): void {
  if (typeof console === "undefined" || typeof console.error !== "function") return;
  if (s.consoleWrapper && console.error === s.consoleWrapper) return;
  const original = console.error as (...args: unknown[]) => void;
  const wrapper = function consoleErrorCapturedByBugstack(this: unknown, ...args: unknown[]): void {
    original.apply(this === undefined ? console : this, args);
    const st = shared();
    if (!st.sink || !st.sink.options.console) return;
    captureLoggedCall(args, "console-error", wrapper);
  };
  s.consoleOriginal = original;
  s.consoleWrapper = wrapper;
  console.error = wrapper as typeof console.error;
}

// ---------------------------------------------------------------------------
// pino and winston
// ---------------------------------------------------------------------------

/**
 * pino `hooks` that forward error and fatal logs. Pass to pino:
 *
 * ```ts
 * const logger = pino({ hooks: bugstackPinoHooks() });
 * ```
 *
 * If you already use `hooks.logMethod`, call the returned `logMethod` from
 * yours. The log line is written exactly as before.
 */
export function bugstackPinoHooks(): {
  logMethod: (this: unknown, inputArgs: unknown[], method: (...a: unknown[]) => unknown, level: number) => unknown;
} {
  const logMethod = function bugstackPinoLogMethod(
    this: unknown,
    inputArgs: unknown[],
    method: (...a: unknown[]) => unknown,
    level: number,
  ): unknown {
    if (typeof level === "number" && level >= 50) {
      captureLoggedCall(inputArgs, "pino", logMethod);
    }
    return method.apply(this, inputArgs);
  };
  return { logMethod };
}

const WINSTON_LEVEL = Symbol.for("level");
const WINSTON_SPLAT = Symbol.for("splat");
const WINSTON_ERROR_LEVELS = new Set(["error", "crit", "alert", "emerg", "fatal"]);

/**
 * A winston format that forwards error-level logs. Put it first in your
 * format chain:
 *
 * ```ts
 * const logger = winston.createLogger({
 *   format: winston.format.combine(bugstackWinstonFormat(), winston.format.json()),
 *   transports: [new winston.transports.Console()],
 * });
 * ```
 *
 * It returns the log entry unchanged.
 */
export function bugstackWinstonFormat(): { transform: (info: Record<string | symbol, unknown>) => Record<string | symbol, unknown> } {
  const transform = function bugstackWinstonTransform(info: Record<string | symbol, unknown>): Record<string | symbol, unknown> {
    try {
      const level = (info[WINSTON_LEVEL] ?? info.level) as unknown;
      if (typeof level === "string" && WINSTON_ERROR_LEVELS.has(level)) {
        const splat = Array.isArray(info[WINSTON_SPLAT]) ? (info[WINSTON_SPLAT] as unknown[]) : [];
        const args: unknown[] = [];
        if (typeof info.message === "string") args.push(info.message);
        // `logger.error(err)` copies the error's fields onto info; with
        // `format.errors()` info carries `stack` too.
        if (typeof info.stack === "string" && typeof info.message === "string") {
          const e = new Error(info.message);
          e.name = typeof info.name === "string" ? info.name : "Error";
          e.stack = info.stack;
          args.push(e);
        }
        args.push(...splat, info);
        captureLoggedCall(args, "winston", transform);
      }
    } catch {
      /* never throws into the logger */
    }
    return info;
  };
  return { transform };
}

/** Test seam: reset all shared state and use `now` as the clock. */
export function __resetLoggedErrorsForTests(now: () => number = Date.now): void {
  const s = shared();
  if (s.consoleWrapper && typeof console !== "undefined" && console.error === s.consoleWrapper && s.consoleOriginal) {
    console.error = s.consoleOriginal as typeof console.error;
  }
  s.sink = null;
  s.consoleOriginal = null;
  s.consoleWrapper = null;
  s.busy = false;
  s.windowStart = 0;
  s.inWindow = 0;
  s.lastSent = new Map();
  s.stats = emptyStats();
  s.reported = new WeakSet();
  s.now = now;
}
