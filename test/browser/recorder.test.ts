// @vitest-environment happy-dom
// The recorder end to end in a browser (happy-dom): what a user hits becomes
// the right events, and the SDK never changes how the page behaves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureError, close, flush, getSessionId, init, setUser } from "../../src/browser/index";
import type { SessionBatch, SessionEvent } from "../../src/browser/types";

const ENDPOINT = "https://dashboard.bugstack.ai/api/v1/sessions/ingest";

// happy-dom delivers MutationObserver records on its own (real) timer, which
// fake timers do not drive: a DOM change needs a moment of real time.
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

let appFetch: ReturnType<typeof vi.fn>;
let sent: SessionBatch[];
let beacons: string[];

function events(): SessionEvent[] {
  return sent.flatMap((b) => b.events);
}

function kinds(kind: SessionEvent["kind"]): SessionEvent[] {
  return events().filter((e) => e.kind === kind);
}

async function settle(ms = 0): Promise<void> {
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
  await flush();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  sessionStorage.clear();
  document.body.innerHTML = "";
  history.replaceState({}, "", "/");
  sent = [];
  beacons = [];
  // happy-dom's own sendBeacon makes a real request; the page under test has none.
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body: string) => (beacons.push(`${url} ${body}`), true),
  });
  appFetch = vi.fn(async (input: RequestInfo | URL, initArg?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(ENDPOINT)) {
      sent.push(JSON.parse(String(initArg?.body)));
      return new Response(null, { status: 202 });
    }
    if (url.includes("/boom")) return new Response("no", { status: 503 });
    if (url.includes("/offline")) throw new TypeError("Failed to fetch");
    return new Response("ok", { status: 200 });
  });
  window.fetch = appFetch as unknown as typeof fetch;
});

afterEach(() => {
  close();
  vi.useRealTimers();
});

describe("init", () => {
  it("records the first page, and a route change", async () => {
    init({ key: "pk_1", frustration: true });
    history.pushState({}, "", "/settings?tab=billing");
    await settle();
    expect(kinds("navigation").map((e) => (e as { route: string }).route)).toEqual(["/", "/settings"]);
    expect(getSessionId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("keeps one session id for the browser session", () => {
    init({ key: "pk_1", frustration: true });
    const first = getSessionId();
    close();
    init({ key: "pk_1", frustration: true });
    expect(getSessionId()).toBe(first);
  });

  it("records nothing for a session outside the sample", () => {
    init({ key: "pk_1", sampleRate: 0 });
    expect(getSessionId()).toBeNull();
    expect(window.fetch).toBe(appFetch);
  });

  it("sends the user it was told about, and the release", async () => {
    init({ key: "pk_1", release: "web@1.4.2" });
    setUser({ id: "42", email: "jo@example.com" });
    await settle();
    expect(sent[0]).toMatchObject({ v: 1, release: "web@1.4.2", user: { id: "42", email: "jo@example.com" } });
  });
});

describe("failed requests", () => {
  it("records a 5xx by path, without the query, and hands back the same Response", async () => {
    init({ key: "pk_1", frustration: true });
    const res = await window.fetch("/api/boom?email=jo@example.com");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("no");
    await settle();
    expect(kinds("failed_request")).toEqual([
      expect.objectContaining({ request: expect.objectContaining({ method: "GET", path: "/api/boom", status: 503 }) }),
    ]);
    expect(JSON.stringify(sent)).not.toContain("jo@example.com");
  });

  it("re-throws a network failure unchanged and records it with no status", async () => {
    init({ key: "pk_1", frustration: true });
    await expect(window.fetch("/api/offline", { method: "post" })).rejects.toThrow("Failed to fetch");
    await settle();
    expect(kinds("failed_request")[0]).toMatchObject({ request: { method: "POST", path: "/api/offline", status: null } });
  });

  it("ignores successes, aborts and its own endpoint", async () => {
    init({ key: "pk_1", frustration: true });
    await window.fetch("/api/fine");
    appFetch.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(window.fetch("/api/cancelled")).rejects.toThrow("aborted");
    await window.fetch(`${ENDPOINT}?key=pk_1`, { method: "POST", body: JSON.stringify({ v: 1, sessionId: "x", events: [] }) });
    await settle();
    expect(kinds("failed_request")).toEqual([]);
  });

  it("records an XHR answered 5xx", async () => {
    class FakeXhr extends EventTarget {
      status = 0;
      open(_m: string, _u: string) {}
      send() {
        this.status = 500;
        this.dispatchEvent(new Event("loadend"));
      }
    }
    const real = globalThis.XMLHttpRequest;
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
    try {
      init({ key: "pk_1", frustration: true });
      const xhr = new FakeXhr() as unknown as XMLHttpRequest;
      xhr.open("PUT", "/api/items/7?draft=1");
      xhr.send();
      await settle();
      expect(kinds("failed_request")[0]).toMatchObject({ request: { method: "PUT", path: "/api/items/7", status: 500 } });
    } finally {
      close();
      (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = real;
    }
  });

  it("restores fetch on close", () => {
    init({ key: "pk_1", frustration: true });
    expect(window.fetch).not.toBe(appFetch);
    close();
    expect(window.fetch).toBe(appFetch);
  });
});

describe("clicks", () => {
  it("a burst of clicks is one rage click, and not a dead click", async () => {
    document.body.innerHTML = `<button class="save">Save</button>`;
    init({ key: "pk_1", frustration: true });
    const btn = document.querySelector("button")!;
    for (let i = 0; i < 5; i++) {
      btn.click();
      await vi.advanceTimersByTimeAsync(100);
    }
    await settle(1500);
    expect(kinds("rage_click")).toEqual([
      expect.objectContaining({ clicks: 5, element: { selector: "body > button.save", label: "Save" } }),
    ]);
    expect(kinds("dead_click")).toEqual([]);
  });

  it("a click on a button that does nothing is a dead click, once", async () => {
    document.body.innerHTML = `<button id="pay">Pay now</button>`;
    init({ key: "pk_1", frustration: true });
    const btn = document.querySelector("button")!;
    btn.click();
    await vi.advanceTimersByTimeAsync(300);
    btn.click();
    await settle(1500);
    expect(kinds("dead_click")).toEqual([
      expect.objectContaining({ route: "/", element: { selector: "button#pay", label: "Pay now" } }),
    ]);
  });

  it("a click that changes the page, calls the server or navigates is alive", async () => {
    document.body.innerHTML = `<button id="a">A</button><button id="b">B</button><button id="c">C</button>`;
    document.getElementById("a")!.addEventListener("click", () => {
      document.body.appendChild(document.createElement("p"));
    });
    document.getElementById("b")!.addEventListener("click", () => {
      void window.fetch("/api/fine");
    });
    document.getElementById("c")!.addEventListener("click", () => {
      history.pushState({}, "", "/next");
    });
    init({ key: "pk_1", frustration: true });
    for (const id of ["a", "b", "c"]) {
      document.getElementById(id)!.click();
      await realWait(20);
      await vi.advanceTimersByTimeAsync(1200);
    }
    await settle(1500);
    expect(kinds("dead_click")).toEqual([]);
  });

  it("never reports a disabled button or a new-tab link as dead", async () => {
    document.body.innerHTML = `<button disabled>Off</button><a href="/doc" target="_blank">Docs</a><div>plain text</div>`;
    // happy-dom would really open the tab; the test only needs the click.
    document.querySelector("a")!.addEventListener("click", (e) => e.preventDefault());
    init({ key: "pk_1", frustration: true });
    (document.querySelector("button") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    (document.querySelector("a") as HTMLAnchorElement).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    (document.querySelector("div") as HTMLDivElement).click();
    await settle(1500);
    expect(kinds("dead_click")).toEqual([]);
  });

  it("never sends what a user typed", async () => {
    document.body.innerHTML = `<form><input id="email" value="jo@example.com"><input type="password" value="hunter2"><textarea>private</textarea></form>`;
    init({ key: "pk_1", frustration: true });
    const input = document.getElementById("email")!;
    for (let i = 0; i < 4; i++) input.click();
    await settle(1500);
    expect(kinds("rage_click")).toHaveLength(1);
    const wire = JSON.stringify(sent);
    for (const secret of ["jo@example.com", "hunter2", "private"]) expect(wire).not.toContain(secret);
  });
});

describe("errors", () => {
  it("records an uncaught error and an unhandled rejection", async () => {
    init({ key: "pk_1", frustration: true });
    const err = new TypeError("cannot read 'total' of undefined");
    window.dispatchEvent(new ErrorEvent("error", { error: err, message: err.message, filename: "https://app.acme.com/app.js" }));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = { code: 42 };
    window.dispatchEvent(rejection);
    await settle();
    expect(kinds("error")).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ name: "TypeError", message: "cannot read 'total' of undefined" }) }),
      expect.objectContaining({ error: { name: "UnhandledRejection", message: '{"code":42}' } }),
    ]);
  });

  it("ignores a cross-origin 'Script error.' with nothing in it", async () => {
    init({ key: "pk_1", frustration: true });
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    await settle();
    expect(kinds("error")).toEqual([]);
  });

  it("caps the same error looping on one page", async () => {
    init({ key: "pk_1", frustration: true });
    for (let i = 0; i < 50; i++) captureError(new Error("render loop"));
    await settle();
    expect(kinds("error")).toHaveLength(5);
  });
});

describe("transport through the page", () => {
  it("sends what is left by beacon when the page hides", async () => {
    init({ key: "pk_1", frustration: true });
    captureError(new Error("late"));
    window.dispatchEvent(new Event("pagehide"));
    expect(beacons).toHaveLength(1);
    expect(beacons[0]).toContain(`${ENDPOINT}?key=pk_1`);
    expect(beacons[0]).toContain("late");
  });

  it("flushes on its own every few seconds", async () => {
    init({ key: "pk_1", frustration: true });
    await vi.advanceTimersByTimeAsync(5100);
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("never hurts the page", () => {
  it("ignores bad input instead of throwing", () => {
    expect(() => init(undefined as never)).not.toThrow();
    expect(() => init({ key: "" })).not.toThrow();
    expect(getSessionId()).toBeNull();
    init({ key: "pk_1", frustration: true });
    expect(() => setUser({ id: 7 as never, email: 9 as never })).not.toThrow();
    expect(() => captureError(undefined)).not.toThrow();
    expect(() => captureError(Object.create(null))).not.toThrow();
    expect(() => init({ key: "pk_2" })).not.toThrow();
  });

  it("an app's own fetch errors pass through unchanged", async () => {
    init({ key: "pk_1", frustration: true });
    const boom = new RangeError("bad input");
    appFetch.mockImplementationOnce(() => {
      throw boom;
    });
    expect(() => window.fetch("/x")).toThrow(boom);
  });
});
