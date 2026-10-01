// Dev-only Swiggy search/billing diagnostics. Filter the Metro console on "[GL:".
declare const __DEV__: boolean;

const enabled = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'test';

export type LogTag = 'swiggy-search' | 'swiggy-bill';

// Products whose raw search node is dumped (once each per session).
const WATCH = ['english oven zero maida', 'arokya full cream milk'];
const dumped = new Set<string>();

export function dlog(tag: LogTag, msg: string, data?: unknown): void {
  if (!enabled) return;
  let s = '';
  if (data !== undefined) {
    try { s = ' ' + JSON.stringify(data); } catch { s = ' ' + String(data); }
    if (s.length > 4000) s = s.slice(0, 4000) + '…(truncated)';
  }
  console.log(`[GL:${tag}] ${msg}${s}`);
}

export function dumpWatched(tag: LogTag, name: string, raw: () => unknown): void {
  if (!enabled) return;
  const key = `${tag}|${name.toLowerCase()}`;
  if (dumped.has(key) || !WATCH.some(w => name.toLowerCase().includes(w))) return;
  dumped.add(key);
  dlog(tag, `RAW NODE "${name}"`, raw());
}
