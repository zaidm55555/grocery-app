// Swiggy (Instamart) "Export to Swiggy" flow.
//
// Mirrors the reference grocery-order-optimizer extension's Instamart cart
// export path, which is almost pure API (unlike Blinkit there is a real
// empty-cart endpoint and a real /cart URL — no DOM clicking):
//   1. Read the current cart   GET  /api/instamart/checkout/v2/cart
//      → seeds metadata.values, deliveryType; discovers storeId + shipmentIdV2.
//   2. Resolve store (if cart empty)  GET /api/instamart/home/v2 → findStoreInfo.
//   3. Resolve each item to {productId, itemId, spinId} (fast-path stored IDs,
//      else a fresh /search/v2 lookup).
//   4. Clear the old cart  POST /api/instamart/checkout/v2/cart/clear
//      { source: 'USER_INITIATED' }  (failure is tolerated).
//   5. Write the new cart  POST /api/instamart/checkout/v2/cart
//      { data: { items:[{productId,quantity,tradeFreebie,spin,itemId,meta{...},
//      serviceLine:'INSTAMART'}], cartMetaData:{...}, cartType:'INSTAMART' },
//      source:'userInitiated' }.
//   6. Read back & verify  GET /api/instamart/checkout/v2/cart → confirm the
//      committed items/quantities match what was requested.
//   7. The caller wipes the visible page's local caches and navigates to
//      /instamart/cart?goCartSync=<ts> (cache-busted) so the SPA refetches the
//      just-committed cart.
//
// Every call runs inside a real swiggy.com page context
// (api.swiggyApiFetch → SwiggyBridgeWebView) so it passes Swiggy's WAF; the
// page-context injection is only to satisfy the Origin/Cookie checks, never to
// touch the DOM.

import {
  api,
  UnifiedProduct,
  resolvePlatformProduct,
  findStoreInfo,
  SwiggyStoreInfo,
  extractSwiggySearchProducts,
  pickInstamartCandidate,
} from './api';
import { storage } from './storage';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface SwiggyExportItem {
  productId: string;
  itemId: string;
  spinId: string;
  quantity: number;
  name: string;
  price: number;
  mrp: number;
  imageUrl: string;
  unit: string;
}

export interface SwiggyExportResult {
  items: SwiggyExportItem[];
  storeId: string | null;
  shipmentIdV2: string;
  verified: boolean;
  cartUrl: string;
  missing: { name: string; quantity: string }[];
  cartId?: string | null;
  oldCartId?: string | null;
  writePayload?: any;
}

const CART_URL = 'https://www.swiggy.com/api/instamart/checkout/v2/cart';
const HOME_URL = 'https://www.swiggy.com/api/instamart/home/v2?offset=0&storeId=&primaryStoreId=&secondaryStoreId=&clientId=INSTAMART-APP';
const CLEAR_URL = 'https://www.swiggy.com/api/instamart/checkout/v2/cart/clear';

async function fetchViaJson(res: any): Promise<any | null> {
  if (!res || !res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Resolve one cart line to Swiggy's {productId, itemId, spinId, quantity}.
function resolveSwiggyItem(
  line: { product: UnifiedProduct; quantity: number }
): { body: SwiggyExportItem | null; name: string; unit: string; notFound: boolean } {
  const v = resolvePlatformProduct(line, 'swiggy');
  const base = v?.product || null;
  const qty = Math.max(1, Math.round(line.quantity) || 1);

  const name = base?.title || line.product.title;
  const unit = base?.quantity || line.product.quantity;
  const price = base?.price || line.product.price || 0;
  const mrp = base?.originalPrice || price;
  const imageUrl = base?.imageUrl || line.product.imageUrl;

  const productId = base?.productId;
  // itemId = the variation/product id pair from Swiggy's own catalog — the
  // auto-match stores it as originalId (mirrors buildBody in api.ts).
  const itemId = base?.originalId;

  if (productId && itemId) {
    return {
      body: { productId: String(productId), itemId: String(itemId), spinId: base?.spinId || '', quantity: qty, name, price, mrp, imageUrl, unit },
      name,
      unit,
      notFound: false,
    };
  }
  return { body: null, name, unit, notFound: productId && itemId ? false : true };
}

// Store + session metadata discovery (mirrors api.ts's calculateCart step,
// reusing the same per-location cache so export doesn't re-pay the GET).
async function discoverStore(
  lat: number,
  lng: number
): Promise<{ storeInfo: SwiggyStoreInfo | null; shipmentIdV2: string; deliveryType: string }> {
  let storeInfo: SwiggyStoreInfo | null = null;
  let cartMetaData: any = {
    contactlessDelivery: false,
    deliveryType: 'INSTANT',
    ageConsentProvided: false,
    useGiftBagPackaging: false,
  };
  let shipmentIdV2 = '';

  const locKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  try {
    const rawCache = await AsyncStorage.getItem('@swiggy_store_cache');
    const parsedCache = rawCache ? JSON.parse(rawCache) : null;
    if (parsedCache && parsedCache.locKey === locKey && parsedCache.storeInfo && Date.now() - parsedCache.at < 24 * 3600 * 1000) {
      storeInfo = parsedCache.storeInfo;
      cartMetaData = { ...cartMetaData, ...(parsedCache.cartMetaData || {}) };
    }
  } catch {}

  // Primary discovery: query HOME_URL for the target location
  if (!storeInfo) {
    try {
      const homeRes = await api.swiggyApiFetch(`${HOME_URL}&lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}&overrideLocation=true`);
      const json = await fetchViaJson(homeRes);
      if (json) storeInfo = findStoreInfo(json);
    } catch {}
  }

  // Fallback: check session cart if HOME_URL failed
  if (!storeInfo) {
    try {
      const getCartRes = await api.swiggyApiFetch(`${CART_URL}?pageType=INSTAMART_CART`);
      const json = await fetchViaJson(getCartRes);
      const cart = json?.data?.data;
      if (cart) {
        const metaValues = cart.metadata?.values || {};
        const sessionItems = cart.items || [];
        shipmentIdV2 = sessionItems[0]?.shipmentIdV2 || sessionItems[0]?.shipmentId || '';
        cartMetaData = {
          contactlessDelivery: !!metaValues.contactless_delivery,
          deliveryType: cart.deliveryType || 'INSTANT',
          ageConsentProvided: !!metaValues.age_consent_provided,
          useGiftBagPackaging: !!metaValues.use_gift_bag_packaging,
        };
        const sessionStoreId = sessionItems[0]?.storeId;
        if (sessionStoreId) {
          storeInfo = {
            storeId: String(sessionStoreId),
            primaryStoreId: String(sessionStoreId),
            secondaryStoreId: '',
            layoutId: '',
          };
        }
      }
    } catch {}
  }

  return {
    storeInfo,
    shipmentIdV2,
    deliveryType: cartMetaData.deliveryType || 'INSTANT',
  };
}

// Fresh /search/v2 lookup per item (only for items without stored IDs).
async function freshSearchItem(
  name: string,
  unit: string,
  storeInfo: SwiggyStoreInfo
): Promise<{ productId: string; itemId: string; spinId: string } | null> {
  const resolvedStoreId = storeInfo.storeId || storeInfo.primaryStoreId || '';
  if (!resolvedStoreId) return null;
  const storeParams = 'offset=0&ageConsent=false' +
    (storeInfo.layoutId ? '&layoutId=' + encodeURIComponent(storeInfo.layoutId) : '') +
    '&voiceSearchTrackingId=' +
    '&storeId=' + encodeURIComponent(resolvedStoreId) +
    '&primaryStoreId=' + encodeURIComponent(storeInfo.primaryStoreId || resolvedStoreId) +
    '&secondaryStoreId=' + encodeURIComponent(storeInfo.secondaryStoreId || resolvedStoreId);
  try {
    const res = await api.swiggyApiFetch(`https://www.swiggy.com/api/instamart/search/v2?${storeParams}`, 'POST', JSON.stringify({
      facets: [],
      sortAttribute: '',
      query: name,
      search_results_offset: '0',
      page_type: 'INSTAMART_PRE_SEARCH_PAGE',
      is_pre_search_tag: false,
    }));
    const json = await fetchViaJson(res);
    if (!json) return null;
    const candidates = extractSwiggySearchProducts(json, name);
    const best = pickInstamartCandidate(candidates, name, unit);
    if (best && best.productId && best.itemId) {
      return { productId: String(best.productId), itemId: String(best.itemId), spinId: best.spinId || '' };
    }
  } catch {}
  return null;
}

/**
 * Main export entry: commit the basket to the user's SAME Swiggy session via
 * the real Instamart checkout APIs (clear → write → verify) and return what's
 * needed to open the cart page. Returns null if Swiggy isn't linked.
 */
export async function exportCartToSwiggy(
  cart: { product: UnifiedProduct; quantity: number }[]
): Promise<SwiggyExportResult | null> {
  const token = await storage.getToken('swiggy');
  if (!token) return null;

  const location = await storage.getLocation();
  if (!location) return null;
  const lat = location.latitude;
  const lng = location.longitude;

  // Resolve items: fast-path stored IDs first, then fresh search.
  const missing: { name: string; quantity: string }[] = [];
  const resolved: (SwiggyExportItem | null)[] = cart.map((line) => {
    const r = resolveSwiggyItem(line);
    if (r.body) return r.body;
    return null;
  });

  const unresolvedNames: { name: string; unit: string; origIndex: number }[] = [];
  resolved.forEach((r, i) => {
    if (!r) unresolvedNames.push({ name: cart[i].product.title, unit: cart[i].product.quantity, origIndex: i });
  });

  const delivery = await api.resolveSwiggyDeliveryAddress(lat, lng);
  const targetLat = delivery?.location?.latitude ?? lat;
  const targetLng = delivery?.location?.longitude ?? lng;

  let storeInfo: SwiggyStoreInfo | null = null;
  let shipmentIdV2 = '';
  let deliveryType = 'INSTANT';

  if (resolved.some(Boolean) || unresolvedNames.length > 0) {
    const disc = await discoverStore(targetLat, targetLng);
    storeInfo = disc.storeInfo;
    shipmentIdV2 = disc.shipmentIdV2;
    deliveryType = disc.deliveryType;
  }

  const resolvedStoreId = storeInfo?.storeId || storeInfo?.primaryStoreId || '';

  // Run fresh searches for unresolved items (needs store context).
  if (unresolvedNames.length && resolvedStoreId && storeInfo) {
    for (let i = 0; i < resolved.length; i++) {
      if (resolved[i]) continue;
      const need = unresolvedNames.find((u) => u.origIndex === i);
      if (!need) continue;
      const found = await freshSearchItem(need.name, need.unit, storeInfo);
      if (found) {
        const qty = Math.max(1, Math.round(cart[i].quantity) || 1);
        const base = resolvePlatformProduct(cart[i], 'swiggy')?.product || cart[i].product;
        resolved[i] = {
          productId: found.productId,
          itemId: found.itemId,
          spinId: found.spinId,
          quantity: qty,
          name: base.title,
          price: base.price || 0,
          mrp: base.originalPrice || base.price || 0,
          imageUrl: base.imageUrl || '',
          unit: base.quantity || '',
        };
      }
    }
  }

  const items: SwiggyExportItem[] = [];
  for (let i = 0; i < resolved.length; i++) {
    if (resolved[i]) items.push(resolved[i]!);
    else missing.push({ name: cart[i].product.title, quantity: cart[i].product.quantity });
  }

  // Find current cartId before clearing
  let oldCartId = '';
  try {
    const getCartRes = await api.swiggyApiFetch(`${CART_URL}?pageType=INSTAMART_CART`);
    const getResText = await getCartRes.text();
    const json = JSON.parse(getResText);
    oldCartId = json?.data?.data?.cartId || '';
  } catch {}

  // Clear the old cart (tolerated on failure — the write still replaces it).
  if (items.length > 0) {
    try {
      await api.swiggyApiFetch(CLEAR_URL, 'POST', JSON.stringify({ source: 'USER_INITIATED' }));
    } catch (e) {
      console.error('[Swiggy API Clear] error:', e);
    }
  }

  // Write the new cart.
  let postOk = false;
  let newCartId: string | null = null;
  let postBodyObj: any = null;
  if (items.length > 0 && resolvedStoreId) {
    // Bind the delivery address (closest saved address to GPS) so the cart
    // page opens at the user's actual location instead of a stale/other
    // address or "select delivery address".
    const bodies = items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      tradeFreebie: false,
      spin: i.spinId || '',
      itemId: i.itemId,
      meta: { type: 'structure', storeId: resolvedStoreId, freebie: false, isGiftBag: false },
      serviceLine: 'INSTAMART',
      ...(shipmentIdV2 ? { shipmentIdV2 } : {}),
    }));

    postBodyObj = {
      data: {
        items: bodies,
        cartMetaData: {
          contactlessDelivery: false,
          deliveryType,
          owner: 'APP',
          preferredAddressId: delivery?.id ?? null,
          ageConsentProvided: false,
          useGiftBagPackaging: false,
          useReusablePackaging: false,
          incognitoCart: false,
          includeConsents: ['PHARMA'],
          primaryStoreId: resolvedStoreId,
          storeIds: [resolvedStoreId],
        },
        cartType: 'INSTAMART',
        ...(delivery?.id ? { addressId: delivery.id } : {}),
        location: delivery?.location ? { latitude: delivery.location.latitude, longitude: delivery.location.longitude } : { latitude: targetLat, longitude: targetLng },
      },
      source: 'userInitiated',
    };

    const postBody = JSON.stringify(postBodyObj);

    let postRes = await api.swiggyApiFetch(CART_URL, 'POST', postBody);
    let postResText = '';
    if (postRes) {
      try {
        postResText = await postRes.text();
      } catch {}
    }

    if (postRes && !postRes.ok) {
      postRes = await api.swiggyApiFetch(CART_URL, 'POST', JSON.stringify({
        ...JSON.parse(postBody),
        data: { ...JSON.parse(postBody).data, cartMetaData: { ...JSON.parse(postBody).data.cartMetaData, storeIds: [resolvedStoreId, resolvedStoreId] } },
      }));
      try {
        postResText = await postRes.text();
      } catch {
        postResText = '';
      }
    }
    postOk = postRes && postRes.ok;

    if (postOk && postResText) {
      try {
        const json = JSON.parse(postResText);
        newCartId = json?.data?.data?.cartId || null;
      } catch {}
    }
  }

  // Verify the committed cart matches what we requested.
  let verified = false;
  if (items.length > 0 && postOk) {
    try {
      const getRes = await api.swiggyApiFetch(`${CART_URL}?pageType=INSTAMART_CART`);
      const getResText = await getRes.text();
      const json = JSON.parse(getResText);
      const cart = json?.data?.data;
      const committed = (cart?.items || []).map((it: any) => ({
        productId: String(it.productId),
        quantity: Number(it.quantity),
      }));
      const want = items.map((i) => ({ productId: String(i.productId), quantity: Number(i.quantity) }));
      verified = want.length === committed.length && want.every((w) =>
        committed.some((c: any) => c.productId === w.productId && c.quantity === w.quantity)
      );
    } catch {}
  }

  const cartUrl = `https://www.swiggy.com/instamart/cart?goCartSync=${Date.now()}`;

  return {
    items,
    storeId: resolvedStoreId || null,
    shipmentIdV2,
    verified,
    cartUrl,
    missing,
    cartId: newCartId,
    oldCartId,
    writePayload: postBodyObj,
  };
}
