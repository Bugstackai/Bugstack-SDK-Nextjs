// The wire format of Bugstack's session ingest (POST /api/v1/sessions/ingest).
// Ported from the Bugstack monorepo's packages/browser-sdk, plus the
// frustration kinds. The ingest route validates the same shape.

export type ElementRef = { selector: string; label?: string };

export type SessionEvent =
  | { kind: "navigation"; at: string; route: string }
  | {
      kind: "error";
      at: string;
      route: string;
      error: { name: string; message: string; stack?: string };
    }
  | {
      kind: "failed_request";
      at: string;
      route: string;
      request: { method: string; path: string; status: number | null; durationMs: number };
    }
  | { kind: "rage_click"; at: string; route: string; element: ElementRef; clicks: number }
  | {
      kind: "dead_click";
      at: string;
      route: string;
      element: ElementRef;
      /** Set when the click DID navigate, to a page that says it does not exist. */
      reason?: "not_found";
      /** For `not_found`: where the link went (path only). */
      to?: string;
    }
  | {
      kind: "error_click";
      at: string;
      route: string;
      element: ElementRef;
      /** The error's class and a short message; the full error is its own `error` event. */
      error: { name: string; message: string };
    }
  | {
      kind: "form_abandon";
      at: string;
      route: string;
      /** The form: its selector, labelled by its submit control. */
      element: ElementRef;
      /** Fields that showed a validation error: selector and label, never a value. */
      fields: ElementRef[];
      /** Submits that hit a validation error. */
      attempts: number;
    }
  | { kind: "thrash"; at: string; route: string; routes: [string, string]; switches: number };

export type SessionUser = { id?: string; email?: string };

export type SessionBatch = {
  v: 1;
  sessionId: string;
  user?: SessionUser;
  release?: string;
  environment?: string;
  events: SessionEvent[];
};

export type BrowserConfig = {
  /** The repository's BROWSER key (public; never the server SDK key). */
  key: string;
  /** Defaults to https://dashboard.bugstack.ai/api/v1/sessions/ingest. */
  endpoint?: string;
  /** The release the page is running, e.g. "web@1.4.2". */
  release?: string;
  environment?: string;
  /** Share of browser sessions recorded, 0..1. Default 1. Decided once per session. */
  sampleRate?: number;
  /**
   * Frustration signals: rage clicks, dead clicks, clicks followed by an
   * error, forms left after a validation error, and rapid back-and-forth
   * between two pages. OFF unless set. `true`, or an object to tune it.
   * Never records an input's value or any text beyond a short element label.
   */
  frustration?: boolean | FrustrationConfig;
};

export type FrustrationConfig = {
  /** Default true when the object is given. */
  enabled?: boolean;
  /** Share of RECORDED sessions that also record frustration, 0..1. Default 1. Decided once per session. */
  sampleRate?: number;
  /** The most frustration events one page view sends. Default 20. */
  maxPerPage?: number;
};
