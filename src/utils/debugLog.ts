// Dev-only search diagnostics. Filter the Metro console on "[GL:".
declare const __DEV__: boolean;

const enabled = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'test';

export type LogTag = 'blinkit-search' | 'blinkit-bill';

// Products whose full raw search node is dumped (once each per session).
// Edit this list to chase a different item.
const WATCH = ['english oven zero maida'];
const dumped = new Set<string>();

export function dlog(tag: LogTag, msg: string, data?: unknown): void {
  if (!enabled) return;
  let s = '';
  if (data !== undefined) {
    try { s = ' ' + JSON.stringify(data); } catch { s = ' ' + String(data); }
    if (s.length > 8000) s = s.slice(0, 8000) + '…(truncated)';
  }
  console.log(`[GL:${tag}] ${msg}${s}`);
}

// Full raw search node for a watched product — the search response's own
// stock signals, to compare against what the bill later reports.
export function dumpWatched(tag: LogTag, name: string, raw: () => unknown): void {
  if (!enabled) return;
  const key = `${tag}|${name.toLowerCase()}`;
  if (dumped.has(key) || !WATCH.some(w => name.toLowerCase().includes(w))) return;
  dumped.add(key);
  dlog(tag, `RAW NODE "${name}"`, raw());
}
