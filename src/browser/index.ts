// bugstack-sdk/browser — what your users actually hit in the browser, as
// evidence Bugstack can fix from: uncaught errors, failed requests and the
// route trail, and, when you opt in, frustration signals (rage clicks, dead
// clicks, clicks followed by an error, forms left after a validation error,
// rapid back-and-forth between pages).
//
//   import { init, setUser } from "bugstack-sdk/browser";
//   init({ key: "<your BROWSER key>", frustration: true });
//   setUser({ id: user.id, email: user.email });
//
// Next.js App Router: call init() in instrumentation-client.ts (Next 15.3+)
// or in a "use client" component mounted once in the root layout. Pages
// Router: call it in pages/_app.tsx inside useEffect.
//
// Every function here is safe to call anywhere: on the server (it does
// nothing), before init (it does nothing), and it never throws. No
// dependencies; never records input values, query strings or request bodies.

import { SessionRecorder, sessionFor, DEFAULT_ENDPOINT } from "./recorder.js";
import type { BrowserConfig, SessionUser } from "./types.js";

export type { BrowserConfig, FrustrationConfig, SessionUser, SessionEvent, SessionBatch, ElementRef } from "./types.js";
export { DEFAULT_ENDPOINT };

let recorder: SessionRecorder | null = null;

function inBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Start recording this browser session. Call once, as early as you can. A
 * second call is ignored; close() first to start over.
 */
export function init(config: BrowserConfig): void {
  try {
    if (!inBrowser() || recorder) return;
    if (!config || typeof config.key !== "string" || config.key.trim() === "") return;
    const { sessionId, sampled } = sessionFor(config.sampleRate ?? 1);
    if (!sampled) return;
    recorder = new SessionRecorder({ ...config, key: config.key.trim() }, sessionId);
    recorder.install();
  } catch {
    recorder = null;
  }
}

/**
 * Who this session belongs to. bugstack stores only a salted hash of it, which
 * is how a support ticket from the same person finds what they saw. Pass null
 * on sign-out.
 */
export function setUser(user: SessionUser | null): void {
  try {
    recorder?.setUser(user);
  } catch {
    /* never into the host page */
  }
}

/** Report an error you caught yourself. */
export function captureError(err: unknown): void {
  try {
    recorder?.captureError(err);
  } catch {
    /* never into the host page */
  }
}

/** Send what is queued now. Resolves when the send settles; never rejects. */
export function flush(): Promise<void> {
  try {
    return recorder ? recorder.flush().catch(() => {}) : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

/** Stop recording: send what is queued, remove every listener and wrapper. */
export function close(): void {
  try {
    recorder?.close();
  } catch {
    /* never into the host page */
  } finally {
    recorder = null;
  }
}

/** The current session id, or null when not recording. */
export function getSessionId(): string | null {
  return recorder?.sessionId ?? null;
}
