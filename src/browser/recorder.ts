// The session recorder: what a user actually hit in this page. Ported from
// the Bugstack monorepo's packages/browser-sdk (MIT), plus frustration signals.
//
//   error           window `error` / `unhandledrejection`, and captureError()
//   failed_request  fetch / XHR answered 5xx or not at all
//   navigation      the first page and every route change
//
// Frustration signals, only with `frustration` set (OFF by default):
//
//   rage_click      3+ clicks on one element within 1 s (one event per burst)
//   dead_click      a click on something button-like that, within 1 s, caused
//                   no navigation, no request and no DOM change; or a link
//                   that navigated to a page saying it does not exist
//   error_click     a click followed within 1 s by an uncaught error
//   form_abandon    a form whose submit hit a validation error (a native
//                   `invalid`, or aria-invalid / role="alert" after submit),
//                   then left without a submit that passed
//   thrash          4+ route changes within 10 s alternating between two routes
//
// Frustration is sampled (frustration.sampleRate, once per session) and
// capped per page view (frustration.maxPerPage). Nothing records an input's
// value or text beyond a 60-character element label (redact.ts).
//
// THE ONE RULE: the SDK must never hurt the page it watches. Every handler is
// wrapped, nothing it does throws into the host, and the fetch / XHR wrappers
// hand back the same Response and re-throw the same errors.

import {
  clickTarget,
  currentRoute,
  describeElement,
  describeField,
  describeForm,
  isActionable,
  isEndpoint,
  isNotFoundPage,
  requestPath,
  cap,
} from "./redact.js";
import { Transport, envelopeFor } from "./transport.js";
import type { BrowserConfig, ElementRef, SessionEvent, SessionUser } from "./types.js";

export const DEFAULT_ENDPOINT = "https://dashboard.bugstack.ai/api/v1/sessions/ingest";

/** How long after a click the page has to react, and the rage-click window. */
export const CLICK_WINDOW_MS = 1000;
export const RAGE_CLICKS = 3;
const FLUSH_INTERVAL_MS = 5000;

// A broken page can throw the same error in a loop; one session must not flood.
const MAX_SAME_EVENT = 5;
const MAX_ERRORS_PER_PAGE = 100;

const SESSION_KEY = "bugstack.session";
const SAMPLED_KEY = "bugstack.sampled";
const FRUSTRATION_SAMPLED_KEY = "bugstack.frustration";

/** Thrashing: route changes alternating between two routes within this window. */
export const THRASH_WINDOW_MS = 10_000;
export const THRASH_SWITCHES = 4;
export const DEFAULT_FRUSTRATION_PER_PAGE = 20;
const MAX_INVALID_FIELDS = 5;
const FIELD = "input, select, textarea";

/** Whether this session records frustration: the config, then a once-per-session sample. */
export function frustrationFor(config: BrowserConfig): { on: boolean; maxPerPage: number } {
  const f = config.frustration;
  const off = { on: false, maxPerPage: 0 };
  if (!f) return off;
  const obj = typeof f === "object" ? f : {};
  if (obj.enabled === false) return off;
  const maxPerPage =
    typeof obj.maxPerPage === "number" && obj.maxPerPage >= 1 ? Math.min(100, Math.floor(obj.maxPerPage)) : DEFAULT_FRUSTRATION_PER_PAGE;
  const rate = typeof obj.sampleRate === "number" && Number.isFinite(obj.sampleRate) ? Math.min(1, Math.max(0, obj.sampleRate)) : 1;
  if (rate >= 1) return { on: true, maxPerPage };
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  let raw = storage?.getItem(FRUSTRATION_SAMPLED_KEY) ?? null;
  if (raw !== "1" && raw !== "0") {
    raw = Math.random() < rate ? "1" : "0";
    try {
      storage?.setItem(FRUSTRATION_SAMPLED_KEY, raw);
    } catch {
      /* private mode */
    }
  }
  return { on: raw === "1", maxPerPage };
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* never into the host page */
  }
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `s_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** This browser session's id and whether it is recorded at all (sampleRate). */
export function sessionFor(sampleRate: number): { sessionId: string; sampled: boolean } {
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  let sessionId = storage?.getItem(SESSION_KEY) ?? null;
  let sampledRaw = storage?.getItem(SAMPLED_KEY) ?? null;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    sessionId = randomId();
    sampledRaw = null;
    try {
      storage?.setItem(SESSION_KEY, sessionId);
    } catch {
      /* private mode */
    }
  }
  if (sampledRaw !== "1" && sampledRaw !== "0") {
    const rate = Number.isFinite(sampleRate) ? Math.min(1, Math.max(0, sampleRate)) : 1;
    sampledRaw = Math.random() < rate ? "1" : "0";
    try {
      storage?.setItem(SAMPLED_KEY, sampledRaw);
    } catch {
      /* private mode */
    }
  }
  return { sessionId, sampled: sampledRaw === "1" };
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorShape(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error || (err && typeof err === "object" && "message" in (err as object))) {
    const e = err as Error;
    const out: { name: string; message: string; stack?: string } = {
      name: cap(String(e.name || "Error"), 200),
      message: cap(String(e.message ?? ""), 1000),
    };
    if (typeof e.stack === "string" && e.stack) out.stack = cap(e.stack, 8000);
    return out;
  }
  let message: string;
  try {
    message = typeof err === "string" ? err : JSON.stringify(err) ?? String(err);
  } catch {
    message = String(err);
  }
  return { name: "UnhandledRejection", message: cap(message, 1000) };
}

// The SDK's own code never throws into the page (every handler is wrapped),
// so the only error it could cause is one raised in its own unbundled file.
// Matched on the ErrorEvent's filename only: a stack that merely PASSES through
// the fetch wrapper (an app's failed request it re-throws) is the app's error.
const OWN_FILE = /[/\\](?:@bugstack[/\\]browser|bugstack-sdk[/\\]dist[/\\]browser)[/\\]/i;

type Patched = { restore: () => void };

export class SessionRecorder {
  private readonly transport: Transport;
  private user: SessionUser | null = null;
  private readonly patches: Patched[] = [];
  private readonly listeners: Array<() => void> = [];
  private observer: MutationObserver | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private activity = 0;
  private lastRoute: string | null = null;
  private readonly seen = new Map<string, number>();
  private errorsThisPage = 0;
  private readonly clickHistory = new Map<
    Element,
    { times: number[]; burst: number; startedAt: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  private readonly deadReportedAt = new WeakMap<Element, number>();
  // Frustration (OFF unless config.frustration).
  private readonly frustration: boolean;
  private readonly maxFrustrationPerPage: number;
  private frustrationThisPage = 0;
  private lastClick: { el: Element; at: number; route: string; errored: boolean } | null = null;
  private pendingLink: { el: Element; at: number; route: string } | null = null;
  private readonly forms = new Map<Element, { route: string; fields: Map<string, ElementRef>; attempts: number; lastAttemptAt: number }>();
  private navTrail: Array<{ route: string; at: number }> = [];
  private readonly thrashReported = new Set<string>();
  private unloading = false;
  private closed = false;
  readonly endpoint: string;

  constructor(
    config: BrowserConfig,
    readonly sessionId: string,
  ) {
    this.endpoint = config.endpoint || DEFAULT_ENDPOINT;
    const fr = frustrationFor(config);
    this.frustration = fr.on;
    this.maxFrustrationPerPage = fr.maxPerPage;
    const fetchImpl = typeof window.fetch === "function" ? window.fetch.bind(window) : undefined;
    const beacon =
      typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
        ? (url: string, body: string) => navigator.sendBeacon(url, body)
        : undefined;
    this.transport = new Transport(
      { endpoint: this.endpoint, key: config.key, fetchImpl, beacon, now: () => Date.now() },
      () =>
        envelopeFor({
          sessionId: this.sessionId,
          user: this.user,
          release: config.release,
          environment: config.environment,
        }),
    );
  }

  /** For tests and flush(): the transport. */
  get queue(): Transport {
    return this.transport;
  }

  install(): void {
    this.listen(window, "error", (ev) => this.onError(ev as ErrorEvent));
    this.listen(window, "unhandledrejection", (ev) =>
      this.recordError((ev as PromiseRejectionEvent).reason),
    );
    this.listen(document, "click", (ev) => this.onClick(ev as MouseEvent), true);
    this.listen(window, "popstate", () => this.onNavigation());
    this.listen(window, "hashchange", () => this.onNavigation());
    this.listen(window, "pagehide", () => {
      this.unloading = true;
      this.flushForms();
      this.onHide();
    });
    if (this.frustration) {
      this.listen(document, "invalid", (ev) => this.onInvalid(ev.target), true);
      this.listen(document, "submit", (ev) => this.onSubmit(ev.target), true);
    }
    this.listen(window, "beforeunload", () => {
      this.unloading = true;
    });
    // A page restored from the back/forward cache is alive again.
    this.listen(window, "pageshow", () => {
      this.unloading = false;
    });
    this.listen(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.onHide();
    });
    this.patchFetch();
    this.patchXhr();
    this.patchHistory();
    safe(() => {
      // The observer only serves the dead-click check: no frustration, no observer.
      if (this.frustration && typeof MutationObserver === "function") {
        this.observer = new MutationObserver(() => {
          this.activity++;
        });
        this.observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
    });
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.onNavigation(true);
  }

  setUser(user: SessionUser | null): void {
    if (!user) {
      this.user = null;
      return;
    }
    const next: SessionUser = {};
    if (typeof user.id === "string" && user.id.trim()) next.id = cap(user.id.trim(), 200);
    else if (typeof user.id === "number") next.id = String(user.id);
    if (typeof user.email === "string" && user.email.trim()) next.email = cap(user.email.trim(), 320);
    this.user = next.id || next.email ? next : null;
  }

  captureError(err: unknown): void {
    this.recordError(err);
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    safe(() => this.transport.flushOnHide());
    for (const off of this.listeners.splice(0)) safe(off);
    for (const p of this.patches.splice(0)) safe(p.restore);
    safe(() => this.observer?.disconnect());
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const h of this.clickHistory.values()) if (h.timer) clearTimeout(h.timer);
    // Pending dead-click checks see `closed` and stand down.
    this.clickHistory.clear();
  }

  // --- recording -----------------------------------------------------------

  private push(event: SessionEvent, dedupeKey?: string): void {
    if (this.closed) return;
    if (dedupeKey) {
      const n = (this.seen.get(dedupeKey) ?? 0) + 1;
      this.seen.set(dedupeKey, n);
      if (n > MAX_SAME_EVENT) return;
    }
    this.transport.push(event);
    if (this.transport.size >= 100) void this.flush();
  }

  private onError(ev: ErrorEvent): void {
    safe(() => {
      // A resource that failed to load is not a script error.
      if (!ev || typeof ev.message !== "string") return;
      // A cross-origin script hides everything but this.
      if (ev.message === "Script error." && !ev.filename && !ev.error) return;
      if (ev.filename && OWN_FILE.test(ev.filename)) return;
      this.recordError(ev.error ?? { name: "Error", message: ev.message });
    });
  }

  private recordError(err: unknown): void {
    safe(() => {
      const error = errorShape(err);
      if (this.errorsThisPage >= MAX_ERRORS_PER_PAGE) return;
      this.errorsThisPage++;
      const route = currentRoute();
      this.push({ kind: "error", at: nowIso(), route, error }, `error:${error.name}:${error.message}:${route}`);
      // A click followed by an uncaught error: the click's element is the lead.
      const c = this.lastClick;
      if (this.frustration && c && !c.errored && Date.now() - c.at <= CLICK_WINDOW_MS) {
        c.errored = true;
        const element = describeElement(c.el);
        this.pushFrustration(
          {
            kind: "error_click",
            at: new Date(c.at).toISOString(),
            route: c.route,
            element,
            error: { name: error.name, message: cap(error.message, 200) },
          },
          `error_click:${c.route}:${element.selector}:${error.name}`,
        );
      }
    });
  }

  /** A frustration event: only when recording frustration, at most maxPerPage a page view. */
  private pushFrustration(event: SessionEvent, dedupeKey: string): void {
    if (!this.frustration || this.frustrationThisPage >= this.maxFrustrationPerPage) return;
    this.frustrationThisPage++;
    this.push(event, dedupeKey);
  }

  // --- forms ---------------------------------------------------------------

  private formState(form: Element) {
    let st = this.forms.get(form);
    if (!st) {
      st = { route: currentRoute(), fields: new Map(), attempts: 0, lastAttemptAt: 0 };
      this.forms.set(form, st);
    }
    return st;
  }

  private addFields(st: { fields: Map<string, ElementRef> }, fields: Element[]): void {
    for (const f of fields) {
      if (st.fields.size >= MAX_INVALID_FIELDS) return;
      const d = describeField(f);
      if (!st.fields.has(d.selector)) st.fields.set(d.selector, d);
    }
  }

  /** A native validation failure: one `invalid` per bad field, one attempt per submit. */
  private onInvalid(target: EventTarget | null): void {
    safe(() => {
      const field = target && (target as Node).nodeType === 1 ? (target as Element) : null;
      if (!field || !field.matches(FIELD)) return;
      const form = (field as HTMLInputElement).form ?? field.closest("form");
      if (!form) return;
      const st = this.formState(form);
      const now = Date.now();
      if (now - st.lastAttemptAt > 250) st.attempts++;
      st.lastAttemptAt = now;
      this.addFields(st, [field]);
    });
  }

  /**
   * A submit that native validation let through: the app's own validation
   * may still reject it. Within the click window, a field marked
   * aria-invalid (or :invalid under novalidate) or a non-empty role="alert"
   * in the form is a failed attempt; neither is a submit that passed.
   */
  private onSubmit(target: EventTarget | null): void {
    safe(() => {
      const form = target && (target as Node).nodeType === 1 ? (target as Element) : null;
      if (!form || !form.matches("form")) return;
      const route = currentRoute();
      setTimeout(() => {
        safe(() => {
          if (this.closed || this.unloading) return;
          if (!form.isConnected || currentRoute() !== route) {
            this.forms.delete(form);
            return;
          }
          const bad = Array.from(form.querySelectorAll('[aria-invalid="true"], :invalid')).filter((el) => el.matches(FIELD));
          const alert = Array.from(form.querySelectorAll('[role="alert"]')).some((el) => (el.textContent ?? "").trim() !== "");
          if (bad.length === 0 && !alert) {
            this.forms.delete(form);
            return;
          }
          const st = this.formState(form);
          st.attempts++;
          st.lastAttemptAt = Date.now();
          this.addFields(st, bad);
        });
      }, CLICK_WINDOW_MS);
    });
  }

  /** The page is being left: every form whose submit failed and never passed was abandoned. */
  private flushForms(): void {
    safe(() => {
      for (const [form, st] of this.forms) {
        if (st.attempts === 0) continue;
        const element = describeForm(form);
        this.pushFrustration(
          { kind: "form_abandon", at: nowIso(), route: st.route, element, fields: [...st.fields.values()], attempts: Math.min(100, st.attempts) },
          `form_abandon:${st.route}:${element.selector}`,
        );
      }
      this.forms.clear();
    });
  }

  // --- thrashing and dead links --------------------------------------------

  private onRouteChange(route: string, initial: boolean): void {
    if (!this.frustration) return;
    const now = Date.now();
    this.navTrail = this.navTrail.filter((n) => now - n.at <= THRASH_WINDOW_MS).slice(-8);
    this.navTrail.push({ route, at: now });
    if (!initial) {
      const r = this.navTrail.map((n) => n.route);
      let switches = 1;
      for (let i = r.length - 1; i >= 2 && r[i] === r[i - 2] && r[i] !== r[i - 1]; i--) switches++;
      if (switches + 1 >= THRASH_SWITCHES) {
        const pair = [r[r.length - 1]!, r[r.length - 2]!] as [string, string];
        const key = [...pair].sort().join("\u0000");
        if (!this.thrashReported.has(key)) {
          this.thrashReported.add(key);
          this.pushFrustration({ kind: "thrash", at: nowIso(), route, routes: pair, switches: switches + 1 }, `thrash:${key}`);
        }
      }
    }
    // A link that navigated to a page saying it does not exist.
    const link = this.pendingLink;
    this.pendingLink = null;
    if (!initial && link && now - link.at <= 2 * CLICK_WINDOW_MS) {
      setTimeout(() => {
        safe(() => {
          if (this.closed || this.unloading || currentRoute() !== route || !isNotFoundPage()) return;
          const element = describeElement(link.el);
          this.pushFrustration(
            { kind: "dead_click", at: new Date(link.at).toISOString(), route: link.route, element, reason: "not_found", to: route },
            `dead:${link.route}:${element.selector}:not_found`,
          );
        });
      }, CLICK_WINDOW_MS);
    }
  }

  private recordFailedRequest(method: string, url: string, status: number | null, started: number): void {
    safe(() => {
      const path = requestPath(url);
      const route = currentRoute();
      this.push(
        {
          kind: "failed_request",
          at: nowIso(),
          route,
          request: { method: cap(method.toUpperCase(), 10), path, status, durationMs: Math.max(0, Date.now() - started) },
        },
        `request:${method}:${path}:${status}`,
      );
    });
  }

  private onNavigation(initial = false): void {
    safe(() => {
      this.activity++;
      const route = currentRoute();
      if (!initial && route === this.lastRoute) return;
      if (!initial) this.flushForms();
      this.lastRoute = route;
      this.frustrationThisPage = 0;
      this.push({ kind: "navigation", at: nowIso(), route });
      this.onRouteChange(route, initial);
    });
  }

  private onHide(): void {
    safe(() => {
      // Hiding the page is a reaction to a click (a new tab, a download, a
      // dialog in another window): never a dead click.
      this.activity++;
      this.transport.flushOnHide();
    });
  }

  // --- clicks --------------------------------------------------------------

  private onClick(ev: MouseEvent): void {
    safe(() => {
      const el = clickTarget(ev.target);
      if (!el) return;
      const now = Date.now();
      const route = currentRoute();
      // Every click below is frustration-only.
      if (!this.frustration) return;
      this.lastClick = { el, at: now, route, errored: false };
      if (el.matches("a[href]")) this.pendingLink = { el, at: now, route };
      const h = this.clickHistory.get(el) ?? { times: [], burst: 0, startedAt: now, timer: null };
      h.times = h.times.filter((t) => now - t < CLICK_WINDOW_MS);
      h.times.push(now);
      this.clickHistory.set(el, h);

      if (h.burst > 0 || h.times.length >= RAGE_CLICKS) {
        // A burst: every click until the user stops for a second is part of
        // it, and the burst is ONE rage_click counting them all.
        if (h.burst === 0) {
          h.burst = h.times.length;
          h.startedAt = h.times[0] ?? now;
        } else {
          h.burst += 1;
        }
        if (h.timer) clearTimeout(h.timer);
        h.timer = setTimeout(() => {
          safe(() => {
            const clicks = h.burst;
            const at = new Date(h.startedAt).toISOString();
            h.burst = 0;
            h.times = [];
            h.timer = null;
            const element = describeElement(el);
            this.pushFrustration({ kind: "rage_click", at, route, element, clicks }, `rage:${route}:${element.selector}`);
          });
        }, CLICK_WINDOW_MS);
        return;
      }

      if (!isActionable(el)) return;
      const before = this.activity;
      setTimeout(() => {
        safe(() => {
          if (this.closed || this.unloading) return;
          // Part of a rage burst: that is the event, not this.
          if (h.burst > 0) return;
          if (this.activity !== before) return;
          if (!el.isConnected) return;
          // A double-click on a dead button is one dead button.
          const last = this.deadReportedAt.get(el) ?? 0;
          if (Date.now() - last < 5 * CLICK_WINDOW_MS) return;
          this.deadReportedAt.set(el, Date.now());
          const element = describeElement(el);
          this.pushFrustration(
            { kind: "dead_click", at: new Date(now).toISOString(), route, element },
            `dead:${route}:${element.selector}`,
          );
        });
      }, CLICK_WINDOW_MS);
    });
  }

  // --- patches -------------------------------------------------------------

  private listen(target: EventTarget, type: string, fn: (ev: Event) => void, capture = false): void {
    const handler = (ev: Event) => safe(() => fn(ev));
    target.addEventListener(type, handler, capture);
    this.listeners.push(() => target.removeEventListener(type, handler, capture));
  }

  private patchFetch(): void {
    if (typeof window.fetch !== "function") return;
    const original = window.fetch;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let method = "GET";
      let url = "";
      try {
        method = String(init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"));
        url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      } catch {
        /* recorded as best it can be */
      }
      const own = isEndpoint(url, self.endpoint);
      if (!own) self.activity++;
      const started = Date.now();
      // eslint-disable-next-line prefer-rest-params
      const result = original.apply(this ?? window, arguments as unknown as [RequestInfo | URL, RequestInit?]);
      if (own) return result;
      return result.then(
        (res) => {
          safe(() => {
            if (res && res.status >= 500) self.recordFailedRequest(method, url, res.status, started);
          });
          return res;
        },
        (err: unknown) => {
          safe(() => {
            if (!(err && (err as { name?: string }).name === "AbortError")) {
              self.recordFailedRequest(method, url, null, started);
            }
          });
          throw err;
        },
      );
    };
    window.fetch = wrapped as typeof fetch;
    this.patches.push({
      restore: () => {
        if (window.fetch === (wrapped as typeof fetch)) window.fetch = original;
      },
    });
  }

  private patchXhr(): void {
    if (typeof XMLHttpRequest === "undefined") return;
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const info = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
      safe(() => info.set(this, { method: String(method), url: String(url) }));
      // eslint-disable-next-line prefer-rest-params
      return originalOpen.apply(this, arguments as unknown as Parameters<typeof originalOpen>);
    } as typeof proto.open;
    proto.send = function (this: XMLHttpRequest) {
      safe(() => {
        const req = info.get(this);
        if (!req || isEndpoint(req.url, self.endpoint)) return;
        self.activity++;
        const started = Date.now();
        let aborted = false;
        this.addEventListener("abort", () => {
          aborted = true;
        });
        this.addEventListener("loadend", () => {
          safe(() => {
            if (aborted) return;
            if (this.status === 0) self.recordFailedRequest(req.method, req.url, null, started);
            else if (this.status >= 500) self.recordFailedRequest(req.method, req.url, this.status, started);
          });
        });
      });
      // eslint-disable-next-line prefer-rest-params
      return originalSend.apply(this, arguments as unknown as Parameters<typeof originalSend>);
    };
    this.patches.push({
      restore: () => {
        proto.open = originalOpen;
        proto.send = originalSend;
      },
    });
  }

  private patchHistory(): void {
    const h = window.history;
    if (!h) return;
    for (const name of ["pushState", "replaceState"] as const) {
      const original = h[name];
      if (typeof original !== "function") continue;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      const wrapped = function (this: History, ...args: Parameters<History["pushState"]>) {
        const out = original.apply(this, args);
        self.onNavigation();
        return out;
      };
      h[name] = wrapped;
      this.patches.push({
        restore: () => {
          if (h[name] === wrapped) h[name] = original;
        },
      });
    }
  }
}
