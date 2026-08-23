// Bridge that lets api.ts run same-origin fetches inside a hidden swiggy.com
// WebView. Swiggy's Instamart APIs sit behind an auth + WAF layer that rejects
// calls made outside a real page context (the desktop grocery-order-optimizer
// extension hits the same wall — its JSON fee flow "needs a page context for
// Swiggy's WAF"), so cart/checkout calls are executed by the page itself with
// credentials:'include' and relayed back here.

export interface BridgeResponse {
  status: number;
  text: string;
}

type Injector = (id: number, url: string, method: string, body: string) => void;
type QueuedRequest = [id: number, url: string, method: string, body: string];
type Pending = {
  resolve: (r: BridgeResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

let injector: Injector | null = null;
let ready = false;
let nextId = 1;
const pending = new Map<number, Pending>();
const queue: QueuedRequest[] = [];

const REQUEST_TIMEOUT_MS = 15000;

export function registerSwiggyInjector(fn: Injector): void {
  injector = fn;
}

export function unregisterSwiggyInjector(fn: Injector): void {
  if (injector === fn) {
    injector = null;
    ready = false;
    queue.length = 0;
  }
}

export function isSwiggyBridgeConnected(): boolean {
  return injector !== null;
}

export function isSwiggyBridgeReady(): boolean {
  return injector !== null && ready;
}

// Cookies captured by the visible linking browser (full document.cookie).
// The hidden bridge page lives in a separate WebView whose cookie jar does
// not reliably inherit the login, so the captured cookies are replayed into
// the bridge page (non-HttpOnly ones) before its API calls.
let pendingCookies: string | null = null;
let onCookiesSink: ((cookies: string) => void) | null = null;

export function notifySwiggyBridgeCookies(cookies: string): void {
  pendingCookies = cookies;
  try {
    onCookiesSink?.(cookies);
  } catch {}
}

export function takeSwiggyBridgeCookies(): string | null {
  const c = pendingCookies;
  pendingCookies = null;
  return c;
}

export function registerSwiggyCookieSink(fn: (cookies: string) => void): void {
  onCookiesSink = fn;
}

export function unregisterSwiggyCookieSink(fn: (cookies: string) => void): void {
  if (onCookiesSink === fn) onCookiesSink = null;
}

function dispatch(entry: QueuedRequest): boolean {
  if (!injector || !ready) return false;
  try {
    injector(entry[0], entry[1], entry[2], entry[3]);
    return true;
  } catch {
    return false;
  }
}

export function notifySwiggyBridgeReady(): void {
  if (ready) return;
  ready = true;
  console.log(`[SwiggyBridge] page ready — flushing ${queue.length} queued request(s)`);
  while (queue.length > 0) {
    const entry = queue.shift()!;
    dispatch(entry);
  }
}

export function handleSwiggyBridgeResponse(id: number, status: number, text: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve({ status, text });
}

export function handleSwiggyBridgeMessage(payload: string): boolean {
  try {
    const data = JSON.parse(payload);
    if (data && data.type === 'GO_API_RESPONSE') {
      handleSwiggyBridgeResponse(Number(data.id), Number(data.status) || 0, String(data.text ?? ''));
      return true;
    }
    if (data && data.type === 'GO_BRIDGE_READY') {
      notifySwiggyBridgeReady();
      return true;
    }
  } catch {}
  return false;
}

// Runs one request through the page. Requests fired before the page reports
// ready are queued and flushed on load instead of being dropped. Resolves
// null when no page is connected or the request times out, so the caller can
// fall back to its own transport.
export async function requestViaSwiggyBridge(
  url: string,
  method: string = 'GET',
  body?: string
): Promise<BridgeResponse | null> {
  if (!injector) return null;
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      console.warn(`[SwiggyBridge] request timed out (${method} ${url})`);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });

    const entry: QueuedRequest = [id, url, method, body ?? ''];
    if (ready) {
      if (!dispatch(entry)) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    } else {
      console.log(`[SwiggyBridge] page not ready — queuing ${method} ${url}`);
      queue.push(entry);
    }
  });
}
