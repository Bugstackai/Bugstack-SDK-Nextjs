// Batching and sending. A batch is at most 100 events and 64 KB (the most a
// keepalive fetch or a beacon will carry). Sends go through the page's
// ORIGINAL fetch, captured before the SDK wraps it, so the SDK never records
// or counts its own traffic.
//
//   2xx        sent
//   429        backed off (10 s, doubling to 5 min), the batch kept
//   401 / 403  the key is wrong for this page: stop sending for the page
//   400 / 413  the server will never read this batch: dropped
//   other      kept and retried, at most 3 times
//
// On page hide the queue goes out by navigator.sendBeacon, which cannot set
// headers, so a beacon carries the key as `?key=` on the URL.

import type { SessionBatch, SessionEvent, SessionUser } from "./types.js";

export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_BATCH_BYTES = 64 * 1024;
/** The most events held while sending is impossible (offline, backed off). */
export const MAX_QUEUED_EVENTS = 500;
const MAX_ATTEMPTS = 3;

export function byteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length * 3;
  }
}

export type BatchEnvelope = Omit<SessionBatch, "events">;

/**
 * Take the next batch off the front of `queue`: as many events as fit in 100
 * and 64 KB. An event that cannot fit even alone is dropped. Pure on its inputs
 * (mutates `queue` by removing what it takes).
 */
export function takeBatch(queue: SessionEvent[], envelope: BatchEnvelope): SessionBatch | null {
  const events: SessionEvent[] = [];
  const overhead = byteLength(JSON.stringify({ ...envelope, events: [] }));
  let bytes = overhead;
  while (queue.length > 0 && events.length < MAX_EVENTS_PER_BATCH) {
    const next = queue[0]!;
    const size = byteLength(JSON.stringify(next)) + 1;
    if (bytes + size > MAX_BATCH_BYTES) {
      if (events.length === 0) {
        queue.shift(); // cannot fit even alone
        continue;
      }
      break;
    }
    events.push(next);
    bytes += size;
    queue.shift();
  }
  return events.length > 0 ? { ...envelope, events } : null;
}

export type TransportDeps = {
  endpoint: string;
  key: string;
  fetchImpl: typeof fetch | undefined;
  beacon: ((url: string, body: string) => boolean) | undefined;
  now: () => number;
};

export class Transport {
  private queue: SessionEvent[] = [];
  private stopped = false;
  private backoffMs = 0;
  private notBefore = 0;
  private inFlight = false;
  private attempts = 0;

  constructor(
    private readonly deps: TransportDeps,
    private readonly envelope: () => BatchEnvelope,
  ) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  get size(): number {
    return this.queue.length;
  }

  push(event: SessionEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUED_EVENTS) this.queue.splice(0, this.queue.length - MAX_QUEUED_EVENTS);
  }

  /** Send one batch by fetch, when allowed. Never rejects. */
  async flush(): Promise<void> {
    if (this.stopped || this.inFlight || this.queue.length === 0) return;
    if (this.deps.now() < this.notBefore) return;
    const fetchImpl = this.deps.fetchImpl;
    if (!fetchImpl) return;
    const batch = takeBatch(this.queue, this.envelope());
    if (!batch) return;
    this.inFlight = true;
    try {
      const res = await fetchImpl(this.deps.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BugStack-Key": this.deps.key },
        body: JSON.stringify(batch),
        keepalive: true,
        credentials: "omit",
      });
      this.settle(res.status, batch.events);
    } catch {
      this.retry(batch.events);
    } finally {
      this.inFlight = false;
    }
  }

  /** On page hide: everything left, by beacon (falls back to keepalive fetch). */
  flushOnHide(): void {
    if (this.stopped) return;
    while (this.queue.length > 0) {
      const batch = takeBatch(this.queue, this.envelope());
      if (!batch) return;
      const body = JSON.stringify(batch);
      const url = beaconUrl(this.deps.endpoint, this.deps.key);
      let sent = false;
      try {
        sent = this.deps.beacon ? this.deps.beacon(url, body) : false;
      } catch {
        sent = false;
      }
      if (!sent && this.deps.fetchImpl) {
        try {
          void this.deps
            .fetchImpl(this.deps.endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-BugStack-Key": this.deps.key },
              body,
              keepalive: true,
              credentials: "omit",
            })
            .catch(() => {});
        } catch {
          /* the page is going away */
        }
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  private settle(status: number, events: SessionEvent[]): void {
    if (status >= 200 && status < 300) {
      this.backoffMs = 0;
      this.attempts = 0;
      return;
    }
    if (status === 401 || status === 403) {
      this.stop();
      return;
    }
    if (status === 429) {
      this.backoffMs = this.backoffMs === 0 ? 10_000 : Math.min(this.backoffMs * 2, 300_000);
      this.notBefore = this.deps.now() + this.backoffMs;
      this.queue.unshift(...events);
      return;
    }
    if (status === 400 || status === 413) return;
    this.retry(events);
  }

  private retry(events: SessionEvent[]): void {
    this.attempts += 1;
    if (this.attempts >= MAX_ATTEMPTS) {
      this.attempts = 0;
      return; // dropped
    }
    this.queue.unshift(...events);
    if (this.queue.length > MAX_QUEUED_EVENTS) this.queue.length = MAX_QUEUED_EVENTS;
  }
}

export function beaconUrl(endpoint: string, key: string): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
}

export function envelopeFor(input: {
  sessionId: string;
  user: SessionUser | null;
  release?: string;
  environment?: string;
}): BatchEnvelope {
  const env: BatchEnvelope = { v: 1, sessionId: input.sessionId };
  if (input.user && (input.user.id || input.user.email)) env.user = input.user;
  if (input.release) env.release = input.release;
  if (input.environment) env.environment = input.environment;
  return env;
}
