// What may leave the page, and in what shape. Every value the SDK records goes
// through one of these, so the privacy rules live in one file:
//
//   - a route or request is a PATH: never a query string or a hash (tokens,
//     emails and search terms live there);
//   - an element is a SELECTOR and a short visible LABEL: never an input's,
//     textarea's or password field's value, and never the text of anything
//     editable;
//   - every string is capped.

/** The route the user is on: the path only. */
export function currentRoute(loc: Pick<Location, "pathname"> = location): string {
  return cap(loc.pathname || "/", 300);
}

/**
 * What a request was to: the path for a same-origin request, host + path for a
 * third-party one. Never the query or the hash.
 */
export function requestPath(raw: string, base: Pick<Location, "href" | "origin"> = location): string {
  try {
    const u = new URL(raw, base.href);
    return cap(u.origin === base.origin ? u.pathname : `${u.host}${u.pathname}`, 300);
  } catch {
    return cap(String(raw).split(/[?#]/)[0] ?? "", 300);
  }
}

/** Whether a URL is the SDK's own endpoint (any query): never recorded. */
export function isEndpoint(raw: string, endpoint: string, base: Pick<Location, "href"> = location): boolean {
  try {
    const u = new URL(raw, base.href);
    const e = new URL(endpoint, base.href);
    return u.origin === e.origin && u.pathname === e.pathname;
  } catch {
    return false;
  }
}

export function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

const ACTIONABLE =
  'button, a[href], [role="button"], input[type="submit"], input[type="button"], input[type="reset"], input[type="image"]';

/** The element a click was meant for: the nearest button-like ancestor, else the target. */
export function clickTarget(target: EventTarget | null): Element | null {
  let el: Element | null = null;
  if (target && (target as Node).nodeType === 1) el = target as Element;
  else if (target && (target as Node).nodeType === 3) el = (target as Node).parentElement;
  if (!el) return null;
  return el.closest(ACTIONABLE) ?? el;
}

/** Whether a click on this element is expected to DO something. */
export function isActionable(el: Element): boolean {
  if (!el.matches(ACTIONABLE)) return false;
  if (el.matches("a[href]")) {
    const href = el.getAttribute("href") ?? "";
    // A new tab, a download or a mail/phone link changes nothing in this page.
    if (el.getAttribute("target") === "_blank" || el.hasAttribute("download")) return false;
    if (/^(mailto|tel|sms):/i.test(href)) return false;
  }
  return !isDisabled(el);
}

export function isDisabled(el: Element): boolean {
  return (
    el.hasAttribute("disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    (el as HTMLButtonElement).disabled === true
  );
}

// A class that looks generated (CSS modules, styled-components) changes on
// every build, so it is useless in a selector meant to name the same element
// across sessions.
function stableClass(c: string): boolean {
  if (!/^[A-Za-z_][\w-]*$/.test(c)) return false;
  if (c.length > 40) return false;
  return !(/\d/.test(c) && c.length > 8);
}

function escapeIdent(s: string): string {
  return s.replace(/[^\w-]/g, (ch) => `\\${ch}`);
}

/**
 * A selector that names the same element across sessions: tag, #id,
 * [data-testid] and (on the element only) up to two stable classes, for the
 * element and up to 4 ancestors
 * (stopping at the first id), at most 200 characters.
 */
export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (cur.nodeType !== 1 || cur === cur.ownerDocument?.documentElement) break;
    let part = cur.tagName.toLowerCase();
    const id = cur.getAttribute("id");
    if (id && id.length <= 60) part += `#${escapeIdent(id)}`;
    // Classes only on the element itself: an ancestor's classes are often
    // state (`main.dark` / `main.light`) and would split one element in two.
    const classes = depth === 0 ? Array.from(cur.classList ?? []).filter(stableClass).slice(0, 2) : [];
    for (const c of classes) part += `.${c}`;
    const testId = cur.getAttribute("data-testid");
    if (testId) part += `[data-testid="${cap(testId, 40).replace(/"/g, "")}"]`;
    parts.unshift(part);
    if (id) break;
    cur = cur.parentElement;
  }
  return cap(parts.join(" > "), 200);
}

const SECRET_INPUT = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * What the element says to the user: its aria-label or title, else its visible
 * text, trimmed to 60 characters. Never a form field's value, and never text
 * from anything editable or anything containing a form field.
 */
export function labelFor(el: Element): string | undefined {
  const aria = el.getAttribute("aria-label") ?? el.getAttribute("title");
  if (aria && aria.trim()) return cap(aria.trim().replace(/\s+/g, " "), 60);
  if (el.matches(SECRET_INPUT) || el.querySelector(SECRET_INPUT)) return undefined;
  if ((el as HTMLElement).isContentEditable || el.closest('[contenteditable=""], [contenteditable="true"]')) {
    return undefined;
  }
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
  const text = String(raw).trim().replace(/\s+/g, " ");
  return text ? cap(text, 60) : undefined;
}

export function describeElement(el: Element): { selector: string; label?: string } {
  const label = labelFor(el);
  return label ? { selector: selectorFor(el), label } : { selector: selectorFor(el) };
}

/**
 * A form field as it may leave the page: its selector, and a label from its
 * aria-label, its <label>, its placeholder or its name attribute, in that
 * order. Never its value. Pure over the DOM.
 */
export function describeField(el: Element): { selector: string; label?: string } {
  const selector = selectorFor(el);
  let label: string | null = el.getAttribute("aria-label");
  if (!label) {
    const id = el.getAttribute("id");
    const doc = el.ownerDocument;
    const forLabel = id && doc ? doc.querySelector(`label[for="${id.replace(/["\\]/g, "")}"]`) : null;
    const wrapping = el.closest("label");
    const source = forLabel ?? wrapping;
    if (source) {
      // The label's own text, with any field inside it left out.
      const clone = source.cloneNode(true) as Element;
      for (const f of Array.from(clone.querySelectorAll(SECRET_INPUT))) f.remove();
      label = clone.textContent;
    }
  }
  if (!label) label = el.getAttribute("placeholder") ?? el.getAttribute("name");
  const t = label ? label.trim().replace(/\s+/g, " ") : "";
  return t ? { selector, label: cap(t, 60) } : { selector };
}

/** A form as it may leave the page: its selector, labelled by its submit control. */
export function describeForm(form: Element): { selector: string; label?: string } {
  const selector = selectorFor(form);
  const submit = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
  let label: string | undefined = form.getAttribute("aria-label")?.trim() || undefined;
  if (!label && submit) {
    label = submit.matches("input") ? (submit.getAttribute("value") ?? undefined) : labelFor(submit);
  }
  return label ? { selector, label: cap(label.trim().replace(/\s+/g, " "), 60) } : { selector };
}

/**
 * Whether the page now showing says it does not exist: Next.js marks a
 * not-found page with <meta name="next-error" content="not-found">; any
 * framework's default 404 has a title starting "404". Pure over the DOM.
 */
export function isNotFoundPage(doc: Document = document): boolean {
  try {
    if (doc.querySelector('meta[name="next-error"][content="not-found"]')) return true;
    return /^\s*404\b/.test(doc.title ?? "");
  } catch {
    return false;
  }
}
