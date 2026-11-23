import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import winston from "winston";

import { ErrorCaptureClient } from "../src/core/client";
import type { CapturedError, ErrorCaptureConfig } from "../src/core/types";
import {
  DEFAULT_MAX_PER_MINUTE,
  DEFAULT_REPEAT_WINDOW_MS,
  __resetLoggedErrorsForTests,
  bugstackPinoHooks,
  bugstackWinstonFormat,
  logRoute,
  loggedErrorStats,
  markErrorReported,
  redactText,
} from "../src/core/logged-errors";
import { captureError } from "../src/adapters/generic/index";

const tick = () => new Promise<void>((r) => setImmediate(r));

const realConsoleError = console.error;
let sink: ReturnType<typeof vi.fn>;
let reported: CapturedError[];
let clock = 1_000_000;
let fetchMock: ReturnType<typeof vi.fn>;

function init(extra: Partial<ErrorCaptureConfig> = {}): ErrorCaptureClient {
  const client = ErrorCaptureClient.init({
    apiKey: "test-key",
    endpoint: "http://127.0.0.1:9/api/ingest/sdk",
    projectId: "p",
    environment: "test",
    debug: false,
    ...extra,
  });
  const original = client.reportError.bind(client);
  vi.spyOn(client, "reportError").mockImplementation(async (e, ctx) => {
    reported.push(e);
    return original(e, ctx);
  });
  return client;
}

beforeEach(() => {
  clock = 1_000_000;
  __resetLoggedErrorsForTests(() => clock);
  sink = vi.fn();
  console.error = sink as unknown as typeof console.error;
  reported = [];
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  ErrorCaptureClient.reset();
  __resetLoggedErrorsForTests();
  console.error = realConsoleError;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function swallowingCatch(): void {
  try {
    throw new TypeError("cannot read properties of undefined");
  } catch (err) {
    console.error("[billing] grant failed", err);
  }
}

const firstAt = (stack: string | undefined) =>
  String(stack).split("\n").find((l) => /^\s+at /.test(l)) ?? "";

describe("console.error capture", () => {
  it("writes the console line first with the same arguments and this, then reports once, anchored at the logging site", async () => {
    init();
    swallowingCatch();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toBe("[billing] grant failed");
    expect(sink.mock.calls[0]![1]).toBeInstanceOf(TypeError);
    expect(sink.mock.contexts[0]).toBe(console);
    expect(reported).toHaveLength(0); // deferred a macrotask
    await tick();
    expect(reported).toHaveLength(1);
    const e = reported[0]!;
    expect(e.name).toBe("LoggedError");
    expect(e.message).toBe("[billing] grant failed: cannot read properties of undefined");
    expect(firstAt(e.stack)).toContain("swallowingCatch");
    expect(e).toMatchObject({ route: "log:billing", method: "LOG", statusCode: 500, environment: "test", projectId: "p" });
    expect(e.metadata).toMatchObject({ source: "console-error", handled: true, causeName: "TypeError" });
    expect(String(e.metadata!.causeStack)).toContain("cannot read properties of undefined");
    expect((e.metadata!.sourceLocation as { function?: string }).function).toContain("swallowingCatch");
  });

  it("returns what the original returned and leaves console.error's behaviour intact when nothing is captured", () => {
    init();
    sink.mockReturnValue(undefined);
    expect(console.error("plain line", 1, { a: 2 })).toBeUndefined();
    expect(sink).toHaveBeenCalledWith("plain line", 1, { a: 2 });
  });

  it("sends the report over the SDK transport with the API key", async () => {
    init();
    swallowingCatch();
    await tick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, req] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/api/ingest/sdk");
    expect((req.headers as Record<string, string>)["X-BugStack-API-Key"]).toBe("test-key");
    const body = JSON.parse(String(req.body));
    expect(body.error.name).toBe("LoggedError");
    expect(body.error.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("leaves a plain message line as a console line by default", async () => {
    init();
    console.error("[sweep] could not update org-1", "connection reset");
    console.error({ detail: 1 });
    await tick();
    expect(reported).toHaveLength(0);
    expect(loggedErrorStats().dropped.no_error_argument).toBe(2);
  });

  it("forwards a message-only line with { messages: true }, repeating per site whatever ids it carries", async () => {
    init({ captureConsoleErrors: { messages: true } });
    const site = (id: string) =>
      console.error("[detector-sweep] could not update an outage", { detectorId: id, error: "connection reset" });
    site("d-1");
    await tick();
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toBe("[detector-sweep] could not update an outage connection reset");
    expect(reported[0]!.metadata).toMatchObject({ source: "console-error", messageOnly: true });
    site("d-2");
    await tick();
    expect(reported).toHaveLength(1);
    expect(loggedErrorStats().dropped.repeat).toBe(1);
    clock += DEFAULT_REPEAT_WINDOW_MS;
    site("d-3");
    await tick();
    expect(reported).toHaveLength(2);
    expect(loggedErrorStats()).toMatchObject({ forwarded: 2, messageOnly: 2 });
  });

  it("forwards a string holding a stack trace (console.error(err.stack))", async () => {
    init();
    function logsStack(): void {
      const err = new RangeError("index out of range");
      console.error("[queue] job failed:", err.stack);
    }
    logsStack();
    await tick();
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toBe("[queue] job failed:: index out of range");
    expect(reported[0]!.metadata).toMatchObject({ causeName: "RangeError" });
    expect(firstAt(reported[0]!.stack)).toContain("logsStack");
  });

  it("does not mistake a React component stack for an error", async () => {
    init();
    console.error("Warning: Each child in a list should have a unique key prop.%s", "\n    at li\n    at ul (http://x/app.js:1:1)");
    await tick();
    expect(reported).toHaveLength(0);
  });

  it("finds an Error in an { err } object argument", async () => {
    init();
    console.error({ err: new Error("db down"), orgId: "o" }, "[db] query failed");
    await tick();
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toBe("[db] query failed: db down");
    expect(reported[0]!.route).toBe("log:db");
  });

  it("leaves Node's own process warnings as console lines", async () => {
    init({ captureConsoleErrors: { messages: true } });
    console.error(
      "(node:113) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications.",
    );
    console.error("(node:7) ExperimentalWarning: VM Modules is an experimental feature");
    await tick();
    expect(reported).toHaveLength(0);
    expect(loggedErrorStats().dropped.node_warning).toBe(2);
    console.error("(node) something else failed");
    await tick();
    expect(reported).toHaveLength(1);
  });

  it("leaves lines matching ignore as console lines", async () => {
    init({ captureConsoleErrors: { ignore: ["ECONNRESET", /expected failure/] } });
    console.error("socket", new Error("read ECONNRESET"));
    console.error("an expected failure", new Error("x"));
    await tick();
    expect(reported).toHaveLength(0);
    expect(loggedErrorStats().dropped.ignored).toBe(2);
  });

  it("never sends an error an adapter already reported (captureError, then console.error)", async () => {
    init();
    const err = new Error("boom");
    await captureError(err);
    console.error("[x] failed", err);
    await tick();
    expect(reported).toHaveLength(1);
    expect(reported[0]!.name).toBe("Error");
    expect(loggedErrorStats().dropped.already_reported).toBe(1);
  });

  it("never sends twice when the catch logs first and reports in the same tick", async () => {
    init();
    const err = new Error("boom");
    console.error("[x] failed", err);
    markErrorReported(err);
    await tick();
    expect(reported).toHaveLength(0);
    expect(loggedErrorStats().dropped.already_reported).toBe(1);
  });

  it("sends the same site and message once per repeat window", async () => {
    init();
    for (let i = 0; i < 3; i++) swallowingCatch();
    await tick();
    expect(reported).toHaveLength(1);
    expect(loggedErrorStats().dropped.repeat).toBe(2);
    clock += DEFAULT_REPEAT_WINDOW_MS;
    swallowingCatch();
    await tick();
    expect(reported).toHaveLength(2);
  });

  it("caps forwards per minute and counts the rest", async () => {
    init({ deduplicationWindow: 0 });
    for (let i = 0; i < DEFAULT_MAX_PER_MINUTE + 5; i++) console.error(`[x] failed ${i}`, new Error(`e${i}`));
    await tick();
    expect(reported).toHaveLength(DEFAULT_MAX_PER_MINUTE);
    expect(loggedErrorStats()).toMatchObject({ forwarded: DEFAULT_MAX_PER_MINUTE, dropped: { rate_limited: 5 } });
    clock += 60_000;
    console.error("[x] failed later", new Error("later"));
    await tick();
    expect(reported).toHaveLength(DEFAULT_MAX_PER_MINUTE + 1);
  });

  it("skips the SDK's own lines and never loops through a beforeSend that logs", async () => {
    init({
      beforeSend: (e) => {
        console.error("[reporter] about to send", new Error("from beforeSend"));
        return e;
      },
    });
    console.error("[BugStack] send failed", new Error("network"));
    console.error("[BugStack Queue] retry failed", new Error("network"));
    console.error("[x] failed", new Error("first"));
    await tick();
    await tick();
    expect(reported).toHaveLength(1);
    expect(loggedErrorStats().dropped.sdk_line).toBe(2);
    expect(sink).toHaveBeenCalledTimes(4);
  });

  it("never throws into the app when the report path throws", async () => {
    init({
      beforeSend: () => {
        throw new Error("beforeSend broke");
      },
    });
    expect(() => console.error("[x] failed", new Error("y"))).not.toThrow();
    await tick();
    const hostile = {
      get message(): string {
        throw new Error("getter");
      },
    };
    expect(() => console.error(hostile, { get err(): unknown { throw new Error("getter"); } })).not.toThrow();
    await tick();
  });

  it("redacts the logged text with the client's redact fields", async () => {
    init({ redactFields: ["sessionId"] });
    console.error("[auth] login failed password=hunter2 sessionId: abc123 Authorization: Bearer abcdefghijkl", new Error("token=s3cr3t rejected"));
    await tick();
    const m = reported[0]!.message;
    expect(m).not.toContain("hunter2");
    expect(m).not.toContain("abc123");
    expect(m).not.toContain("abcdefghijkl");
    expect(m).not.toContain("s3cr3t");
    expect(String(reported[0]!.metadata!.causeStack)).not.toContain("s3cr3t");
  });

  it("captureConsoleErrors: false leaves console.error untouched", async () => {
    init({ captureConsoleErrors: false });
    expect(console.error).toBe(sink);
    swallowingCatch();
    await tick();
    expect(reported).toHaveLength(0);
    expect(loggedErrorStats().consoleInstalled).toBe(false);
  });

  it("enabled: false installs nothing", () => {
    init({ enabled: false });
    expect(console.error).toBe(sink);
  });

  it("wraps once per process and restores console.error when the client is destroyed", async () => {
    init();
    const wrapped = console.error;
    expect(wrapped).not.toBe(sink);
    init(); // re-init destroys the first client, then wraps again
    expect(console.error).not.toBe(sink);
    ErrorCaptureClient.reset();
    expect(console.error).toBe(sink);
  });

  it("leaves a wrapper installed on top of it in place on destroy, and then passes calls through", async () => {
    init();
    const ours = console.error;
    const outer = vi.fn((...a: unknown[]) => (ours as (...x: unknown[]) => void)(...a));
    console.error = outer as unknown as typeof console.error;
    ErrorCaptureClient.reset();
    expect(console.error).toBe(outer);
    console.error("[x] failed", new Error("after destroy"));
    await tick();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(0);
  });
});

describe("pino", () => {
  function pinoLogger(lines: string[]) {
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    return pino({ hooks: bugstackPinoHooks() }, dest);
  }

  it("forwards error and fatal logs carrying an Error, anchored at the app line, and writes the log line as before", async () => {
    init();
    const lines: string[] = [];
    const logger = pinoLogger(lines);
    function handler(): void {
      try {
        throw new Error("payment provider timeout");
      } catch (err) {
        logger.error({ err, orderId: "o-1" }, "[checkout] charge failed");
      }
    }
    handler();
    logger.warn(new Error("just a warning"));
    logger.info("hello");
    await tick();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "[checkout] charge failed", orderId: "o-1", err: { message: "payment provider timeout" } });
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toBe("[checkout] charge failed: payment provider timeout");
    expect(reported[0]!.route).toBe("log:checkout");
    expect(reported[0]!.metadata).toMatchObject({ source: "pino", causeName: "Error" });
    expect(firstAt(reported[0]!.stack)).toContain("handler");
  });

  it("leaves a message-only pino error as a log line by default", async () => {
    init();
    const lines: string[] = [];
    pinoLogger(lines).error("[x] something odd");
    await tick();
    expect(lines).toHaveLength(1);
    expect(reported).toHaveLength(0);
  });
});

describe("winston", () => {
  function winstonLogger(lines: unknown[]) {
    return winston.createLogger({
      level: "info",
      format: winston.format.combine(bugstackWinstonFormat(), winston.format.errors({ stack: true }), winston.format.json()),
      transports: [
        new winston.transports.Stream({
          stream: new Writable({
            write(chunk, _enc, cb) {
              lines.push(JSON.parse(String(chunk)));
              cb();
            },
          }),
        }),
      ],
    });
  }

  it("forwards logger.error(err) and logger.error(msg, err), anchored at the app line", async () => {
    init();
    const lines: unknown[] = [];
    const logger = winstonLogger(lines);
    function first(): void {
      logger.error(new Error("disk full"));
    }
    function second(): void {
      logger.error("[upload] write failed", new Error("EACCES"));
    }
    first();
    second();
    logger.warn("only a warning");
    await tick();
    expect(lines).toHaveLength(3);
    expect(reported).toHaveLength(2);
    expect(reported[0]!.message).toContain("disk full");
    expect(firstAt(reported[0]!.stack)).toContain("first");
    expect(reported[1]!.message).toContain("EACCES");
    expect(reported[1]!.route).toBe("log:upload");
    expect(firstAt(reported[1]!.stack)).toContain("second");
    expect(reported.every((r) => r.metadata!.source === "winston")).toBe(true);
  });
});

describe("helpers", () => {
  it("logRoute takes the bracket tag, else plain log", () => {
    expect(logRoute("[workers.sweep] tick failed")).toBe("log:workers.sweep");
    expect(logRoute("tick failed")).toBe("log");
    expect(logRoute(undefined)).toBe("log");
  });

  it("redactText masks key=value, key: value, quoted JSON keys and bearer tokens", () => {
    const fields = ["password", "token", "secret"];
    expect(redactText("password=hunter2 next", fields)).toBe("password=[REDACTED] next");
    expect(redactText('{"token":"abc","ok":1}', fields)).toBe('{"token":[REDACTED],"ok":1}');
    expect(redactText("client_secret: xyz", fields)).toBe("client_secret: [REDACTED]");
    expect(redactText("Bearer abcdefghijklmnop", fields)).toBe("Bearer [REDACTED]");
    expect(redactText("author=jane", fields)).toBe("author=jane");
  });
});
