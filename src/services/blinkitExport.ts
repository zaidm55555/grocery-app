// Blinkit "Export to Blinkit" flow.
//
// Mirrors the reference grocery-order-optimizer extension's Blinkit export
// / open-cart path:
//   1. Resolve every basket line to a Blinkit product_id (reusing the
//      catalog ids captured on search/auto-match; falls back to a live
//      /v1/layout/search lookup per item).
//   2. POST the full basket to /v5/carts — body
//      { items: [{ product_id, quantity }], address_id, promo_codes: [''] }.
//      A fresh-cart POST does NOT replace what the user's session already has:
//      the site commits + prices its PERSISTENT cart via PUT /v5/carts/{id}
//      (and that persistent cart is what checkout actually reads). So after
//      the POST we resolve the persistent cart id and PUT the exact basket —
//      same session/header treatment api.ts uses to price live bills. This
//      keeps the server cart identical to the basket we render, so Blinkit
//      does not reconcile a "prices have changed" modal (or double quantities
//      already present in the old cart) at "Proceed to pay".
//   3. Return the priced cart + the localStorage['cart'] object the Blinkit
//      SPA hydrates from (items, count, total, uniqueSkuInCart — preserving
//      the existing keys not owned by us).
//
// The already-linked hidden Blinkit page (BlinkitBridgeWebView) runs the
// /v5/carts POST/PUT so it carries the user's genuine browser
// Origin/Cookie/TLS context — the gateway rejects worker-side requests
// otherwise.

import { api, parseBlinkitProducts, UnifiedProduct, resolvePlatformProduct } from './api';
import { requestViaBlinkitBridge, getBlinkitPageStorage } from './blinkitBridge';
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
  let addrNum = NaN;
  try {
    const closestAddr = await api.getClosestBlinkitAddress(lat, lng);
    if (closestAddr && closestAddr.id) {
      addrNum = Number(closestAddr.id);
      await AsyncStorage.setItem('@blinkit_address_id', String(closestAddr.id));
      await AsyncStorage.setItem('@blinkit_address_name', closestAddr.address || closestAddr.text || '');
      const aLat = closestAddr.latitude || closestAddr.lat;
      const aLng = closestAddr.longitude || closestAddr.lon || closestAddr.lng;
      if (aLat && aLng) {
        await AsyncStorage.setItem('@blinkit_lat', String(aLat));
        await AsyncStorage.setItem('@blinkit_lng', String(aLng));
      }
    }
  } catch {}
  if (isNaN(addrNum)) {
    const addrRaw = await AsyncStorage.getItem('@blinkit_address_id');
    addrNum = addrRaw ? Number(addrRaw) : NaN;
  }

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

    // NOTE: Blinkit "fresh cart" POSTs are ADDITIVE — they stack the
    // requested quantities on top of whatever the session cart already holds,
    // and both the app's pricing flow and past exports have been stacking
    // items onto it across runs (observed 1 → 2 → 3 at "Proceed to pay").
    // The PUT-onto-a-cached/synced-id approach didn't reach the cart checkout
    // actually prices. So now: EMPTY the session cart (DELETE the resolved
    // active cart id, read-only GET is the primary source) and only then
    // re-create the basket with a single POST — additive-onto-empty == exactly
    // our basket, with a cart id that matches the localStorage we render.

    // 1) Session headers are shared by every /v5/carts call (access_token is the
    //    URL-decoded gr_1_accessToken cookie, session_uuid stable per install).
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
    const sessionHeaders: Record<string, string> = {
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
    };

    // 2) The web gateway serves /v5/carts ONLY on POST (GET/DELETE prove 405).
    //    One POST of the basket returns the full cart-page config Blinkit's
    //    SPA renders — fresh cart id + line items + bill. There is no public
    //    "clear cart" verb here; the SPA's real clear/proceed mutations are
    //    captured separately (BLINKIT_NETLOG) so we can mirror them later.
    let cartIdNum: number = NaN;
    const postRes = await requestViaBlinkitBridge('https://blinkit.com/v5/carts', 'POST', cartsBody, sessionHeaders);
    if (postRes) {
      console.warn('[BlinkitExport] POST /v5/carts', {
        status: postRes.status,
        body: String(postRes.text).slice(0, 600),
      });
      if (postRes.status === 200) {
        try {
          const info = parseBlinkitCartInfo(JSON.parse(postRes.text || '{}'));
          if (info.id) {
            cartIdNum = info.id;
          }
          if (info.cartData) rawCartData = info.cartData;
        } catch {}
        if (isNaN(cartIdNum) || !cartIdNum) {
          try {
            const pj = JSON.parse(postRes.text || '{}');
            cartIdNum = Number(pj?.cart_id ?? pj?.data?.cart_id ?? NaN) || NaN;
          } catch {}
        }
      }
    }
    if (isFinite(cartIdNum) && cartIdNum) {
      await AsyncStorage.setItem('@blinkit_cart_id', String(cartIdNum));
      // The cart the SPA should render + the one checkout prices are the same.
      cartId = cartIdNum;
    }

    // Bill numbers come from the priced cart response when available.
    if (rawCartData) {
      const cd = rawCartData;
      if (payableAmount === null) payableAmount = num(cd?.bill_details?.payable_amount ?? cd?.bill_details?.payableAmount);
      if (subTotal === null) subTotal = num(cd?.bill_details?.total_cost ?? cd?.bill_details?.item_total ?? cd?.bill_details?.subtotal);
      if (deliveryFee === null) deliveryFee = num(cd?.bill_details?.delivery_charge ?? cd?.bill_details?.deliveryCharge);
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

  // Prefer the authoritative item subtotal from the priced bill when the
  // server returned one — search prices can drift a few rupees and showing a
  // total that differs from the bill invites Blinkit's price-reconciliation.
  const pricesTotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const total = subTotal !== null ? subTotal : pricesTotal;
  const uniqueSkuInCart = items.length;
  const quanti = items.reduce((s, i) => s + i.quantity, 0);

  // Strip the cart-shape keys from any stale state (the hidden page shares
  // this localStorage origin, and pricing configs + prior exports can leave
  // a SECOND item list keyed as item_details / old items). The SPA reads the
  // cart from localStorage['cart'] and, if the same product is present under
  // both 'items' AND 'item_details' (or twice overall), it ALWAYS sends TWO
  // lines in its /validate and PUT at checkout — which the server SUMS into
  // the observed +N inflation (recorded: validate [qty1, qty2] → total 3).
  // So we rebuild a clean copy: one single list under every key the reducer
  // reads, no stale duplicates.
  const CARTSHAPE = new Set(['items', 'item_details', 'count', 'quantity', 'total', 'uniqueSkuInCart', 'id', 'cart_id', 'cartId']);
  const cleanBase: Record<string, any> = {};
  const baseKeys = [...new Set([...Object.keys(existing || {}), ...Object.keys(rawCartData || {})])];
  for (const k of baseKeys) {
    if (CARTSHAPE.has(k)) continue;
    let v = (existing && k in existing) ? (existing as any)[k] : (rawCartData as any)?.[k];
    // Never carry over embedded line-item graphs.
    if (v && typeof v === 'object' && Array.isArray(v)) continue;
    if (v !== undefined) cleanBase[k] = v;
  }

  let cartLocalStorage: Record<string, any> = { ...cleanBase };
  if (rawCartData && typeof rawCartData === 'object') {
    const respItems = rawCartData.items ?? rawCartData.item_details ?? [];
    const sourceItems = Array.isArray(respItems) && respItems.length ? respItems : synthesizedItems(items);
    // Merge the server's item entries over a synthesized baseline so every
    // line the drawer reducer hydrates is complete (name / price / image /
    // qty / product). A sparse server entry must never take the cart page
    // blank.
    const persistedItems = normalizeCartItems(sourceItems, items);
    // Blinkit's reducer demands items, count and per-line qty agree — tally
    // count from what we actually persist, never from a separately-derived
    // number, or hydration throws and the page renders blank/unresponsive.
    const persistedCount = persistedItems.reduce(
      (s, x) => s + Math.max(0, Number(x?.qty ?? x?.quantity) || 0), 0
    );
    // One list, under every key the SPA might read. Same object identity so
    // the page can never see two different quantities for the same product.
    cartLocalStorage = {
      ...cartLocalStorage,
      items: persistedItems,
      item_details: persistedItems,
      count: persistedCount > 0 ? persistedCount : quanti,
      total,
      uniqueSkuInCart: persistedItems.length > 0 ? persistedItems.length : uniqueSkuInCart,
      id: cartId ?? cartLocalStorage.id ?? '',
    };
    console.warn('[BlinkitExport] hydrate', {
      respItems: respItems.length,
      persisted: persistedItems.length,
      count: cartLocalStorage.count,
      uniqueSkuInCart: cartLocalStorage.uniqueSkuInCart,
      id: cartLocalStorage.id,
      total: cartLocalStorage.total,
    });
  } else {
    const synthItems = synthesizedItems(items);
    cartLocalStorage = {
      ...cartLocalStorage,
      id: cartId ?? cartLocalStorage.id ?? '',
      items: synthItems,
      item_details: synthItems,
      count: quanti,
      total,
      uniqueSkuInCart,
    };
    console.warn('[BlinkitExport] hydrate synthetic fallback', {
      count: quanti,
      uniqueSkuInCart,
      id: cartLocalStorage.id,
      total,
    });
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

// Merge the server's per-item entries over a synthesized baseline so every
// field the drawer/cart reducer reads (id, qty, price, name, image, product,
// product_ids, availability) is always present. Missing pieces fall back to
// the app's resolved item; a blank field can leave the page blank/errored.
function normalizeCartItems(respItems: any[], items: BlinkitExportItem[]): any[] {
  const byId = new Map(items.map((i) => [String(i.product_id), i]));
  return (Array.isArray(respItems) ? respItems : []).map((raw) => {
    const pid = String(
      raw?.product_id ?? raw?.id ?? raw?.product_ids?.type_id ??
      raw?.product?.product_id ?? raw?.product?.id ?? ''
    );
    const mine = byId.get(pid);
    const qty = Math.max(0, Number(raw?.qty ?? raw?.quantity ?? raw?.count ?? mine?.quantity) || 0);
    const name = raw?.name ?? raw?.product?.name ?? mine?.name ?? '';
    const unit = raw?.uom ?? raw?.product?.unit ?? mine?.unit ?? '';
    const img = raw?.image_url ?? raw?.imageUrl ?? raw?.product?.image_url ?? raw?.product?.image ?? mine?.imageUrl ?? '';
    const price = Number(raw?.price ?? mine?.price) || 0;
    const mrp = Number(raw?.mrp ?? raw?.price ?? mine?.mrp) || price;
    return {
      id: pid,
      product_id: pid,
      qty,
      quantity: qty,
      mrp,
      price,
      name,
      uom: unit,
      image_url: img,
      imageUrl: img,
      is_available: raw?.is_available ?? 1,
      in_stock: raw?.in_stock ?? 1,
      product_ids: raw?.product_ids ?? { type_id: pid, sku_id: pid },
      product: raw?.product ?? {
        name,
        unit,
        image_url: img,
        image: img,
        mrp,
        price,
        id: pid,
        product_id: pid,
      },
    };
  });
}

function num(v: any): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.match(/-?[\d,]+(?:\.\d+)?/);
    return m ? Number(m[0].replace(/,/g, '')) : null;
  }
  return null;
}

// Extracts the active cart id + a hydratable cart object from ANY Blinkit
// /v5/carts response shape — the payloads nest cart data differently between
// the quote endpoints and the session cart (e.g. items under
// shipments[].item_details, ids under data.data.cart_data.id, or a mobile
// { cart: {...} } wrapper). Only items lists are real; everything else we
// might guess wrong about the layout is left untouched for the SPA to own.
function parseBlinkitCartInfo(json: any): { id: number | null; cartData: any } {
  if (!json || typeof json !== 'object') return { id: null, cartData: null };

  let cd: any = json;
  // Unwrap { data: ... } / { cart_data: ... } chains (bounded).
  for (let i = 0; i < 6; i++) {
    if (!cd || typeof cd !== 'object') break;
    const nxt = cd.cart_data ?? (cd.data && typeof cd.data === 'object' ? cd.data : null);
    if (!nxt || nxt === cd) break;
    cd = nxt;
  }
  // Unwrap a mobile-style { cart: {...} } wrapper, keeping any bill on the
  // outer object.
  if (cd && typeof cd === 'object' && cd.cart && typeof cd.cart === 'object') {
    const inner = cd.cart;
    if (inner.item_details || inner.items || inner.bill_details || inner.bill || inner.id) {
      cd = { ...inner, ...(cd.bill_details ? { bill_details: cd.bill_details } : {}) };
    }
  }

  // Candidate roots for the item list: the cart object itself and each
  // shipment entry.
  const candidates: any[] = [cd];
  if (cd && typeof cd === 'object' && Array.isArray(cd.shipments)) {
    candidates.push(...cd.shipments);
  }

  const toNum = (v: any): number | null => {
    const n = Number(v);
    return isFinite(n) && n ? n : null;
  };

  const id =
    toNum(cd?.id) ??
    toNum(cd?.cart_id) ??
    toNum(cd?.cart?.id) ??
    toNum(json?.cart_id) ??
    toNum(json?.data?.cart_id) ??
    toNum(json?.data?.data?.cart_id) ??
    toNum(json?.cart_data?.id);

  let items: any[] | null = null;
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const found = c.item_details ?? c.items ?? c.cart?.item_details ?? c.cart?.items;
    if (Array.isArray(found) && found.length) {
      items = found;
      break;
    }
  }
  if (items) {
    // Present the list where the SPA hydration code looks for it.
    cd = { ...(cd || {}), item_details: items };
  }
  return { id, cartData: cd || null };
}
