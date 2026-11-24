// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { MAX_BATCH_BYTES, Transport, beaconUrl, byteLength, takeBatch } from "../../src/browser/transport";
import type { SessionEvent } from "../../src/browser/types";

const nav = (i: number): SessionEvent => ({ kind: "navigation", at: "2026-10-28T00:00:00.000Z", route: `/p/${i}` });
const big = (i: number): SessionEvent => ({
  kind: "error",
  at: "2026-10-28T00:00:00.000Z",
  route: "/",
  error: { name: "Error", message: `e${i}`, stack: "x".repeat(8000) },
});
const envelope = { v: 1 as const, sessionId: "s_abcdefgh" };

describe("takeBatch", () => {
  it("takes at most 100 events", () => {
    const q = Array.from({ length: 150 }, (_, i) => nav(i));
    expect(takeBatch(q, envelope)!.events).toHaveLength(100);
    expect(takeBatch(q, envelope)!.events).toHaveLength(50);
    expect(takeBatch(q, envelope)).toBeNull();
  });

  it("keeps every batch under 64 KB", () => {
    const q = Array.from({ length: 20 }, (_, i) => big(i));
    let total = 0;
    for (let b = takeBatch(q, envelope); b; b = takeBatch(q, envelope)) {
      expect(byteLength(JSON.stringify(b))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      total += b.events.length;
    }
    expect(total).toBe(20);
  });

  it("drops an event that cannot fit even alone", () => {
    const huge: SessionEvent = { ...big(0), error: { name: "E", message: "m", stack: "y".repeat(70_000) } } as SessionEvent;
    const q = [huge, nav(1)];
    expect(takeBatch(q, envelope)!.events).toEqual([nav(1)]);
  });
});

function transport(fetchImpl: ReturnType<typeof vi.fn>, beacon?: (u: string, b: string) => boolean) {
  let now = 0;
  const t = new Transport(
    { endpoint: "https://dashboard.bugstack.ai/api/v1/sessions/ingest", key: "pk_1", fetchImpl: fetchImpl as never, beacon, now: () => now },
    () => envelope,
  );
  return { t, advance: (ms: number) => (now += ms) };
}

describe("Transport", () => {
  it("sends with the key header and JSON", async () => {
    const f = vi.fn(async () => new Response(null, { status: 202 }));
    const { t } = transport(f);
    t.push(nav(1));
    await t.flush();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://dashboard.bugstack.ai/api/v1/sessions/ingest");
    expect((init as RequestInit).headers).toMatchObject({ "X-BugStack-Key": "pk_1" });
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ v: 1, sessionId: "s_abcdefgh", events: [nav(1)] });
    expect(t.size).toBe(0);
  });

  it("stops for the page on 401 / 403", async () => {
    const f = vi.fn(async () => new Response(null, { status: 401 }));
    const { t } = transport(f);
    t.push(nav(1));
    await t.flush();
    t.push(nav(2));
    expect(t.isStopped).toBe(true);
    expect(t.size).toBe(0);
  });

  it("backs off on 429 and keeps the events", async () => {
    const f = vi.fn(async () => new Response(null, { status: 429 }));
    const { t, advance } = transport(f);
    t.push(nav(1));
    await t.flush();
    expect(t.size).toBe(1);
    await t.flush(); // still backed off
    expect(f).toHaveBeenCalledTimes(1);
    advance(10_001);
    await t.flush();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("on page hide, sends by beacon with the key in the URL", () => {
    const sent: Array<{ url: string; body: string }> = [];
    const f = vi.fn();
    const { t } = transport(f, (url, body) => (sent.push({ url, body }), true));
    t.push(nav(1));
    t.flushOnHide();
    expect(sent[0]!.url).toBe("https://dashboard.bugstack.ai/api/v1/sessions/ingest?key=pk_1");
    expect(JSON.parse(sent[0]!.body).events).toHaveLength(1);
    expect(f).not.toHaveBeenCalled();
  });

  it("beaconUrl appends to an existing query", () => {
    expect(beaconUrl("https://x.test/i?a=1", "k&1")).toBe("https://x.test/i?a=1&key=k%261");
  });
});
