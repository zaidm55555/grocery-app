// Controls whether the single persistent Swiggy WebView renders off-screen
// (normal operation) or fullscreen. 'login' auto-closes when a fresh login
// transition happens; 'address' stays open until the user closes it. One
// instance guarantees the API calls run in exactly the session the user
// logged in / added their address in — separate WebViews do not share
// HttpOnly cookies.

export type SwiggySetupMode = 'hidden' | 'login' | 'address';

let mode: SwiggySetupMode = 'hidden';
const listeners = new Set<() => void>();

export function setSwiggySetupMode(next: SwiggySetupMode): void {
  if (mode === next) return;
  mode = next;
  listeners.forEach((l) => l());
}

export function getSwiggySetupMode(): SwiggySetupMode {
  return mode;
}

export function subscribeSwiggySetupMode(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
