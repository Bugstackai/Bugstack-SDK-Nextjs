// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { describeElement, isActionable, isEndpoint, labelFor, requestPath, selectorFor } from "../../src/browser/redact";

const base = { href: "https://app.acme.com/settings?tab=1", origin: "https://app.acme.com" };

describe("requestPath", () => {
  it("keeps the path of a same-origin request, never the query or hash", () => {
    expect(requestPath("/api/profile?email=jo@example.com#x", base)).toBe("/api/profile");
    expect(requestPath("https://app.acme.com/api/orders/42?token=abc", base)).toBe("/api/orders/42");
  });

  it("keeps host + path for a third-party request", () => {
    expect(requestPath("https://api.stripe.com/v1/charges?key=sk_live_1", base)).toBe("api.stripe.com/v1/charges");
  });
});

describe("isEndpoint", () => {
  it("matches the SDK's own endpoint whatever its query", () => {
    const ep = "https://dashboard.bugstack.ai/api/v1/sessions/ingest";
    expect(isEndpoint(`${ep}?key=pk_1`, ep, base)).toBe(true);
    expect(isEndpoint("https://dashboard.bugstack.ai/api/v1/other", ep, base)).toBe(false);
  });
});

describe("selectorFor", () => {
  it("names the element by tag, id, stable classes and test id, stopping at an id", () => {
    document.body.innerHTML = `
      <main id="app"><form class="profile css-1x9f8k2z"><div class="row">
        <button class="btn btn-primary extra" data-testid="save">Save</button>
      </div></form></main>`;
    const btn = document.querySelector("button")!;
    expect(selectorFor(btn)).toBe('main#app > form.profile > div.row > button.btn.btn-primary[data-testid="save"]');
  });

  it("is at most 200 characters", () => {
    document.body.innerHTML = `<div class="${"a".repeat(39)} ${"b".repeat(39)}"><div class="${"c".repeat(39)} ${"d".repeat(39)}"><div class="${"e".repeat(39)} ${"f".repeat(39)}"><span class="${"g".repeat(39)}">x</span></div></div></div>`;
    expect(selectorFor(document.querySelector("span")!).length).toBeLessThanOrEqual(200);
  });
});

describe("labelFor: never a form field's value", () => {
  it("uses visible text for a button, cut to 60 characters", () => {
    document.body.innerHTML = `<button>  Save   your  changes  </button><button>${"x".repeat(100)}</button>`;
    const [a, b] = Array.from(document.querySelectorAll("button"));
    expect(labelFor(a!)).toBe("Save your changes");
    expect(labelFor(b!)!.length).toBe(60);
  });

  it("never reads an input, textarea or password value", () => {
    document.body.innerHTML = `
      <input id="email" value="jo@example.com">
      <input id="pw" type="password" value="hunter2">
      <textarea id="note">my secret note</textarea>
      <label id="wrap">Name <input value="Jo Bloggs"></label>
      <div id="ed" contenteditable="true">draft text</div>`;
    for (const id of ["email", "pw", "note", "wrap", "ed"]) {
      expect(labelFor(document.getElementById(id)!)).toBeUndefined();
    }
    const all = JSON.stringify(
      ["email", "pw", "note", "wrap", "ed"].map((id) => describeElement(document.getElementById(id)!)),
    );
    for (const secret of ["jo@example.com", "hunter2", "my secret note", "Jo Bloggs", "draft text"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("prefers aria-label", () => {
    document.body.innerHTML = `<button aria-label="Close dialog">×</button>`;
    expect(labelFor(document.querySelector("button")!)).toBe("Close dialog");
  });
});

describe("isActionable", () => {
  it("knows what a click is expected to do", () => {
    document.body.innerHTML = `
      <button id="b">x</button><button id="d" disabled>x</button>
      <a id="l" href="/x">x</a><a id="n" href="/x" target="_blank">x</a><a id="m" href="mailto:a@b.c">x</a>
      <div id="r" role="button">x</div><div id="p">x</div><input id="s" type="submit">`;
    const act = (id: string) => isActionable(document.getElementById(id)!);
    expect(act("b")).toBe(true);
    expect(act("d")).toBe(false);
    expect(act("l")).toBe(true);
    expect(act("n")).toBe(false);
    expect(act("m")).toBe(false);
    expect(act("r")).toBe(true);
    expect(act("p")).toBe(false);
    expect(act("s")).toBe(true);
  });
});
