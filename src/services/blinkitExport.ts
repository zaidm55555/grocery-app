// Blinkit "share basket" flow.
//
// Mirrors the reference grocery-order-optimizer extension's Blinkit export /
// share-cart path:
//   1. Resolve every basket line to a Blinkit product_id (reusing the
//      catalog ids captured on search/auto-match; falls back to a live
//      /v1/layout/search lookup per item).
//   2. POST the basket to the same share-cart endpoint Blinkit's own "share
//      cart" button uses (v1/assist/cart/share, body = the SPA's
//      extra_params: total_items / items / show_share_cart_preview /
//      cart_value). The response carries a shareable link the user can open
//      in the Blinkit app or pass to anyone; no cart is imported into the
//      user's session, so there is no "prices have changed" reconcile and no
//      server-side quantity summing to worry about.
//   3. Return the share URL + the resolved items for display.
//
// The already-linked hidden Blinkit page (BlinkitBridgeWebView) runs the
// share POST so it carries the user's genuine browser
// Origin/Cookie/TLS context (HttpOnly cookies decide the session; the gateway
// rejects worker-side requests otherwise).

import { api, parseBlinkitProducts, UnifiedProduct, resolvePlatformProduct, CartCalculation, getProductPlatformLimit } from './api';
import { requestViaBlinkitBridge } from './blinkitBridge';
import { storage } from './storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pickBestMatch } from '../utils/matcher';

const BLINKIT_APP_VERSION = '52434333';

export interface BlinkitExportItem {
  product_id: string;
  quantity: number;
  name: string;
  price: number;
  mrp: number;
  imageUrl: string;
  unit: string;
}

export interface BlinkitShareResult {
  url: string;
  items: BlinkitExportItem[];
  total: number;
  missing: { name: string; quantity: string }[];
  outOfStock: { name: string; quantity: string }[];
  clamped: { name: string; requestedQty: number; exportedQty: number }[];
}

/**
 * Resolve a single cart line to a Blinkit product_id.
 * Prefers the catalog id already captured on the blinkit variant of the line
 * (originalId / productId from search or auto-match). When absent, runs the
 * exact search fallback chain from background.js — each endpoint tried in
 * order until one returns a usable product_id.
 *
 * Excludes out-of-stock items and clamps export quantity to available stock.
 */
async function resolveProductId(
  line: { product: UnifiedProduct; quantity: number },
  lat: number,
  lng: number,
  authKey: string,
  calculations?: CartCalculation[]
): Promise<{ item: BlinkitExportItem | null; notFound: boolean; outOfStock: boolean; clampedFrom?: number }> {
  const v = resolvePlatformProduct(line, 'blinkit');
  const base = v?.product || null;

  // 1. Live calculation check: did Blinkit return this line as out of stock?
  const calc = calculations?.find((c) => c.platform === 'blinkit');
  const isCalcOos = calc?.outOfStockProductIds?.includes(line.product.id) ?? false;
  const isBaseOos = base?.inStock === false;

  // 2. Stock limit: check live checkout limits / inventory limits
  const limit = getProductPlatformLimit(line.product, 'blinkit', calculations);

  if (isCalcOos || isBaseOos || (limit !== undefined && limit <= 0)) {
    return { item: null, notFound: false, outOfStock: true };
  }

  const requestedQty = Math.max(1, Math.round(line.quantity) || 1);
  const qty = (typeof limit === 'number' && limit > 0) ? Math.min(requestedQty, limit) : requestedQty;
  const clampedFrom = qty < requestedQty ? requestedQty : undefined;

  const name = base?.title || line.product.title;
  const unit = base?.quantity || line.product.quantity;
  const price = base?.price || line.product.price || 0;
  const mrp = base?.originalPrice || price;
  const imageUrl = base?.imageUrl || line.product.imageUrl;
  const productId = base?.originalId || base?.productId;

  if (productId) {
    return {
      item: { product_id: String(productId), quantity: qty, name, price, mrp, imageUrl, unit },
      notFound: false,
      outOfStock: false,
      clampedFrom,
    };
  }

  // Fallback: live search to resolve the line.
  try {
    const found = await searchBlinkitProduct(name, unit, lat, lng, authKey);
    if (found) {
      let effectiveLimit = limit;
      if (effectiveLimit === undefined) {
        if (typeof found.availableStock === 'number' && found.availableStock >= 0 && typeof found.maxQuantity === 'number' && found.maxQuantity > 0) {
          effectiveLimit = Math.min(found.availableStock, found.maxQuantity);
        } else if (typeof found.availableStock === 'number' && found.availableStock >= 0) {
          effectiveLimit = found.availableStock;
        } else if (typeof found.maxQuantity === 'number' && found.maxQuantity > 0) {
          effectiveLimit = found.maxQuantity;
        }
      }

      if (effectiveLimit !== undefined && effectiveLimit <= 0) {
        return { item: null, notFound: false, outOfStock: true };
      }

      const finalQty = (typeof effectiveLimit === 'number' && effectiveLimit > 0) ? Math.min(requestedQty, effectiveLimit) : requestedQty;
      const finalClamped = finalQty < requestedQty ? requestedQty : undefined;

      return {
        item: { product_id: String(found.productId), quantity: finalQty, name, price, mrp, imageUrl, unit },
        notFound: false,
        outOfStock: false,
        clampedFrom: finalClamped,
      };
    }
  } catch {}
  return { item: null, notFound: true, outOfStock: false };
}

async function searchBlinkitProduct(
  name: string,
  unit: string,
  lat: number,
  lng: number,
  authKey: string
): Promise<{ productId: string; availableStock?: number; maxQuantity?: number } | null> {
  const q = encodeURIComponent(name);
  const baseUrl = `https://blinkit.com/v1/layout/search?q=${q}&search_type=type_to_search&merchant_id=&offset=0&limit=60&actual_query=${q}`;
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'app_client': 'consumer_web',
    'auth_key': authKey,
    'lat': String(lat),
    'lon': String(lng),
    'Content-Type': 'application/json',
  };

  // Search is a pure read — direct fetch is safe and fast; the bridge only
  // matters for stateful /v5/carts + share-cart pricing.
  try {
    const res = await api.fetchWithTimeout(baseUrl, { method: 'POST', headers, body: '{}' }, 8000);
    if (res.ok) {
      const json = await res.json();
      const parsed = parseBlinkitProducts(json);
      const best = pickBestMatch<{ name: string; unit: string; productId: string; availableStock?: number; maxQuantity?: number }>(
        { name, unit },
        parsed.map((p: any) => ({ name: p.name, unit: p.unit, productId: p.productId, availableStock: p.availableStock, maxQuantity: p.maxQuantity }))
      );
      if (best?.candidate?.productId) {
        return {
          productId: String(best.candidate.productId),
          availableStock: best.candidate.availableStock,
          maxQuantity: best.candidate.maxQuantity,
        };
      }
    }
  } catch {}
  return null;
}

// Session headers shared by every authenticated /v5/carts + share call.
// access_token is the URL-decoded gr_1_accessToken cookie (the site sends it
// decoded); session_uuid stays stable per install.
async function buildBlinkitSessionHeaders(
  authKey: string,
  lat: number,
  lng: number
): Promise<Record<string, string>> {
  const siteCookies = (await AsyncStorage.getItem('@blinkit_cookies')) || '';
  const atM = siteCookies.match(/(?:^|;\s*)gr_1_accessToken=([^;]+)/);
  const accessToken = atM ? decodeURIComponent(atM[1]) : '';
  let sessionUuid = await AsyncStorage.getItem('@blinkit_session_uuid');
  if (!sessionUuid) {
    sessionUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
    await AsyncStorage.setItem('@blinkit_session_uuid', sessionUuid);
  }
  return {
    'app_client': 'consumer_web',
    'auth_key': authKey,
    'lat': String(lat),
    'lon': String(lng),
    'AppVersion': BLINKIT_APP_VERSION,
    'appversion': BLINKIT_APP_VERSION,
    'app_version': BLINKIT_APP_VERSION,
    'x-app-version': BLINKIT_APP_VERSION,
    ...(accessToken ? { 'access_token': accessToken } : {}),
    'session_uuid': sessionUuid,
    'platform': 'mobile_web',
    'qd_sdk_request': 'true',
    'web_app_version': '1008010016',
    'x-age-consent-granted': 'false',
    'Content-Type': 'application/json',
  };
}

/**
 * Build a shareable Blinkit cart link for the basket.
 * Returns null if Blinkit isn't linked (no auth key) or nothing resolved.
 */
export async function createBlinkitShareLink(
  cart: { product: UnifiedProduct; quantity: number }[],
  calculations?: CartCalculation[]
): Promise<BlinkitShareResult | null> {
  const authKey = await storage.getToken('blinkit');
  if (!authKey) return null;

  const location = await storage.getLocation();
  if (!location) return null;
  const lat = location.latitude;
  const lng = location.longitude;

  const missing: { name: string; quantity: string }[] = [];
  const outOfStock: { name: string; quantity: string }[] = [];
  const clamped: { name: string; requestedQty: number; exportedQty: number }[] = [];
  const items: BlinkitExportItem[] = [];

  for (const line of cart) {
    const { item, notFound, outOfStock: isOos, clampedFrom } = await resolveProductId(line, lat, lng, authKey, calculations);
    if (item) {
      items.push(item);
      if (clampedFrom && clampedFrom > item.quantity) {
        clamped.push({ name: item.name, requestedQty: clampedFrom, exportedQty: item.quantity });
      }
    } else if (isOos) {
      outOfStock.push({ name: line.product.title, quantity: line.product.quantity });
    } else if (notFound) {
      missing.push({ name: line.product.title, quantity: line.product.quantity });
    }
  }

  if (items.length === 0) {
    return { url: '', items: [], total: 0, missing, outOfStock, clamped };
  }

  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const totalItems = items.reduce((s, i) => s + i.quantity, 0);

  // Same body the SPA's "share cart" toolbar action sends (captured via the
  // site's own CART_SHARE fetch_api extra_params).
  const shareBody = JSON.stringify({
    total_items: totalItems,
    items: items.map((i) => ({
      image_url: i.imageUrl || '',
      quantity: i.quantity,
      mrp: i.mrp || i.price,
      product_id: i.product_id,
      name: i.name,
    })),
    show_share_cart_preview: false,
    cart_value: total,
  });

  const headers = await buildBlinkitSessionHeaders(authKey, lat, lng);
  let res = await requestViaBlinkitBridge(
    'https://blinkit.com/v1/assist/cart/share',
    'POST',
    shareBody,
    headers
  );
  if (!res || res.status < 200 || res.status >= 300) {
    try {
      const directRes = await api.fetchWithTimeout(
        'https://blinkit.com/v1/assist/cart/share',
        { method: 'POST', headers, body: shareBody },
        8000
      );
      if (directRes.ok) {
        const text = await directRes.text();
        res = { status: directRes.status, text };
      }
    } catch {}
  }

  let url = '';
  if (res && (res.status === 200 || res.status === 201) && res.text) {
    url = extractShareUrl(res.text);
  }

  return { url, items, total, missing, outOfStock, clamped };
}

// The share-cart response nests the link differently across the web/app
// endpoints. Deep-scan for any url-shaped string, scoring the classic key
// spellings and blinkit/share mentions; falls back to the first blinkit URL.
function extractShareUrl(text: string): string {
  const best: { score: number; value: string } = { score: -1, value: '' };

  const consider = (v: unknown, key?: string) => {
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return;
    let score = 0;
    if (key) {
      const k = key.toLowerCase();
      if (/^(url|link|share_url|cart_url|short_url|cart_link|share_link|deep_link|app_link|web_url|redirect_url)$/.test(k)) score += 10;
      if (k.includes('share') || k.includes('cart')) score += 3;
    }
    if (/blinkit\.com/i.test(v)) score += 5;
    if (/share|cart/i.test(v)) score += 2;
    if (score > best.score) {
      best.score = score;
      best.value = v;
    }
  };

  const walk = (o: unknown): void => {
    if (o == null) return;
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (typeof o === 'object') {
      for (const k of Object.keys(o as object)) {
        consider((o as any)[k], k);
        walk((o as any)[k]);
      }
      return;
    }
    consider(o);
  };

  try {
    walk(JSON.parse(text));
  } catch {}

  if (best.value) return best.value;

  const m = text.match(/https?:\/\/[^\s"'\\]+/g);
  if (m) {
    const hit =
      m.find((u) => /blinkit\.com/i.test(u) && /share|cart/i.test(u)) ||
      m.find((u) => /blinkit\.com/i.test(u));
    if (hit) return hit;
  }
  return '';
}