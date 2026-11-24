// @vitest-environment happy-dom
// Frustration signals end to end in a browser (happy-dom): OFF unless asked,
// and what each signal records (never a value).

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

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("frustration is off unless asked", () => {
  it("records no click signal without `frustration`", async () => {
    init({ key: "pk_1" });
    document.body.innerHTML = '<button id="b">Save</button>';
    const b = document.getElementById("b")!;
    for (let i = 0; i < 5; i++) click(b);
    click(b);
    await settle(3000);
    expect(events().filter((e) => e.kind !== "navigation")).toEqual([]);
  });

  it("`{ enabled: false }` and a zero sample rate are off too", async () => {
    init({ key: "pk_1", frustration: { enabled: false } });
    document.body.innerHTML = '<button id="b">Save</button>';
    click(document.getElementById("b")!);
    await settle(1500);
    expect(kinds("dead_click")).toEqual([]);
    close();
    sessionStorage.clear();
    sent = [];
    init({ key: "pk_1", frustration: { sampleRate: 0 } });
    document.body.innerHTML = '<button id="c">Save</button>';
    click(document.getElementById("c")!);
    await settle(1500);
    expect(kinds("dead_click")).toEqual([]);
  });
});

describe("error click", () => {
  it("a click followed by an uncaught error is an error click on that element", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<button data-testid="pay">Pay now</button>';
    const b = document.querySelector("button")!;
    b.addEventListener("click", () => {
      window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new TypeError("cart is undefined") }));
    });
    click(b);
    await settle(1500);
    expect(kinds("error")).toHaveLength(1);
    expect(kinds("error_click")).toEqual([
      expect.objectContaining({
        kind: "error_click",
        route: "/",
        element: { selector: 'body > button[data-testid="pay"]', label: "Pay now" },
        error: { name: "TypeError", message: "cart is undefined" },
      }),
    ]);
  });

  it("a click that throws is an error click, never also a dead click", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<button id="pay">Pay now</button>';
    const b = document.getElementById("pay")!;
    b.addEventListener("click", () => {
      window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new TypeError("cart is undefined") }));
    });
    click(b);
    await settle(1500);
    expect(kinds("error_click")).toHaveLength(1);
    expect(kinds("dead_click")).toEqual([]);
  });

  it("an error long after the click is not an error click", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<button id="b">Go</button>';
    click(document.getElementById("b")!);
    await vi.advanceTimersByTimeAsync(2000);
    captureError(new Error("later"));
    await settle(100);
    expect(kinds("error_click")).toEqual([]);
  });
});

describe("form abandon", () => {
  it("a form the app's validation rejects, then left, is abandoned with its fields and never their values", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML =
      '<form id="signup"><label for="email">Email</label><input id="email" name="email" value="jo@example.com"><button>Sign up</button></form>';
    const form = document.getElementById("signup") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      document.getElementById("email")!.setAttribute("aria-invalid", "true");
    });
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1100);
    history.pushState({}, "", "/elsewhere");
    await settle(10);
    const [ev] = kinds("form_abandon");
    expect(ev).toEqual(
      expect.objectContaining({
        route: "/",
        element: { selector: "form#signup", label: "Sign up" },
        fields: [{ selector: "input#email", label: "Email" }],
        attempts: 1,
      }),
    );
    expect(JSON.stringify(sent)).not.toContain("jo@example.com");
  });

  it("resubmitting a rejected form is not a dead click on its button", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<form id="f"><input id="email" aria-invalid="true"><p role="alert">Bad email</p><button>Create account</button></form>';
    const form = document.getElementById("f") as HTMLFormElement;
    form.addEventListener("submit", (e) => e.preventDefault());
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1100);
    click(form.querySelector("button")!);
    await settle(1500);
    expect(kinds("dead_click")).toEqual([]);
  });

  it("a failed submit fixed by a passing one is not abandoned", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<form id="f"><input id="zip"><button>Save</button></form>';
    const form = document.getElementById("f") as HTMLFormElement;
    const zip = document.getElementById("zip")!;
    zip.setAttribute("aria-invalid", "true");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1100);
    zip.removeAttribute("aria-invalid");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1100);
    history.pushState({}, "", "/done");
    await settle(10);
    expect(kinds("form_abandon")).toEqual([]);
  });

  it("a fixed submit that navigates away at once is a success, not an abandon", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<form id="f"><input id="email"><button>Create account</button></form>';
    const form = document.getElementById("f") as HTMLFormElement;
    const email = document.getElementById("email")!;
    email.setAttribute("aria-invalid", "true");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1100);
    email.removeAttribute("aria-invalid");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(100);
    history.pushState({}, "", "/welcome");
    await settle(1500);
    expect(kinds("form_abandon")).toEqual([]);
  });

  it("native `invalid` events count as one failed attempt per submit", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<form id="f"><input id="a" aria-label="Phone" required><input id="b" placeholder="City" required><button>Go</button></form>';
    document.getElementById("a")!.dispatchEvent(new Event("invalid", { cancelable: true }));
    document.getElementById("b")!.dispatchEvent(new Event("invalid", { cancelable: true }));
    window.dispatchEvent(new Event("pagehide"));
    await settle(10);
    expect(kinds("form_abandon")).toHaveLength(0); // beacon on hide
    const beacon = beacons.join("\n");
    expect(beacon).toContain('"kind":"form_abandon"');
    expect(beacon).toContain('"attempts":1');
    expect(beacon).toContain('"label":"Phone"');
    expect(beacon).toContain('"label":"City"');
  });
});

describe("thrash", () => {
  it("alternating between two routes four times within 10 s is thrashing, once", async () => {
    init({ key: "pk_1", frustration: true });
    for (const r of ["/b", "/", "/b", "/", "/b"]) {
      history.pushState({}, "", r);
      await vi.advanceTimersByTimeAsync(500);
    }
    await settle(10);
    const t = kinds("thrash");
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual(expect.objectContaining({ kind: "thrash", switches: 4 }));
    expect([...(t[0] as { routes: string[] }).routes].sort()).toEqual(["/", "/b"]);
  });

  it("ordinary browsing is not thrashing", async () => {
    init({ key: "pk_1", frustration: true });
    for (const r of ["/list", "/item/1", "/list", "/item/2", "/list", "/item/3"]) {
      history.pushState({}, "", r);
      await vi.advanceTimersByTimeAsync(500);
    }
    await settle(10);
    expect(kinds("thrash")).toEqual([]);
  });
});

describe("dead link", () => {
  it("a link that lands on a not-found page is a dead click on the link, with where it went", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<a href="/teams">Teams</a>';
    const a = document.querySelector("a")!;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      history.pushState({}, "", "/teams");
      const m = document.createElement("meta");
      m.setAttribute("name", "next-error");
      m.setAttribute("content", "not-found");
      document.head.appendChild(m);
    });
    click(a);
    await settle(1500);
    document.head.innerHTML = "";
    expect(kinds("dead_click")).toEqual([
      expect.objectContaining({ route: "/", element: { selector: "body > a", label: "Teams" }, reason: "not_found", to: "/teams" }),
    ]);
  });
});

describe("dead link that reloads the page", () => {
  it("the next page's first load finishes the check the previous page started", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<a href="/teams">Meet our team</a>';
    click(document.querySelector("a")!);
    // The framework reloads: this page's recorder goes, a new one starts on /teams.
    close();
    sent = [];
    history.replaceState({}, "", "/teams");
    document.title = "404: This page could not be found.";
    init({ key: "pk_1", frustration: true });
    await settle(1500);
    document.title = "";
    expect(kinds("dead_click")).toEqual([
      expect.objectContaining({ route: "/", element: { selector: "body > a", label: "Meet our team" }, reason: "not_found", to: "/teams" }),
    ]);
  });

  it("a link to a page that exists is not a dead link", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<a href="/team">Team</a>';
    click(document.querySelector("a")!);
    close();
    sent = [];
    history.replaceState({}, "", "/team");
    init({ key: "pk_1", frustration: true });
    await settle(1500);
    expect(kinds("dead_click")).toEqual([]);
  });
});

describe("controls already selected", () => {
  it("clicking the active filter or the current page link is not a dead click", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<button id="f" aria-pressed="true">all</button><a id="c" href="/" aria-current="page">Home</a><button id="g" aria-pressed="false">open</button>';
    for (const id of ["f", "c", "g"]) {
      click(document.getElementById(id)!);
      await vi.advanceTimersByTimeAsync(1100);
    }
    await settle(10);
    expect(kinds("dead_click").map((e) => (e as { element: { label?: string } }).element.label)).toEqual(["open"]);
  });
});

describe("selectors", () => {
  it("leave an ancestor's state classes out, so one button is one element", async () => {
    init({ key: "pk_1", frustration: true });
    document.body.innerHTML = '<main class="dark"><button class="save">Save</button></main>';
    const b = document.querySelector("button")!;
    for (let i = 0; i < 3; i++) click(b);
    await settle(1500);
    expect((kinds("rage_click")[0] as { element: { selector: string } }).element.selector).toBe("body > main > button.save");
  });
});

describe("caps", () => {
  it("sends at most maxPerPage frustration events a page view", async () => {
    init({ key: "pk_1", frustration: { maxPerPage: 2 } });
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button><button id="c">C</button>';
    for (const id of ["a", "b", "c"]) {
      click(document.getElementById(id)!);
      await vi.advanceTimersByTimeAsync(1100);
    }
    await settle(10);
    expect(kinds("dead_click")).toHaveLength(2);
  });
});
