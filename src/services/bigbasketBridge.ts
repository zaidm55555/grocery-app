// Bridge that lets api.ts run same-origin fetches inside a hidden bigbasket.com
// WebView. BigBasket's APIs sit behind Akamai and session cookies (_bb_mid, _bb_cid,
// _bb_aid, csrftoken, etc.). Running inside the real page context ensures valid
// session tokens and credentials.

export interface BigBasketBridgeResponse {
  status: number;
  text: string;
}

type Injector = (id: number, url: string, method: string, body: string, extraHeaders: string) => void;
type QueuedRequest = [id: number, url: string, method: string, body: string, extraHeaders: string];
type Pending = {
  resolve: (r: BigBasketBridgeResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

let injector: Injector | null = null;
let ready = false;
let nextId = 1;
const pending = new Map<number, Pending>();
const queue: QueuedRequest[] = [];

const REQUEST_TIMEOUT_MS = 15000;

let pendingCookies: string | null = null;
let reloadCallback: (() => void) | null = null;
const pageStorage: Record<string, string> = {};

export function registerBigBasketInjector(fn: Injector): void {
  injector = fn;
}

export function unregisterBigBasketInjector(fn: Injector): void {
  if (injector === fn) {
    injector = null;
    ready = false;
    queue.length = 0;
  }
}

export function registerBigBasketBridgeReload(fn: () => void): void {
  reloadCallback = fn;
}

export function unregisterBigBasketBridgeReload(): void {
  reloadCallback = null;
}

export function reloadBigBasketBridge(): void {
  if (reloadCallback) reloadCallback();
}

export function getBigBasketPageStorage(key: string): string | null {
  return pageStorage[key] ?? null;
}

export function notifyBigBasketBridgeCookies(cookies: string): void {
  pendingCookies = cookies;
}

export function takeBigBasketBridgeCookies(): string | null {
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

export function isBigBasketBridgeReady(): boolean {
  return ready;
}

function notifyBigBasketBridgeReady(): void {
  if (ready) return;
  ready = true;
  console.log(`[BigBasketBridge] page ready — flushing ${queue.length} queued request(s)`);
  while (queue.length > 0) {
    const entry = queue.shift()!;
    dispatch(entry);
  }
}

export function handleBigBasketBridgeMessage(payload: string): boolean {
  try {
    const data = JSON.parse(payload);
    if (data && (data.type === 'BB_API_RESPONSE' || data.type === 'BB_EVAL_RESPONSE')) {
      const entry = pending.get(Number(data.id));
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(Number(data.id));
        entry.resolve({ status: Number(data.status) || 0, text: String(data.text ?? '') });
      }
      return true;
    }
    if (data && data.type === 'BB_LOCALSTORAGE') {
      pageStorage[String(data.key || '')] = String(data.value || '');
      return true;
    }
    if (data && data.type === 'BB_BRIDGE_READY') {
      notifyBigBasketBridgeReady();
      return true;
    }
  } catch {}
  return false;
}

export async function requestViaBigBasketBridge(
  url: string,
  method: string = 'GET',
  body?: string,
  extraHeaders?: Record<string, string>
): Promise<BigBasketBridgeResponse | null> {
  if (!injector) return null;
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
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
      queue.push(entry);
    }
  });
}

export async function requestEvalViaBigBasketBridge(
  code: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<BigBasketBridgeResponse | null> {
  return requestViaBigBasketBridge(code, '__EVAL__', code);
}
