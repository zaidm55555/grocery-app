// Blinkit live-bill pricing, split out of ApiService.calculateCart.
//
// Flow: PUT the user's persistent cart first (that is the cart the site itself
// prices, and it lands in the right fee cohort); only when no cart id is known
// or the PUT fails do we fall back to a fresh POST /v5/carts quote, then to a
// direct (non-bridge) POST. Dependencies are injected to avoid a runtime import
// cycle with api.ts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestViaBlinkitBridge, getBlinkitPageStorage } from './blinkitBridge';
import type { UnifiedProduct } from './api';

type CartLine = { product: UnifiedProduct; quantity: number };

export interface BlinkitBillFees {
  subtotal: number | null;
  deliveryFee: number | null;
  handlingFee: number | null;
  smallCartFee: number | null;
  surgeFee: number | null;
  surgeLabel?: string | null;
  tax: number | null;
  total: number | null;
  freeDeliveryGap?: number | null;
}

export interface BlinkitPricingDeps {
  getClosestBlinkitAddress(lat: number, lng: number): Promise<any | null>;
  fetchWithTimeout(url: string, options: RequestInit, timeout?: number): Promise<Response>;
  parseBlinkitBill(json: any): BlinkitBillFees;
  getItemPlatformLimit(product: UnifiedProduct | null | undefined): number | undefined;
  resolvePlatformProduct(item: CartLine, platform: 'blinkit'): CartLine | null;
}

export interface BlinkitPricingInput {
  items: CartLine[];
  platformItems: CartLine[];
  subtotal: number;
  token: string;
  gpsLat: number;
  gpsLng: number;
  simulateNoAddress: boolean;
  // Filled in-place with per-product stock limits / billed quantities.
  platformItemLimits: Record<string, number>;
  platformItemQuantities: Record<string, number>;
}

export interface BlinkitPricingResult {
  subtotal: number;
  deliveryFee: number;
  handlingFee: number;
  smallCartFee: number;
  surgeFee: number;
  surgeLabel?: string;
  freeDeliveryGap?: number;
  tax: number;
  total: number;
  liveBill: boolean;
  outOfStockProductIds: string[];
  inStockProductIds: string[];
}

const BLINKIT_APP_VERSION = '52434333';

// The gateway validates AppVersion as a case-sensitive whitelist, so every
// plausible header-name variant is emitted.
const APP_VERSION_HEADERS = {
  'AppVersion': BLINKIT_APP_VERSION,
  'appversion': BLINKIT_APP_VERSION,
  'app_version': BLINKIT_APP_VERSION,
  'x-app-version': BLINKIT_APP_VERSION,
};

const CARTS_URL = 'https://blinkit.com/v5/carts';

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function cartIdFrom(json: any): number {
  const n = Number(
    json?.cart_id ?? json?.data?.cart_id ??
    json?.cart_data?.id ?? json?.data?.cart_data?.id ?? NaN
  );
  return isFinite(n) && n ? n : NaN;
}

// Cheap, local lookup of the user's persistent cart id: the hidden page's own
// localStorage first, then what we stored on a previous run.
async function cachedCartId(): Promise<number> {
  const pageCartRaw = getBlinkitPageStorage('cart');
  if (pageCartRaw) {
    const pc = parseJson(pageCartRaw);
    const n = Number(pc?.id ?? pc?.cart_id ?? pc?.cl_id ?? pc?.cartId ?? NaN);
    if (isFinite(n) && n) return n;
  }
  const stored = await AsyncStorage.getItem('@blinkit_cart_id');
  const n = stored ? Number(stored) : NaN;
  return isFinite(n) && n ? n : NaN;
}

async function getOrCreate(key: string, make: () => string): Promise<string> {
  let v = await AsyncStorage.getItem(key);
  if (!v) {
    v = make();
    await AsyncStorage.setItem(key, v);
  }
  return v;
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

async function resolveAddress(
  deps: BlinkitPricingDeps, gpsLat: number, gpsLng: number
): Promise<{ addrNum: number; lat: number; lng: number }> {
  let addrNum = NaN;
  let lat = gpsLat;
  let lng = gpsLng;
  try {
    const closest = await deps.getClosestBlinkitAddress(gpsLat, gpsLng);
    if (closest && closest.id) {
      addrNum = Number(closest.id);
      const aLat = closest.latitude || closest.lat;
      const aLng = closest.longitude || closest.lon || closest.lng;
      if (aLat && aLng) {
        lat = Number(aLat);
        lng = Number(aLng);
      }
      await Promise.all([
        AsyncStorage.setItem('@blinkit_address_id', String(closest.id)),
        AsyncStorage.setItem('@blinkit_address_name', closest.address || closest.text || ''),
        ...(aLat && aLng ? [
          AsyncStorage.setItem('@blinkit_lat', String(aLat)),
          AsyncStorage.setItem('@blinkit_lng', String(aLng)),
        ] : []),
      ]);
    } else {
      await Promise.all(['@blinkit_address_id', '@blinkit_address_name', '@blinkit_lat', '@blinkit_lng']
        .map(k => AsyncStorage.removeItem(k)));
    }
  } catch {
    const addrRaw = await AsyncStorage.getItem('@blinkit_address_id');
    if (addrRaw) addrNum = Number(addrRaw);
  }
  return { addrNum, lat, lng };
}

export async function priceBlinkitCart(
  input: BlinkitPricingInput,
  deps: BlinkitPricingDeps
): Promise<BlinkitPricingResult> {
  const { items, platformItems, token, gpsLat, gpsLng, simulateNoAddress, platformItemLimits, platformItemQuantities } = input;
  const { resolvePlatformProduct, getItemPlatformLimit } = deps;

  let subtotal = input.subtotal;
  let deliveryFee = 0;
  let handlingFee = 0;
  let smallCartFee = 0;
  let surgeFee = 0;
  let freeDeliveryGap: number | undefined;
  let surgeLabel: string | undefined;
  let tax = 0;
  let total = subtotal;
  let liveBill = false;
  const outOfStockProductIds: string[] = [];
  const inStockProductIds: string[] = [];

  const slimItems = platformItems.map((ci) => {
    const lim = getItemPlatformLimit(ci.product);
    const q = (typeof lim === 'number' && lim > 0) ? Math.min(ci.quantity, lim) : ci.quantity;
    return {
      product_id: String(ci.product.originalId || ci.product.id.replace('blinkit-', '')),
      quantity: q
    };
  });

  let deviceId = await getOrCreate('@blinkit_device_id', () => 'web-' + randomId());
  if (simulateNoAddress) deviceId = 'sim-' + randomId();
  // The site's own cookie jar decides its fee arm — prefer the device id
  // embedded in those cookies over ours.
  const siteCookies = simulateNoAddress ? '' : ((await AsyncStorage.getItem('@blinkit_cookies')) || '');
  const devCookieM = siteCookies.match(/(?:^|;\s*)(?:device_id|deviceId)=([^;]+)/);
  if (devCookieM) deviceId = decodeURIComponent(devCookieM[1]);
  const atCookieM = siteCookies.match(/(?:^|;\s*)gr_1_accessToken=([^;]+)/);
  const siteAccessToken = atCookieM ? decodeURIComponent(atCookieM[1]) : '';

  // Address lookup (cached after the first call) and the persistent cart id
  // are independent, so resolve them together.
  const [addr, knownCartId] = await Promise.all([
    simulateNoAddress ? Promise.resolve({ addrNum: NaN, lat: gpsLat, lng: gpsLng }) : resolveAddress(deps, gpsLat, gpsLng),
    cachedCartId(),
  ]);
  const { addrNum, lat: blLat, lng: blLng } = addr;

  const cartsBody = JSON.stringify({
    items: slimItems,
    ...(isFinite(addrNum) && addrNum && !simulateNoAddress ? { address_id: addrNum } : {}),
    promo_codes: ['']
  });

  const geo = { 'lat': String(blLat), 'lon': String(blLng) };

  // PUT /v5/carts/{id}: prices the user's persistent cart. Mirrors the site's
  // own PUT headers: access_token is the URL-decoded gr_1_accessToken cookie,
  // session_uuid is stable per install, platform is mobile_web.
  const putCart = async (cartId: number): Promise<any | null> => {
    await AsyncStorage.setItem('@blinkit_cart_id', String(cartId));
    const sessionUuid = await getOrCreate('@blinkit_session_uuid', () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }));
    const putRes = await requestViaBlinkitBridge(`${CARTS_URL}/${cartId}`, 'PUT', cartsBody, {
      'app_client': 'consumer_web',
      'auth_key': token,
      ...(siteAccessToken ? { 'access_token': siteAccessToken } : {}),
      'session_uuid': sessionUuid,
      'platform': 'mobile_web',
      'qd_sdk_request': 'true',
      'web_app_version': '1008010016',
      'x-age-consent-granted': 'false',
      ...geo,
      ...APP_VERSION_HEADERS,
    });
    if (putRes && putRes.status === 200) return parseJson(putRes.text);
    if (putRes && (putRes.status === 404 || putRes.status === 410)) {
      await AsyncStorage.removeItem('@blinkit_cart_id');
    }
    return null;
  };

  // Fresh-cart POST quote (ephemeral, no persistent id). Retries on 429 — fresh
  // installs often hit rate limits because address APIs + cart POST fire together.
  const postCart = async (): Promise<any | null> => {
    const headers = {
      'app_client': 'consumer_web',
      'auth_key': token,
      ...geo,
      'access_token': siteAccessToken,
      'Content-Type': 'application/json',
      ...APP_VERSION_HEADERS,
    };
    let res = await requestViaBlinkitBridge(CARTS_URL, 'POST', cartsBody, headers);
    for (const backoff of [2000, 3000]) {
      if (!res || res.status !== 429) break;
      await new Promise(r => setTimeout(r, backoff));
      res = await requestViaBlinkitBridge(CARTS_URL, 'POST', cartsBody, headers);
    }
    return res && res.status === 200 ? parseJson(res.text) : null;
  };

  // Ask the site's session which cart is currently active.
  const fetchActiveCartId = async (): Promise<number> => {
    const got = await requestViaBlinkitBridge(CARTS_URL, 'GET', '', {
      'app_client': 'consumer_web',
      'auth_key': token,
      ...geo,
      ...APP_VERSION_HEADERS,
    });
    return got && got.status === 200 ? cartIdFrom(parseJson(got.text)) : NaN;
  };

  // 1. Known persistent cart → price it directly (one round trip).
  let resJson: any = null;
  let triedCartId = NaN;
  if (knownCartId) {
    triedCartId = knownCartId;
    resJson = await putCart(knownCartId);
  }

  // 2. Otherwise (or if the PUT failed) fall back to a POST quote, then use any
  //    cart id it reveals to PUT-price the persistent cart. The POST is skipped
  //    when simulating a no-address session so the server sees no address context.
  if (!resJson) {
    const posted = simulateNoAddress ? null : await postCart();
    resJson = posted;
    const freshId = cartIdFrom(posted) || (knownCartId ? NaN : await fetchActiveCartId());
    if (freshId && freshId !== triedCartId) {
      const put = await putCart(freshId);
      if (put) resJson = put;
    }
  }

  // 3. Last resort: direct (non-bridge) POST.
  if (!resJson) {
    const response = await deps.fetchWithTimeout(CARTS_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'app_client': 'consumer_web',
        'auth_key': simulateNoAddress ? '' : token,
        ...geo,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
        'DeviceID': deviceId,
        'device_id': deviceId,
        'deviceid': deviceId,
        'x-device-id': deviceId,
        ...APP_VERSION_HEADERS,
        ...(!simulateNoAddress && siteCookies ? { 'Cookie': siteCookies } : {})
      },
      body: cartsBody
    }, 6000);
    if (response.ok) resJson = await response.json();
  }

  if (resJson) {
    const fees = deps.parseBlinkitBill(resJson);
    if (fees.subtotal !== null) subtotal = fees.subtotal;
    if (fees.deliveryFee !== null) deliveryFee = fees.deliveryFee;
    if (fees.handlingFee !== null) handlingFee = fees.handlingFee;
    if (fees.smallCartFee !== null) smallCartFee = fees.smallCartFee;
    if (fees.surgeFee) surgeFee = fees.surgeFee;
    if (fees.surgeLabel) surgeLabel = fees.surgeLabel;
    freeDeliveryGap = fees.freeDeliveryGap ?? undefined;
    if (fees.tax !== null) tax = fees.tax;
    if (fees.total !== null) {
      total = fees.total;
      liveBill = true;
      if (fees.subtotal === null) {
        const otherCharges = (fees.deliveryFee ?? 0) + (fees.handlingFee ?? 0) + (fees.smallCartFee ?? 0) + (fees.surgeFee ?? 0) + (fees.tax ?? 0);
        if (fees.total >= otherCharges) {
          subtotal = fees.total - otherCharges;
        }
      }
    }

    // Extract Blinkit stock statuses
    const returnedActiveBlinkitPids = new Set<string>();
    const returnedOosBlinkitPids = new Set<string>();

    const extractBlinkitItemsList = (json: any): any[] => {
      const list: any[] = [];
      const cd = json?.cart_data || json?.data || json;
      if (Array.isArray(cd?.items)) list.push(...cd.items);
      if (Array.isArray(cd?.cart_items)) list.push(...cd.cart_items);
      if (Array.isArray(json?.items)) list.push(...json.items);
      if (Array.isArray(cd?.shipments)) {
        for (const s of cd.shipments) {
          if (Array.isArray(s?.items)) list.push(...s.items);
          if (Array.isArray(s?.cart_items)) list.push(...s.cart_items);
          if (Array.isArray(s?.products)) list.push(...s.products);
        }
      }
      return list;
    };

    const getBlinkitPids = (item: any): string[] => {
      const ids: string[] = [];
      if (item?.product_id) ids.push(String(item.product_id));
      if (item?.id) ids.push(String(item.id));
      if (item?.merchant_product_id) ids.push(String(item.merchant_product_id));
      if (item?.product?.id) ids.push(String(item.product.id));
      if (item?.product?.product_id) ids.push(String(item.product.product_id));
      if (item?.item_id) ids.push(String(item.item_id));
      return ids;
    };

    const allBlinkitItems = extractBlinkitItemsList(resJson);
    for (const it of allBlinkitItems) {
      const pids = getBlinkitPids(it);
      const isOos = it.in_stock === false ||
                    it.is_available === false ||
                    it.available === false ||
                    it.out_of_stock === true ||
                    it.is_oos === true ||
                    it.status === 'OUT_OF_STOCK' ||
                    it.status === 'OOS' ||
                    (typeof it.inventory?.stock === 'number' && it.inventory.stock <= 0) ||
                    (typeof it.stock === 'number' && it.stock <= 0) ||
                    (typeof it.quantity === 'number' && it.quantity <= 0);

      let billedQty: number | undefined = undefined;
      if (typeof it.quantity === 'number' && it.quantity > 0) billedQty = it.quantity;

      let stockNum: number | undefined = undefined;
      if (typeof it.inventory === 'number' && it.inventory >= 0) stockNum = it.inventory;
      else if (typeof it.inventory?.stock === 'number' && it.inventory.stock >= 0) stockNum = it.inventory.stock;
      else if (typeof it.stock === 'number' && it.stock >= 0) stockNum = it.stock;
      else if (typeof it.available_units === 'number' && it.available_units >= 0) stockNum = it.available_units;
      else if (typeof it.available_quantity === 'number' && it.available_quantity >= 0) stockNum = it.available_quantity;

      let maxQ: number | undefined = undefined;
      if (typeof it.max_quantity === 'number' && it.max_quantity > 0) maxQ = it.max_quantity;
      else if (typeof it.purchase_limit === 'number' && it.purchase_limit > 0) maxQ = it.purchase_limit;

      const reqItem = items.find(ci => {
        const resolved = resolvePlatformProduct(ci, 'blinkit');
        if (!resolved) return false;
        const pid = String(resolved.product.originalId || resolved.product.productId || resolved.product.id.replace('blinkit-', ''));
        return pids.includes(pid) || pids.includes(String(resolved.product.id));
      });
      const reqQty = reqItem?.quantity;

      let effLimit: number | undefined = undefined;
      if (stockNum !== undefined && maxQ !== undefined) {
        effLimit = Math.min(stockNum, maxQ);
      } else if (stockNum !== undefined) {
        effLimit = stockNum;
      } else if (maxQ !== undefined) {
        effLimit = maxQ;
      } else if (billedQty !== undefined && reqQty !== undefined && billedQty < reqQty) {
        effLimit = billedQty;
      }

      for (const pid of pids) {
        if (isOos) {
          returnedOosBlinkitPids.add(pid);
          platformItemLimits[pid] = 0;
        } else {
          returnedActiveBlinkitPids.add(pid);
          if (billedQty !== undefined) platformItemQuantities[pid] = billedQty;
          if (effLimit !== undefined) platformItemLimits[pid] = effLimit;
        }
      }
    }

    const cd = resJson?.cart_data || resJson?.data || resJson;
    const oosArrays = [
      cd?.unavailable_items,
      cd?.out_of_stock_items,
      cd?.unserviceable_items,
      cd?.oos_items,
      resJson?.unavailable_items,
      resJson?.out_of_stock_items,
    ];
    for (const arr of oosArrays) {
      if (Array.isArray(arr)) {
        for (const it of arr) {
          for (const pid of getBlinkitPids(it)) {
            returnedOosBlinkitPids.add(pid);
            platformItemLimits[pid] = 0;
          }
        }
      }
    }

    for (const cartItem of items) {
      const resolved = resolvePlatformProduct(cartItem, 'blinkit');
      if (!resolved) {
        outOfStockProductIds.push(cartItem.product.id);
        platformItemLimits[cartItem.product.id] = 0;
        continue;
      }
      const pid = String(resolved.product.originalId || resolved.product.productId || resolved.product.id.replace('blinkit-', ''));
      const rawId = String(resolved.product.id);

      if (returnedOosBlinkitPids.has(pid) || returnedOosBlinkitPids.has(rawId)) {
        outOfStockProductIds.push(cartItem.product.id);
        platformItemLimits[cartItem.product.id] = 0;
      } else if (returnedActiveBlinkitPids.has(pid) || returnedActiveBlinkitPids.has(rawId)) {
        inStockProductIds.push(cartItem.product.id);
        const lim = platformItemLimits[pid] ?? platformItemLimits[rawId] ?? getItemPlatformLimit(resolved.product);
        if (lim !== undefined) platformItemLimits[cartItem.product.id] = lim;
        const qty = platformItemQuantities[pid] ?? platformItemQuantities[rawId];
        if (qty !== undefined) platformItemQuantities[cartItem.product.id] = qty;
      } else if (liveBill && allBlinkitItems.length > 0 && returnedActiveBlinkitPids.size > 0 && !returnedActiveBlinkitPids.has(pid)) {
        // Dropped by Blinkit because unavailable
        outOfStockProductIds.push(cartItem.product.id);
        platformItemLimits[cartItem.product.id] = 0;
      } else if (resolved.product.inStock === false) {
        outOfStockProductIds.push(cartItem.product.id);
        platformItemLimits[cartItem.product.id] = 0;
      } else {
        // Valid bill received without OOS flag = in stock!
        inStockProductIds.push(cartItem.product.id);
        const lim = getItemPlatformLimit(resolved.product);
        if (lim !== undefined) platformItemLimits[cartItem.product.id] = lim;
      }
    }
  }

  return {
    subtotal, deliveryFee, handlingFee, smallCartFee, surgeFee, surgeLabel,
    freeDeliveryGap, tax, total, liveBill, outOfStockProductIds, inStockProductIds,
  };
}
