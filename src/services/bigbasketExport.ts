// BigBasket "Export to BigBasket" flow.
//
// Mirrors the grocery order optimizer BigBasket cart export flow:
//   1. Resolve each item in the cart to a BigBasket product (using fast-path stored IDs
//      or live bbnow listing search).
//   2. Empty the previous cart via POST /mapi/v4.2.0/c-empty/ {_bb_client_type: 'web'}.
//   3. Write new items via POST /mapi/v4.2.0/c-set-i/ {prod_id, qty, _bb_client_type: 'web'}.
//   4. Verify basket via GET /order/v1/basket/detail/?is_split_order_supported=true&offer_communication=true.
//   5. Open /basket/ in the visible WebView with user session cookies active.

import {
  api,
  UnifiedProduct,
  resolvePlatformProduct,
  cleanBigBasketAddrId,
} from './api';
import { storage } from './storage';
import { requestViaBigBasketBridge, requestEvalViaBigBasketBridge } from './bigbasketBridge';

export interface BigBasketExportItem {
  prod_id: string;
  quantity: number;
  name: string;
  price: number;
  mrp: number;
  imageUrl?: string;
  unit?: string;
}

export interface BigBasketExportResult {
  items: BigBasketExportItem[];
  verified: boolean;
  cartUrl: string;
  missing: { name: string; quantity: string }[];
  addrId?: string;
  lat?: string;
  lng?: string;
  cityId?: string;
}

function resolveBigBasketItem(
  line: { product: UnifiedProduct; quantity: number }
): { body: BigBasketExportItem | null; name: string; unit: string; notFound: boolean } {
  const v = resolvePlatformProduct(line, 'bigbasket');
  const base = v?.product || null;
  const qty = Math.max(1, Math.round(line.quantity) || 1);

  const name = base?.title || line.product.title;
  const unit = base?.quantity || line.product.quantity;
  const price = base?.price || line.product.price || 0;
  const mrp = base?.originalPrice || price;
  const imageUrl = base?.imageUrl || line.product.imageUrl;

  const prodId = base?.productId || base?.originalId || (base?.platform === 'bigbasket' ? base.id : null);

  if (prodId && /^\d+$/.test(String(prodId).trim())) {
    return {
      body: {
        prod_id: String(prodId).trim(),
        quantity: qty,
        name,
        price,
        mrp,
        imageUrl,
        unit,
      },
      name,
      unit,
      notFound: false,
    };
  }

  return { body: null, name, unit, notFound: true };
}

export async function exportCartToBigBasket(
  cartItems: { product: UnifiedProduct; quantity: number }[]
): Promise<BigBasketExportResult | null> {
  const token = await storage.getToken('bigbasket');
  if (!token) {
    console.warn('[BigBasketExport] No token found in storage');
    return null;
  }

  const itemsToWrite: BigBasketExportItem[] = [];
  const missing: { name: string; quantity: string }[] = [];

  for (const line of cartItems) {
    let resolved = resolveBigBasketItem(line);

    // If not found directly, try live search fallback
    if (resolved.notFound || !resolved.body) {
      try {
        const searchResults = await api.searchSingle('bigbasket', resolved.name);
        if (searchResults && searchResults.length > 0) {
          const match = searchResults[0];
          const prodId = match.productId || match.originalId || match.id;
          if (prodId && /^\d+$/.test(String(prodId).trim())) {
            resolved = {
              body: {
                prod_id: String(prodId).trim(),
                quantity: Math.max(1, Math.round(line.quantity) || 1),
                name: match.title,
                price: match.price,
                mrp: match.originalPrice || match.price,
                imageUrl: match.imageUrl,
                unit: match.quantity,
              },
              name: match.title,
              unit: match.quantity,
              notFound: false,
            };
          }
        }
      } catch (e) {
        console.warn('[BigBasketExport] fallback search failed for', resolved.name, e);
      }
    }

    if (resolved.body && resolved.body.prod_id) {
      itemsToWrite.push(resolved.body);
    } else {
      missing.push({ name: resolved.name, quantity: `${line.quantity}x` });
    }
  }

  if (itemsToWrite.length === 0) {
    return {
      items: [],
      verified: false,
      cartUrl: 'https://www.bigbasket.com/basket/',
      missing,
    };
  }

  console.log(`[BigBasketExport] Writing ${itemsToWrite.length} items to BigBasket cart...`);

  // 0. Resolve the closest delivery address for the user's current GPS/manual location
  let targetAddrId = '';
  let targetLat = '';
  let targetLng = '';
  let targetCityId = '';

  try {
    const loc = await storage.getLocation();
    const userLat = loc?.latitude || 0;
    const userLng = loc?.longitude || 0;
    const closest = await api.getClosestBigBasketAddress(userLat, userLng);

    if (closest) {
      if (closest.id && !['location-context', 'current-gps-loc'].includes(String(closest.id))) {
        targetAddrId = cleanBigBasketAddrId(closest.id);
      }
      targetLat = String(closest.latitude || userLat || '');
      targetLng = String(closest.longitude || userLng || '');
      targetCityId = String(closest.city_id || '');
    }

    if (!targetLat && userLat) targetLat = String(userLat);
    if (!targetLng && userLng) targetLng = String(userLng);

    // If an address ID was found, tell BigBasket to switch the active address in checkout
    if (targetAddrId) {
      try {
        await requestViaBigBasketBridge(
          'https://www.bigbasket.com/order/v2/checkout',
          'POST',
          JSON.stringify({
            is_split_order_supported: true,
            offer_communication: true,
            action: 'change_address',
            address_id: Number(targetAddrId),
          })
        );
      } catch {}

      try {
        await requestViaBigBasketBridge(
          'https://www.bigbasket.com/mapi/v4.2.0/member-address/select/',
          'POST',
          JSON.stringify({ address_id: Number(targetAddrId), id: Number(targetAddrId) })
        );
      } catch {}
    }

    // Set delivery context cookies inside the bridge
    const setCtxScript = `
      (function() {
        try {
          if (${JSON.stringify(targetLat)}) document.cookie = '_bb_lat=' + encodeURIComponent(${JSON.stringify(targetLat)}) + '; path=/; domain=.bigbasket.com; max-age=31536000';
          if (${JSON.stringify(targetLng)}) document.cookie = '_bb_long=' + encodeURIComponent(${JSON.stringify(targetLng)}) + '; path=/; domain=.bigbasket.com; max-age=31536000';
          document.cookie = '_bb_locSrc=saved; path=/; domain=.bigbasket.com; max-age=31536000';
          if (${JSON.stringify(targetAddrId)}) {
            document.cookie = '_bb_aid=' + encodeURIComponent(${JSON.stringify(targetAddrId)}) + '; path=/; domain=.bigbasket.com; max-age=31536000';
          }
          if (${JSON.stringify(targetCityId)}) {
            document.cookie = '_bb_cid=' + encodeURIComponent(${JSON.stringify(targetCityId)}) + '; path=/; domain=.bigbasket.com; max-age=31536000';
          }
          document.cookie = '_bb_rd=1; path=/; domain=.bigbasket.com; max-age=31536000';
        } catch(e) {}
      })()
    `;
    await requestEvalViaBigBasketBridge(setCtxScript, 3000);
  } catch (e) {
    console.warn('[BigBasketExport] Context resolution failed', e);
  }

  // 1. Empty previous cart
  try {
    const emptyRes = await requestViaBigBasketBridge(
      'https://www.bigbasket.com/mapi/v4.2.0/c-empty/',
      'POST',
      JSON.stringify({ _bb_client_type: 'web' })
    );
    console.log('[BigBasketExport] Empty cart status:', emptyRes?.status);
  } catch (e) {
    console.warn('[BigBasketExport] Empty cart call failed, proceeding to set items', e);
  }

  // 2. Add each item
  for (const item of itemsToWrite) {
    try {
      const setRes = await requestViaBigBasketBridge(
        'https://www.bigbasket.com/mapi/v4.2.0/c-set-i/',
        'POST',
        JSON.stringify({
          prod_id: item.prod_id,
          qty: item.quantity,
          _bb_client_type: 'web',
        })
      );
      console.log(`[BigBasketExport] Set item ${item.prod_id} (${item.name}): status ${setRes?.status}`);
    } catch (eSet) {
      console.warn(`[BigBasketExport] Failed to add item ${item.prod_id}`, eSet);
    }
  }

  // 3. Verify basket
  let verified = false;
  try {
    const basketRes = await requestViaBigBasketBridge(
      'https://www.bigbasket.com/order/v1/basket/detail/?is_split_order_supported=true&offer_communication=true',
      'GET'
    );
    if (basketRes && basketRes.status === 200) {
      verified = true;
      console.log('[BigBasketExport] Basket successfully verified!');
    }
  } catch (eB) {
    console.warn('[BigBasketExport] Basket verify call failed', eB);
  }

  const cartUrl = 'https://www.bigbasket.com/basket/';

  return {
    items: itemsToWrite,
    verified,
    cartUrl,
    missing,
    addrId: targetAddrId,
    lat: targetLat,
    lng: targetLng,
    cityId: targetCityId,
  };
}
