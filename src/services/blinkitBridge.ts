// Mirror of swiggyBridge.ts for Blinkit: lets api.ts run same-origin,
// credentialed /v5/carts calls INSIDE a hidden blinkit.com page so the bill
// is priced under the user's real browser identity (HttpOnly cookies decide
// the fee-experiment arm — direct RN fetches land in a cheaper control arm).

export interface BlinkitBridgeResponse {
  status: number;
  text: string;
}

type Injector = (id: number, url: string, method: string, body: string, extraHeaders: string) => void;
type QueuedRequest = [id: number, url: string, method: string, body: string, extraHeaders: string];
type Pending = {
  resolve: (r: BlinkitBridgeResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

let injector: Injector | null = null;
let ready = false;
let nextId = 1;
const pending = new Map<number, Pending>();
const queue: QueuedRequest[] = [];

const REQUEST_TIMEOUT_MS = 15000;

export function registerBlinkitInjector(fn: Injector): void {
  injector = fn;
}

export function unregisterBlinkitInjector(fn: Injector): void {
  if (injector === fn) {
    injector = null;
    ready = false;
    queue.length = 0;
  }
}

export function isBlinkitBridgeReady(): boolean {
  return injector !== null && ready;
}

let pendingCookies: string | null = null;

// Reload callback registered by the bridge WebView component.
let reloadCallback: (() => void) | null = null;

export function registerBlinkitBridgeReload(fn: () => void): void {
  reloadCallback = fn;
}

export function unregisterBlinkitBridgeReload(): void {
  reloadCallback = null;
}

export function reloadBlinkitBridge(): void {
  if (reloadCallback) reloadCallback();
}

// Full values of interesting localStorage keys relayed by the page
// ('cart' holds the persistent cart object incl. its id).
const pageStorage: Record<string, string> = {};

export function handleBlinkitLocalStorage(key: string, value: string): void {
  pageStorage[key] = value;
}

export function getBlinkitPageStorage(key: string): string | null {
  return pageStorage[key] ?? null;
}

export function notifyBlinkitBridgeCookies(cookies: string): void {
  pendingCookies = cookies;
}

export function takeBlinkitBridgeCookies(): string | null {
  const c = pendingCookies;
  pendingCookies = null;
  return c;
}

function dispatch(entry: QueuedRequest): boolean {
  if (!injector || !ready) return false;
  try {
    injector(entry[0], entry[1], entry[2], entry[3], entry[4]);
    return true;
  } catch {
    return false;
  }
}

export function notifyBlinkitBridgeReady(): void {
  if (ready) return;
  ready = true;
  console.log(`[BlinkitBridge] page ready — flushing ${queue.length} queued request(s)`);
  while (queue.length > 0) {
    const entry = queue.shift()!;
    dispatch(entry);
  }
}

export function handleBlinkitBridgeMessage(payload: string): boolean {
  try {
    const data = JSON.parse(payload);
    if (data && data.type === 'BL_API_RESPONSE') {
      const entry = pending.get(Number(data.id));
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(Number(data.id));
        entry.resolve({ status: Number(data.status) || 0, text: String(data.text ?? '') });
      }
      return true;
    }
    if (data && data.type === 'BL_LOCALSTORAGE') {
      handleBlinkitLocalStorage(String(data.key || ''), String(data.value || ''));
      return true;
    }
    if (data && data.type === 'BL_BRIDGE_READY') {
      notifyBlinkitBridgeReady();
      return true;
    }
  } catch {}
  return false;
}

// Runs one request through the blinkit.com page. Resolves null when no page
// is connected or on timeout, so the caller can fall back to its own
// transport.
export async function requestViaBlinkitBridge(
  url: string,
  method: string,
  body?: string,
  extraHeaders?: Record<string, string>
): Promise<BlinkitBridgeResponse | null> {
  if (!injector) return null;
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      console.warn(`[BlinkitBridge] request timed out (${method} ${url})`);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, timer });

    const entry: QueuedRequest = [id, url, method, body ?? '', JSON.stringify(extraHeaders || {})];
    if (ready) {
      if (!dispatch(entry)) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    } else {
      console.log(`[BlinkitBridge] page not ready — queuing ${method} ${url}`);
      queue.push(entry);
    }
  });
}
