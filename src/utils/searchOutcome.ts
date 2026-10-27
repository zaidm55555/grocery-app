import type { Platform } from '../services/storage';
import { PLATFORM_ORDER } from '../constants/theme';

type PlatformErrors = Partial<Record<Platform, string>>;

/** What the search screen says when a search left no cards to show. */
export type SearchOutcome =
  /** Nothing searched yet. Typed text alone doesn't count: it only searches on Search/submit. */
  | { kind: 'idle' }
  /** Every linked store in view can't deliver to this location. */
  | { kind: 'out_of_range'; platforms: Platform[] }
  /** A store in view couldn't be reached (network, Cloudflare, HTTP error): offer a retry. */
  | { kind: 'failed'; platforms: Platform[] }
  /** Every store in view answered, with nothing. */
  | { kind: 'no_results' };

/** Store errors that mean "not deliverable here", as opposed to a request that failed. */
export function isLocationSearchError(message?: string | null): boolean {
  return !!message && /_TOO_FAR|_NO_ADDRESS|_UNAVAILABLE/.test(message);
}

export function splitSearchErrors(errors: PlatformErrors): { location: PlatformErrors; failed: PlatformErrors } {
  const location: PlatformErrors = {};
  const failed: PlatformErrors = {};
  for (const p of PLATFORM_ORDER) {
    const msg = errors[p];
    if (!msg) continue;
    if (isLocationSearchError(msg)) location[p] = msg;
    else failed[p] = msg;
  }
  return { location, failed };
}

/**
 * Picks the empty state for a search that is NOT in flight and has no cards in
 * view (the caller shows its loading state while a search runs).
 */
export function emptySearchOutcome(opts: {
  /** The query of the last search started, or null when none ran (or it was cleared). */
  searchedQuery: string | null;
  /** The search as a whole threw before any store could answer. */
  searchFailed: boolean;
  platformErrors: PlatformErrors;
  linked: Record<Platform, boolean>;
  storeFilter: 'all' | Platform;
}): SearchOutcome {
  if (!opts.searchedQuery) return { kind: 'idle' };
  const inView = opts.storeFilter === 'all' ? PLATFORM_ORDER : [opts.storeFilter];
  const linkedInView = inView.filter(p => opts.linked[p]);
  const { location, failed } = splitSearchErrors(opts.platformErrors);

  const outOfRange = linkedInView.filter(p => location[p]);
  if (linkedInView.length > 0 && outOfRange.length === linkedInView.length) {
    return { kind: 'out_of_range', platforms: outOfRange };
  }
  if (opts.searchFailed) {
    return { kind: 'failed', platforms: linkedInView.length > 0 ? linkedInView : inView };
  }
  const failedInView = inView.filter(p => failed[p]);
  if (failedInView.length > 0) return { kind: 'failed', platforms: failedInView };
  return { kind: 'no_results' };
}
