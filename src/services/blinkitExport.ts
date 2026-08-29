// Blinkit "Export to Blinkit" flow.
//
// Mirrors the reference grocery-order-optimizer extension's Blinkit export
// / open-cart path:
//   1. Resolve every basket line to a Blinkit product_id (reusing the
//      catalog ids captured on search/auto-match; falls back to a live
//      /v1/layout/search lookup per item).
//   2. POST the full basket to /v5/carts — body
//      { items: [{ product_id, quantity }], address_id, promo_codes: [''] }.
//      There is NO separate empty-cart/delete API: the new cart replaces the
//      old one in this single call.
//   3. Return the priced cart + the localStorage['cart'] object the Blinkit
//      SPA hydrates from (items, count, total, uniqueSkuInCart — preserving
//      the existing keys not owned by us).
//
// The already-linked hidden Blinkit page (BlinkitBridgeWebView) runs the
// /v5/carts POST so it carries the user's genuine browser
// Origin/Cookie/TLS context — the gateway rejects worker-side requests
// otherwise.

import { api, parseBlinkitProducts, UnifiedProduct, resolvePlatformProduct } from './api';
import { requestViaBlinkitBridge, getBlinkitPageStorage } from './blinkitBridge';
import { storage } from './storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pickBestMatch } from '../utils/matcher';

export interface BlinkitExportItem {
  product_id: string;
  quantity: number;
  name: string;
  price: number;
  mrp: number;
  imageUrl: string;
  unit: string;
}

export interface BlinkitExportResult {
  items: BlinkitExportItem[];
  cartId: number | null;
  total: number;
  payableAmount: number | null;
  subTotal: number | null;
  deliveryFee: number | null;
  cartLocalStorage: Record<string, any>;
  missing: { name: string; quantity: string }[];
}

/**
 * Resolve a single cart line to a Blinkit product_id.
 * Prefers the catalog id already captured on the blinkit variant of the line
 * (originalId / productId from search or auto-match). When absent, runs the
 * exact search fallback chain from background.js — each endpoint tried in
 * order until one returns a usable product_id.
 */
async function resolveProductId(
  line: { product: UnifiedProduct; quantity: number },
  lat: number,
  lng: number,
  authKey: string,
  location: { latitude: number; longitude: number; address?: string } | null
): Promise<{ item: BlinkitExportItem | null; notFound: boolean }> {
  const v = resolvePlatformProduct(line, 'blinkit');
  const base = v?.product || null;
  const qty = Math.max(1, Math.round(line.quantity) || 1);

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
    };
  }

  // Fallback: live search to resolve the line.
  try {
    const found = await searchBlinkitProduct(name, unit, lat, lng, authKey, location);
    if (found) {
      return {
        item: { product_id: String(found.productId), quantity: qty, name, price, mrp, imageUrl, unit },
        notFound: false,
      };
    }
  } catch {}
  return { item: null, notFound: true };
}

async function searchBlinkitProduct(
  name: string,
  unit: string,
  lat: number,
  lng: number,
  authKey: string,
  location: { latitude: number; longitude: number; address?: string } | null
): Promise<{ productId: string } | null> {
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
  // matters for stateful /v5/carts pricing.
  try {
    const res = await api.fetchWithTimeout(baseUrl, { method: 'POST', headers, body: '{}' }, 8000);
    if (res.ok) {
      const json = await res.json();
      const parsed = parseBlinkitProducts(json);
      const best = pickBestMatch<{ name: string; unit: string; productId: string }>(
        { name, unit },
        parsed.map((p: any) => ({ name: p.name, unit: p.unit, productId: p.productId }))
      );
      if (best?.candidate?.productId) return { productId: String(best.candidate.productId) };
    }
  } catch {}
  return null;
}

/**
 * Main export entry: price the basket through /v5/carts under the user's
 * session and return everything needed to hydrate the Blinkit page.
 * Returns null if Blinkit isn't linked (no auth key).
 */
export async function exportCartToBlinkit(
  cart: { product: UnifiedProduct; quantity: number }[]
): Promise<BlinkitExportResult | null> {
  const authKey = await storage.getToken('blinkit');
  if (!authKey) return null;

  const location = await storage.getLocation();
  const lat = location?.latitude ?? 12.9716;
  const lng = location?.longitude ?? 77.5946;
  const addrRaw = await AsyncStorage.getItem('@blinkit_address_id');
  const addrNum = addrRaw ? Number(addrRaw) : NaN;

  const missing: { name: string; quantity: string }[] = [];
  const items: BlinkitExportItem[] = [];

  for (const line of cart) {
    const { item, notFound } = await resolveProductId(line, lat, lng, authKey, location || null);
    if (item) items.push(item);
    else if (notFound) missing.push({ name: line.product.title, quantity: line.product.quantity });
  }

  // Even if some lines were missing, export what resolved (mirrors the
  // extension which pushes the resolvable basket).
  const slim = items.map((i) => ({ product_id: i.product_id, quantity: i.quantity }));

  let cartId: number | null = null;
  let payableAmount: number | null = null;
  let subTotal: number | null = null;
  let deliveryFee: number | null = null;
  // Blinkit's own serialized cart from the /v5/carts response — the SPA
  // hydrates localStorage['cart'] from this exact schema, so persisting the
  // raw cart_data (its item_details + bill_details) guarantees the page
  // renders instead of crashing on an unfamiliar shape.
  let rawCartData: any = null;

  if (slim.length > 0) {
    const cartsBody = JSON.stringify({
      items: slim,
      ...(isFinite(addrNum) && addrNum ? { address_id: addrNum } : {}),
      promo_codes: [''],
    });

    const bridgeHeaders: Record<string, string> = {
      'app_client': 'consumer_web',
      'auth_key': authKey,
      'lat': String(lat),
      'lon': String(lng),
      'Content-Type': 'application/json',
    };

    let bridged = await requestViaBlinkitBridge('https://blinkit.com/v5/carts', 'POST', cartsBody, bridgeHeaders);
    if (bridged && bridged.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      bridged = await requestViaBlinkitBridge('https://blinkit.com/v5/carts', 'POST', cartsBody, bridgeHeaders);
    }
    if (bridged && bridged.status === 200) {
      try {
        const res = JSON.parse(bridged.text);
        const cd = res?.cart_data || res?.data || res;
        rawCartData = cd || null;
        cartId = Number(cd?.id ?? cd?.cart_id ?? res?.cart_id ?? null) || null;
        payableAmount = num(cd?.bill_details?.payable_amount ?? cd?.bill_details?.payableAmount);
        subTotal = num(cd?.bill_details?.total_cost ?? cd?.bill_details?.item_total ?? cd?.bill_details?.subtotal);
        deliveryFee = num(cd?.bill_details?.delivery_charge ?? cd?.bill_details?.deliveryCharge);
      } catch {}
    }
  }

  // Build the localStorage['cart'] object the Blinkit SPA hydrates from.
  // Preserve any keys already present in the hidden page's live cart that we
  // don't own (mirrors the extension's "preserving existing keys").
  let existing: any = {};
  const existingRaw = getBlinkitPageStorage('cart');
  if (existingRaw) {
    try { existing = typeof JSON.parse(existingRaw) === 'object' ? JSON.parse(existingRaw) : {}; } catch {}
  }

  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const uniqueSkuInCart = items.length;
  const quanti = items.reduce((s, i) => s + i.quantity, 0);

  // Prefer Blinkit's own serialized cart from the /v5/carts response. It is
  // the authoritative schema the SPA renders from — write its items over a
  // copy so we only touch the basket, never the shapes the app depends on.
  let cartLocalStorage: Record<string, any>;
  if (rawCartData && typeof rawCartData === 'object') {
    let base: any = { ...existing, ...rawCartData };
    // Replace the item list with the response's own item entries (keeps every
    // field Blinkit expects per item) derived from our resolved basket.
    const respItems = rawCartData.items ?? rawCartData.item_details ?? [];
    base = {
      ...base,
      items: Array.isArray(respItems) && respItems.length ? respItems : synthesizedItems(items),
      count: quanti,
      total,
      uniqueSkuInCart,
      id: cartId ?? base?.id ?? '',
    };
    cartLocalStorage = base;
  } else {
    cartLocalStorage = {
      ...existing,
      id: cartId ?? existing?.id ?? '',
      items: synthesizedItems(items),
      count: quanti,
      total,
      uniqueSkuInCart,
    };
  }

  return {
    items,
    cartId,
    total,
    payableAmount,
    subTotal,
    deliveryFee,
    cartLocalStorage,
    missing,
  };
}

// Minimal per-item cart entry used only as a fallback when the SERVER does
// not return a cart in the POST response. Keeps the fields Blinkit's drawer
// reducer reads to render a line.
function synthesizedItems(items: BlinkitExportItem[]): any[] {
  return items.map((i) => ({
    id: i.product_id,
    product_id: i.product_id,
    qty: i.quantity,
    quantity: i.quantity,
    mrp: i.mrp || i.price,
    price: i.price,
    name: i.name,
    uom: i.unit,
    image_url: i.imageUrl || '',
    imageUrl: i.imageUrl || '',
    is_available: 1,
    in_stock: 1,
    product_ids: { type_id: i.product_id, sku_id: i.product_id },
    product: {
      name: i.name,
      unit: i.unit,
      image_url: i.imageUrl || '',
      image: i.imageUrl || '',
      mrp: i.mrp || i.price,
      price: i.price,
      id: i.product_id,
      product_id: i.product_id,
    },
  }));
}

function num(v: any): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.match(/-?[\d,]+(?:\.\d+)?/);
    return m ? Number(m[0].replace(/,/g, '')) : null;
  }
  return null;
}
