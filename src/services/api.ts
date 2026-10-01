import { storage, Platform, LocationData } from './storage';
import { requestViaSwiggyBridge, requestEvalViaSwiggyBridge } from './swiggyBridge';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { priceBlinkitCart } from './blinkitPricing';
import { pickBestMatch, isSameProduct } from '../utils/matcher';
import { stripSizeToken } from '../utils/productKey';

export interface UnifiedProduct {
  id: string;
  title: string;
  brand: string;
  quantity: string;
  price: number;
  originalPrice?: number;
  imageUrl: string;
  platform: Platform;
  isSimulated?: boolean;
  originalId?: string;
  productId?: string;
  spinId?: string;
  storeId?: string;
  inStock?: boolean;
  availableStock?: number;
  maxQuantity?: number;
  // Auto-match: per-platform representation of the SAME cart line, filled by
  // the matcher so one line carries prices from every app (like the desktop
  // optimizer's platformPrices model).
  platformPrices?: Partial<Record<Platform, PlatformVariant>>;
  // Epoch ms of the last live re-validation of this basket line (see basketRefresh.ts).
  refreshedAt?: number;
}

export interface PlatformVariant {
  id: string;
  title: string;
  brand: string;
  quantity: string;
  price: number;
  originalPrice?: number;
  imageUrl: string;
  originalId?: string;
  productId?: string;
  spinId?: string;
  storeId?: string;
  inStock?: boolean;
  availableStock?: number;
  maxQuantity?: number;
}

// Effective product used when pricing a cart line on a given platform:
// the auto-matched variant when present, otherwise the line's own fields
// if it originated from that platform, else null (line doesn't exist there).
export function resolvePlatformProduct(item: { product: UnifiedProduct; quantity: number }, platform: Platform): { product: UnifiedProduct; quantity: number } | null {
  const v = item.product.platformPrices?.[platform];
  if (v) {
    const lim = getItemPlatformLimit(v);
    const effectiveQty = (typeof lim === 'number' && lim > 0) ? Math.min(item.quantity, lim) : item.quantity;
    return {
      product: {
        ...item.product,
        // Attribute the variant to the platform it was matched on — the
        // spread above carries the SOURCE platform otherwise.
        platform,
        id: v.id || `${platform}-${v.productId || v.originalId || 'x'}`,
        title: v.title,
        brand: v.brand,
        quantity: v.quantity,
        price: v.price,
        originalPrice: v.originalPrice,
        imageUrl: v.imageUrl,
        originalId: v.originalId,
        productId: v.productId,
        spinId: v.spinId,
        storeId: v.storeId,
        inStock: v.inStock !== undefined ? v.inStock : item.product.inStock,
        availableStock: v.availableStock,
        maxQuantity: v.maxQuantity,
      },
      quantity: effectiveQty
    };
  }
  if (item.product.platform === platform) {
    const lim = getItemPlatformLimit(item.product);
    const effectiveQty = (typeof lim === 'number' && lim > 0) ? Math.min(item.quantity, lim) : item.quantity;
    return {
      product: item.product,
      quantity: effectiveQty
    };
  }
  return null;
}

export interface CartCalculation {
  platform: Platform;
  items: { product: UnifiedProduct; quantity: number }[];
  subtotal: number;
  deliveryFee: number;
  handlingFee: number;
  smallCartFee: number;
  surgeFee: number;
  // Platform-provided name for the surge line (e.g. "Late Night Fee").
  surgeLabel?: string;
  tax: number;
  total: number;
  savings: number;
  // Rupees of extra items needed to unlock free delivery, as reported by the
  // platform for this exact bill. Undefined = unknown / already free / n/a.
  freeDeliveryGap?: number;
  // True when a live checkout bill was fetched from the platform's own API
  // (false = baseline estimate only / not fetched).
  live?: boolean;
  outOfStockProductIds?: string[];
  inStockProductIds?: string[];
  platformItemLimits?: Record<string, number>;
  platformItemQuantities?: Record<string, number>;
}

export function getItemPlatformLimit(product: UnifiedProduct | PlatformVariant | null | undefined): number | undefined {
  if (!product) return undefined;
  const stock = typeof product.availableStock === 'number' && product.availableStock >= 0 ? product.availableStock : undefined;
  const maxQ = typeof product.maxQuantity === 'number' && product.maxQuantity > 0 ? product.maxQuantity : undefined;
  if (stock !== undefined && maxQ !== undefined) return Math.min(stock, maxQ);
  return stock ?? maxQ;
}

// A saved listing the live catalog search reported as unavailable (inStock false
// or a stock limit of 0). For Swiggy, search is the availability authority: the
// cart API happily accepts and bills stale item ids for items that no longer
// show up in search, so such lines must never be sent for pricing.
export function isKnownUnavailable(product: UnifiedProduct | PlatformVariant | null | undefined): boolean {
  if (!product) return true;
  const lim = getItemPlatformLimit(product);
  return product.inStock === false || (lim !== undefined && lim <= 0);
}

export function getProductPlatformLimit(
  product: UnifiedProduct,
  platform: Platform,
  calculations?: CartCalculation[]
): number | undefined {
  let limit: number | undefined = undefined;

  // 1. Direct platform of product
  if (product.platform === platform) {
    limit = getItemPlatformLimit(product);
  } else if (product.platformPrices?.[platform]) {
    limit = getItemPlatformLimit(product.platformPrices[platform]);
  }

  // 2. Check live calculation limits if present
  if (calculations && calculations.length > 0) {
    for (const c of calculations) {
      if (c.platform === platform && c.platformItemLimits) {
        const variant = product.platform === platform ? product : product.platformPrices?.[platform];
        const candKeys = [
          product.id,
          product.originalId,
          product.productId,
          product.id.replace(`${platform}-`, ''),
          ...(variant ? [
            variant.id,
            variant.originalId,
            variant.productId,
            String(variant.id || '').replace(`${platform}-`, ''),
          ] : [])
        ].filter(Boolean) as string[];

        for (const k of candKeys) {
          if (c.platformItemLimits[k] !== undefined) {
            limit = c.platformItemLimits[k];
            break;
          }
        }
      }
    }
  }

  return limit;
}

export function getProductOverallMax(
  product: UnifiedProduct,
  calculations?: CartCalculation[]
): {
  maxAllowed: number;
  blinkitLimit?: number;
  swiggyLimit?: number;
  isAsymmetric: boolean;
} {
  const blinkitLimit = getProductPlatformLimit(product, 'blinkit', calculations);
  const swiggyLimit = getProductPlatformLimit(product, 'swiggy', calculations);

  const hasBlinkit = product.platform === 'blinkit' || !!product.platformPrices?.blinkit;
  const hasSwiggy = product.platform === 'swiggy' || !!product.platformPrices?.swiggy;

  let maxAllowed = 99;
  if (hasBlinkit && hasSwiggy) {
    const bCap = blinkitLimit ?? 99;
    const sCap = swiggyLimit ?? 99;
    maxAllowed = Math.max(bCap, sCap);
  } else if (hasBlinkit) {
    maxAllowed = blinkitLimit ?? 99;
  } else if (hasSwiggy) {
    maxAllowed = swiggyLimit ?? 99;
  }

  if (maxAllowed < 1 && (blinkitLimit !== undefined || swiggyLimit !== undefined)) {
    maxAllowed = Math.max(1, Math.max(blinkitLimit ?? 0, swiggyLimit ?? 0));
  }

  const isAsymmetric = (
    blinkitLimit !== undefined &&
    swiggyLimit !== undefined &&
    blinkitLimit !== swiggyLimit
  );

  return { maxAllowed, blinkitLimit, swiggyLimit, isAsymmetric };
}

export interface AddressCacheEntry {
  lat: number;
  lng: number;
  status: 'in_range' | 'too_far' | 'no_address';
  address: any | null;
  distanceKm?: number;
  name?: string;
  at: number;
}

let swiggyAddressSessionCache: AddressCacheEntry | null = null;
let blinkitAddressSessionCache: AddressCacheEntry | null = null;

export function invalidateAddressSessionCache() {
  swiggyAddressSessionCache = null;
  blinkitAddressSessionCache = null;
}

export const api = {
  fetchWithTimeout(url: string, options: RequestInit, timeout = 6000): Promise<Response> {
    return Promise.race([
      fetch(url, options),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('Network timeout')), timeout))
    ]);
  },

  async getBlinkitAddresses(lat: number, lng: number): Promise<any[]> {
    const token = await storage.getToken('blinkit');
    if (!token) return [];

    const url = `https://blinkit.com/v4/address?cur_lat=${lat}&cur_lon=${lng}`;
    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'access_token': token,
          'auth_key': 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
          'app_client': 'consumer_web',
          'lat': String(lat),
          'lon': String(lng),
          'platform': 'mobile_web',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
        }
      });

      if (!response.ok) {
        return [];
      }

      const json = await response.json();
      const list = json?.addresses || json?.data || json?.addresses_data || (Array.isArray(json) ? json : null);
      if (list && !Array.isArray(list) && list.addresses_data) {
        return list.addresses_data;
      }
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },

  async getClosestBlinkitAddress(lat: number, lng: number, force = false): Promise<any | null> {
    const distanceKm = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
      const R = 6371;
      const dLat = (bLat - aLat) * Math.PI / 180;
      const dLng = (bLng - aLng) * Math.PI / 180;
      return 2 * R * Math.asin(Math.sqrt(
        Math.sin(dLat / 2) ** 2 +
        Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
      ));
    };

    // 1. Check in-memory session cache first (instant 0ms)
    if (!force && blinkitAddressSessionCache) {
      const d = distanceKm(lat, lng, blinkitAddressSessionCache.lat, blinkitAddressSessionCache.lng);
      if (d < 1) {
        if (blinkitAddressSessionCache.status === 'in_range') {
          return blinkitAddressSessionCache.address;
        }
        return null;
      }
    }

    // 2. Check persistent AsyncStorage cache
    const CACHE_KEY = '@blinkit_address_cache';
    if (!force) {
      try {
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        if (raw) {
          const cached: AddressCacheEntry = JSON.parse(raw);
          const fresh = typeof cached.at === 'number' && Date.now() - cached.at < 24 * 3600 * 1000;
          const nearby = typeof cached.lat === 'number' && typeof cached.lng === 'number' && distanceKm(lat, lng, cached.lat, cached.lng) < 1;
          if (fresh && nearby) {
            blinkitAddressSessionCache = cached;
            if (cached.status === 'in_range') {
              await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({
                status: 'in_range',
                distanceKm: cached.distanceKm,
                name: cached.name,
                addressId: cached.address?.id
              }));
              return cached.address;
            } else if (cached.status === 'too_far') {
              await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({
                status: 'too_far',
                distanceKm: cached.distanceKm,
                name: cached.name || 'Unnamed'
              }));
              return null;
            } else if (cached.status === 'no_address') {
              await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({ status: 'no_address' }));
              return null;
            }
          }
        }
      } catch {}
    }

    // 3. Network fetch (only executed on initial app sync or when GPS location changed)
    const addresses = await this.getBlinkitAddresses(lat, lng);
    if (addresses.length === 0) {
      const entry: AddressCacheEntry = {
        lat,
        lng,
        status: 'no_address',
        address: null,
        at: Date.now()
      };
      blinkitAddressSessionCache = entry;
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry));
      await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({ status: 'no_address' }));
      return null;
    }

    let closest: any = null;
    let minDistance = Infinity;

    for (const addr of addresses) {
      const aLat = parseFloat(addr.latitude || addr.lat);
      const aLng = parseFloat(addr.longitude || addr.lon || addr.lng);
      if (!isNaN(aLat) && !isNaN(aLng)) {
        const d = distanceKm(lat, lng, aLat, aLng);
        if (d < minDistance) {
          minDistance = d;
          closest = addr;
        }
      }
    }


    // Only return the address if it is within 35km of the user's current/manual location
    if (closest && minDistance <= 35) {
      const closestName = closest.display_address || closest.address_string || closest.address || closest.line1 || closest.text || 'Unnamed';
      const entry: AddressCacheEntry = {
        lat,
        lng,
        status: 'in_range',
        address: closest,
        distanceKm: Number(minDistance.toFixed(2)),
        name: closestName,
        at: Date.now()
      };
      blinkitAddressSessionCache = entry;
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry));
      await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({
        status: 'in_range',
        distanceKm: Number(minDistance.toFixed(2)),
        name: closestName,
        addressId: closest.id
      }));
      return closest;
    }
    if (closest) {
      const closestName = closest.name || closest.display_address || 'Unnamed';
      const entry: AddressCacheEntry = {
        lat,
        lng,
        status: 'too_far',
        address: null,
        distanceKm: Number(minDistance.toFixed(2)),
        name: closestName,
        at: Date.now()
      };
      blinkitAddressSessionCache = entry;
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry));
      await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({
        status: 'too_far',
        distanceKm: Number(minDistance.toFixed(2)),
        name: closestName
      }));
    } else {
      const entry: AddressCacheEntry = {
        lat,
        lng,
        status: 'no_address',
        address: null,
        at: Date.now()
      };
      blinkitAddressSessionCache = entry;
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry));
      await AsyncStorage.setItem('@blinkit_address_status', JSON.stringify({
        status: 'no_address'
      }));
    }
    return null;
  },

  /**
   * Fetch all saved addresses from Swiggy's user session across all known endpoints
   * and in-page JavaScript state.
   */
  async getSwiggyAddresses(lat?: number, lng?: number): Promise<any[]> {
    const toNum = (v: any): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const getCoords = (a: any): { lat: number; lon: number } | null => {
      if (!a || typeof a !== 'object') return null;
      let loc: any = a?.location ?? a?.geometry?.location ?? a?.place?.geometry?.location ?? a?.address?.location ?? a?.geo;
      if (typeof loc === 'string') {
        try {
          loc = JSON.parse(loc);
        } catch {
          const parts = String(loc).split(',').map(Number);
          if (parts.length === 2 && parts.every((n: number) => Number.isFinite(n))) return { lat: parts[0], lon: parts[1] };
          loc = undefined;
        }
      }
      if (Array.isArray(loc) && loc.length >= 2) {
        const p0 = toNum(loc[0]);
        const p1 = toNum(loc[1]);
        if (p0 !== null && p1 !== null) {
          if (Math.abs(p0) <= 90 && Math.abs(p1) > 90) return { lat: p0, lon: p1 };
          if (Math.abs(p1) <= 90 && Math.abs(p0) > 90) return { lat: p1, lon: p0 };
          return { lat: p0, lon: p1 };
        }
      }
      const latVal = toNum(
        loc?.latitude ?? loc?.lat ??
        a?.latitude ?? a?.lat ??
        a?.address?.latitude ?? a?.address?.lat ??
        a?.coordinates?.lat ?? a?.coordinates?.latitude ??
        a?.annotation_point?.latitude ?? a?.annotation_point?.lat ??
        a?.delivery_address_point?.latitude ?? a?.delivery_address_point?.lat ??
        a?.delivery_point?.latitude ?? a?.delivery_point?.lat ??
        a?.point?.latitude ?? a?.point?.lat
      );
      const lonVal = toNum(
        loc?.longitude ?? loc?.lon ?? loc?.lng ??
        a?.longitude ?? a?.lon ?? a?.lng ??
        a?.address?.longitude ?? a?.address?.lon ?? a?.address?.lng ??
        a?.coordinates?.lng ?? a?.coordinates?.lon ?? a?.coordinates?.longitude ??
        a?.annotation_point?.longitude ?? a?.annotation_point?.lng ??
        a?.delivery_address_point?.longitude ?? a?.delivery_address_point?.lng ??
        a?.delivery_point?.longitude ?? a?.delivery_point?.lng ??
        a?.point?.longitude ?? a?.point?.lng
      );
      if (latVal === null || lonVal === null) return null;
      return { lat: latVal, lon: lonVal };
    };

    const addrName = (a: any): string | null => {
      if (!a) return null;
      const tag = (typeof a?.tag === 'string' && a.tag.trim()) || (typeof a?.label === 'string' && a.label.trim()) || (typeof a?.name === 'string' && a.name.trim()) || null;
      const direct = a?.formatted_address ?? a?.display_name ?? a?.display_address
        ?? a?.address_text ?? a?.complete_address ?? a?.full_text ?? a?.address_string ?? a?.address ?? a?.address_name ?? a?.addressLine ?? a?.address_line;
      if (typeof direct === 'string' && direct.trim()) {
        const d = direct.trim();
        if (tag && tag.toLowerCase() !== d.toLowerCase() && !d.toLowerCase().startsWith(tag.toLowerCase())) {
          return `${tag} - ${d}`;
        }
        return d;
      }
      const parts = [
        a?.address_line_1 ?? a?.line1 ?? a?.house_number,
        a?.address_line_2 ?? a?.line2 ?? a?.street,
        a?.city ?? a?.locality ?? a?.area,
        a?.district ?? a?.state ?? a?.region,
        a?.pincode ?? a?.zip ?? a?.postal_code
      ];
      const built = parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
      if (built.length) {
        const s = built.join(', ');
        return tag ? `${tag} - ${s}` : s;
      }
      return tag || null;
    };

    const isAddressLike = (item: any): boolean => {
      if (!item || typeof item !== 'object') return false;
      // Reject products, freebies, widgets, layout IDs, store listings
      if (item.productId || item.spinId || item.itemId || item.tradeFreebie || item.isGiftBag || item.widget_type || item.widgetType || item.categoryId || item.layoutId) {
        return false;
      }
      // Require positive address indicators
      if (item.formatted_address || item.display_address || item.address_line_1 || item.address_line1 || item.addressLine1 || item.address_text || item.complete_address || item.address_string || item.full_text) {
        return true;
      }
      if (item.pincode || item.postal_code || item.zip || (item.city && (item.area || item.locality || item.street))) {
        return true;
      }
      if (item.tag === 'Home' || item.tag === 'Work' || item.tag === 'Other' || item.label === 'Home' || item.label === 'Work' || item.label === 'Other') {
        return true;
      }
      if (item.location && typeof item.location === 'object' && (typeof item.location.latitude === 'number' || typeof item.location.lat === 'number' || typeof item.location.lat === 'string')) {
        return true;
      }
      if (typeof item.latitude === 'number' && typeof item.longitude === 'number') {
        return true;
      }
      return false;
    };

    const found: Map<string, { id: string; a: any; source: string; name: string | null; coords: { lat: number; lon: number } | null }> = new Map();

    const ingest = (source: string, raw: any) => {
      if (!raw) return;
      const items: any[] = [];
      const extractItems = (obj: any, parentKey = '') => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (isAddressLike(item)) {
              items.push(item);
            } else if (item && typeof item === 'object') {
              if (item.delivery_address && isAddressLike(item.delivery_address)) items.push(item.delivery_address);
              else if (item.deliveryAddress && isAddressLike(item.deliveryAddress)) items.push(item.deliveryAddress);
              else if (item.address && isAddressLike(item.address)) items.push(item.address);
              else extractItems(item, parentKey);
            }
          }
          return;
        }
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (/address|delivery_address|deliveryAddress|savedAddresses|addresses|customerAddresses/i.test(k) && (Array.isArray(v) || (v && typeof v === 'object'))) {
            if (Array.isArray(v)) {
              for (const item of v) {
                if (isAddressLike(item)) items.push(item);
                else extractItems(item, k);
              }
            } else if (isAddressLike(v)) {
              items.push(v);
            } else {
              extractItems(v, k);
            }
          } else if (/orders|orderHistory|orderList|pastOrders|customerOrders/i.test(k) && Array.isArray(v)) {
            for (const ord of v) {
              if (ord && typeof ord === 'object') {
                const addr = ord.delivery_address || ord.deliveryAddress || ord.address;
                if (addr && isAddressLike(addr)) items.push(addr);
                else extractItems(ord, k);
              }
            }
          } else if (typeof v === 'object' && v !== null && !/widgets|searchResults|gridElements/i.test(k)) {
            extractItems(v, k);
          }
        }
      };
      extractItems(raw);

      for (const a of items) {
        if (!a || typeof a !== 'object') continue;
        const coords = getCoords(a);
        const name = addrName(a);
        const id = String(a?.id ?? a?.address_id ?? a?.addressId ?? (coords ? `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}` : name || ''));
        if (!id) continue;
        if (!found.has(id)) {
          found.set(id, { id, a, source, name, coords });
        } else {
          const existing = found.get(id)!;
          if (!existing.coords && coords) {
            found.set(id, { id, a: { ...existing.a, ...a }, source: `${existing.source}+${source}`, name: name || existing.name, coords });
          }
        }
      }
    };

    // Query candidate endpoints (user address book, past order delivery addresses, profile)
    const endpoints: { url: string; source: string; method?: string; body?: string }[] = [
      { url: 'https://www.swiggy.com/api/instamart/checkout/v2/cart?pageType=INSTAMART_CART', source: 'cart' },
      { url: 'https://www.swiggy.com/dapi/user/profile', source: 'user-profile' },
      { url: 'https://www.swiggy.com/dapi/user/details', source: 'user-details' },
      { url: 'https://www.swiggy.com/api/user/profile', source: 'api-user-profile' },
      { url: 'https://www.swiggy.com/my-account/addresses', source: 'my-account-addresses' },
      { url: 'https://www.swiggy.com/my-account', source: 'my-account' },
      { url: 'https://www.swiggy.com/dapi/address/all', source: 'dapi-all' },
      { url: 'https://www.swiggy.com/dapi/address/addresses_list', source: 'dapi-list' },
      { url: 'https://www.swiggy.com/dapi/address/list', source: 'dapi-address-list' },
      { url: 'https://www.swiggy.com/dapi/user/addresses', source: 'dapi-user-addresses' },
      { url: 'https://www.swiggy.com/api/address/all', source: 'api-address-all' },
      { url: 'https://www.swiggy.com/api/instamart/address/all', source: 'api-instamart-address-all' },
      { url: 'https://www.swiggy.com/api/v1/addresses', source: 'api-v1-addresses' },
    ];

    await Promise.all(
      endpoints.map(async ({ url, source, method, body }) => {
        try {
          const res = await this.swiggyApiFetch(url, method || 'GET', body);
          if (res && res.ok) {
            const rawText = await res.text();
            let parsedData: any = null;
            try {
              parsedData = JSON.parse(rawText);
            } catch {
              // If HTML returned, search for embedded JSON state
              const match = rawText.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/s)
                || rawText.match(/<script id="__NEXT_DATA__"[^>]*>({.+?})<\/script>/s)
                || rawText.match(/window\.ApiData\s*=\s*({.+?});/s);
              if (match && match[1]) {
                try { parsedData = JSON.parse(match[1]); } catch {}
              }
            }
            if (parsedData) {
              ingest(source, parsedData);
            }
          }
        } catch {}
      })
    );

    // Walk order history pages to collect delivery addresses across all locations
    try {
      let lastOrderId: string | null = null;
      for (let page = 0; page < 15; page++) {
        const orderUrl = lastOrderId
          ? `https://www.swiggy.com/dapi/order/all?order_id=${lastOrderId}`
          : 'https://www.swiggy.com/dapi/order/all';
        const orderRes = await this.swiggyApiFetch(orderUrl);
        if (orderRes && orderRes.ok) {
          const json = await orderRes.json().catch(() => null);
          if (json?.data?.orders && Array.isArray(json.data.orders) && json.data.orders.length > 0) {
            ingest(`orders-p${page + 1}`, json);
            const last = json.data.orders[json.data.orders.length - 1];
            if (last?.order_id && String(last.order_id) !== lastOrderId) {
              lastOrderId = String(last.order_id);
            } else {
              break;
            }
          } else {
            break;
          }
        } else {
          break;
        }
      }
    } catch {}

    // In-page bridge evaluation across React/Redux state, Next data, and storage
    try {
      const evalRes = await requestEvalViaSwiggyBridge(`
        (function() {
          try {
            var list = [];
            // 1. Redux/SPA state
            if (window.__INITIAL_STATE__) {
              var s = window.__INITIAL_STATE__;
              if (s.address && s.address.addresses) {
                var a = s.address.addresses;
                if (Array.isArray(a)) list.push(...a);
                else list.push(a);
              }
              if (s.user && s.user.addresses) {
                var u = s.user.addresses;
                if (Array.isArray(u)) list.push(...u);
                else list.push(u);
              }
              if (s.user && s.user.pastAddresses) {
                var pa = s.user.pastAddresses;
                if (Array.isArray(pa)) list.push(...pa);
                else list.push(pa);
              }
              if (s.addresses) {
                if (Array.isArray(s.addresses)) list.push(...s.addresses);
                else list.push(s.addresses);
              }
            }
            // 2. Next Data
            if (window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps) {
              var pp = window.__NEXT_DATA__.props.pageProps;
              if (pp.addresses) {
                if (Array.isArray(pp.addresses)) list.push(...pp.addresses);
                else list.push(pp.addresses);
              }
              if (pp.user && pp.user.addresses) {
                if (Array.isArray(pp.user.addresses)) list.push(...pp.user.addresses);
                else list.push(pp.user.addresses);
              }
            }
            // 3. ApiData
            if (window.ApiData) {
              if (window.ApiData.addresses) {
                var ad = window.ApiData.addresses;
                if (Array.isArray(ad)) list.push(...ad);
                else list.push(ad);
              }
              if (window.ApiData.instamartCartApiData) list.push(window.ApiData.instamartCartApiData);
              if (window.ApiData.userAddresses) {
                var ua = window.ApiData.userAddresses;
                if (Array.isArray(ua)) list.push(...ua);
                else list.push(ua);
              }
            }
            // 4. LocalStorage
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              try {
                var val = JSON.parse(localStorage.getItem(k));
                if (Array.isArray(val)) list.push(...val);
                else if (val && typeof val === 'object') list.push(val);
              } catch(e) {}
            }
            // 5. SessionStorage
            for (var j = 0; j < sessionStorage.length; j++) {
              var sk = sessionStorage.key(j);
              try {
                var sval = JSON.parse(sessionStorage.getItem(sk));
                if (Array.isArray(sval)) list.push(...sval);
                else if (sval && typeof sval === 'object') list.push(sval);
              } catch(e) {}
            }
            return list;
          } catch(e) { return []; }
        })()
      `, 4000);
      if (evalRes && evalRes.text) {
        const parsed = JSON.parse(evalRes.text);
        ingest('bridge-eval', parsed);
      }
    } catch {}

    return [...found.values()].map(e => ({
      id: e.id,
      name: e.name,
      address: e.name,
      location: e.coords ? { latitude: e.coords.lat, longitude: e.coords.lon } : null,
      latitude: e.coords?.lat,
      longitude: e.coords?.lon,
      source: e.source,
      raw: e.a
    }));
  },

  /**
   * Resolve the Instamart delivery address: Swiggy's cart page renders its
   * delivery address from the SERVER cart state (GET checkout/v2/cart replies
   * with addressId + addresses[] including coordinates in .location), not
   * localStorage. So picking the saved address closest to the user's GPS and
   * binding it on the cart POST (cartMetaData.preferredAddressId + addressId +
   * location) is what makes pricing AND the opened cart use the right address.
   * The pick is cached (@swiggy_address); re-fetching only happens when the
   * GPS point moves ~6km+ or the cache ages out (24h).
   */
  async resolveSwiggyDeliveryAddress(lat: number, lng: number, force = false): Promise<{ id: string; name: string | null; location: { latitude: number; longitude: number } | null; distanceKm?: number } | null> {
    const KEY = '@swiggy_address';
    const distanceKm = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
      const R = 6371;
      const dLat = (bLat - aLat) * Math.PI / 180;
      const dLng = (bLng - aLng) * Math.PI / 180;
      return 2 * R * Math.asin(Math.sqrt(
        Math.sin(dLat / 2) ** 2 +
        Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
      ));
    };

    // 1. Check in-memory session cache first (instant 0ms)
    if (!force && swiggyAddressSessionCache) {
      const d = distanceKm(lat, lng, swiggyAddressSessionCache.lat, swiggyAddressSessionCache.lng);
      if (d < 1) {
        if (swiggyAddressSessionCache.status === 'in_range') {
          return swiggyAddressSessionCache.address;
        }
        return null;
      }
    }

    // 2. Check persistent storage cache
    if (!force) {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          const fresh = typeof cached.at === 'number' && Date.now() - cached.at < 24 * 3600 * 1000;
          const nearby = typeof cached.lat === 'number' && typeof cached.lng === 'number' && distanceKm(lat, lng, cached.lat, cached.lng) < 1;
          if (fresh && nearby) {
            swiggyAddressSessionCache = cached;
            if (cached.status === 'too_far') {
              await AsyncStorage.setItem('@swiggy_address_status', JSON.stringify({
                status: 'too_far',
                distanceKm: cached.distanceKm,
                name: cached.name || 'Unnamed'
              }));
              return null;
            }
            if (cached.status === 'no_address') {
              await AsyncStorage.setItem('@swiggy_address_status', JSON.stringify({ status: 'no_address' }));
              return null;
            }
            if (cached.id && (cached.status === 'in_range' || !cached.status)) {
              const addr = cached.address || {
                id: String(cached.id),
                name: cached.name || null,
                location: cached.location ? { latitude: cached.location.latitude, longitude: cached.location.longitude } : null,
                distanceKm: typeof cached.distanceKm === 'number' ? cached.distanceKm : undefined
              };
              await AsyncStorage.setItem('@swiggy_address_status', JSON.stringify({
                status: 'in_range',
                distanceKm: cached.distanceKm,
                name: cached.name,
                addressId: cached.id
              }));
              return addr;
            }
          }
        }
      } catch {}
    }

    // 3. Network fetch (only executed on initial app sync or when GPS location changed)
    try {
      const addresses = await this.getSwiggyAddresses(lat, lng);

      const scored = addresses.map((a) => {
        const d = (typeof a.latitude === 'number' && typeof a.longitude === 'number')
          ? distanceKm(lat, lng, a.latitude, a.longitude)
          : Number.POSITIVE_INFINITY;
        return {
          id: String(a.id),
          name: a.name || null,
          location: a.location || (typeof a.latitude === 'number' && typeof a.longitude === 'number' ? { latitude: a.latitude, longitude: a.longitude } : null),
          distanceKm: Number.isFinite(d) ? Number(d.toFixed(2)) : -1,
          d
        };
      }).sort((x, y) => {
        if (x.d === y.d) return 0;
        if (x.distanceKm < 0) return 1;
        if (y.distanceKm < 0) return -1;
        return x.d - y.d;
      });


      if (scored.length === 0) {
        const entry: AddressCacheEntry = {
          lat,
          lng,
          status: 'no_address',
          address: null,
          at: Date.now()
        };
        swiggyAddressSessionCache = entry;
        await AsyncStorage.setItem(KEY, JSON.stringify(entry));
        await AsyncStorage.setItem('@swiggy_address_status', JSON.stringify({
          status: 'no_address'
        }));
        await AsyncStorage.removeItem('@swiggy_address_id');
        await AsyncStorage.removeItem('@swiggy_address_name');
        await AsyncStorage.removeItem('@swiggy_lat');
        await AsyncStorage.removeItem('@swiggy_lng');
        return null;
      }

      const best = scored[0];
      if (!best || best.distanceKm > 35 || best.distanceKm < 0) {
        const entry: AddressCacheEntry = {
          lat,
          lng,
          status: 'too_far',
          distanceKm: best?.distanceKm,
          name: best?.name || 'Unnamed',
          address: null,
          at: Date.now()
        };
        swiggyAddressSessionCache = entry;
        await AsyncStorage.setItem(KEY, JSON.stringify(entry));
        await AsyncStorage.setItem('@swiggy_address_status', JSON.stringify({
          status: 'too_far',
          distanceKm: best?.distanceKm,
          name: best?.name || 'Unnamed'
        }));
        await AsyncStorage.removeItem('@swiggy_address_id');
        await AsyncStorage.removeItem('@swiggy_address_name');
        await AsyncStorage.removeItem('@swiggy_lat');
        await AsyncStorage.removeItem('@swiggy_lng');
        return null;
      }

      const resolvedAddr = {
        id: String(best.id),
        name: best.name,
        location: best.location,
        distanceKm: best.distanceKm
      };
      const entry: AddressCacheEntry = {
        lat,
        lng,
        status: 'in_range',
        address: resolvedAddr,
        distanceKm: best.distanceKm,
        name: best.name,
        at: Date.now()
      };
      swiggyAddressSessionCache = entry;

      await AsyncStorage.setItem('@swiggy_address_status', JSON.stringify({
        status: 'in_range',
        distanceKm: best.distanceKm,
        name: best.name,
        addressId: best.id
      }));

      await AsyncStorage.setItem(KEY, JSON.stringify({
        id: best.id,
        name: best.name,
        location: best.location,
        distanceKm: best.distanceKm,
        status: 'in_range',
        address: resolvedAddr,
        lat,
        lng,
        at: Date.now()
      }));
      await AsyncStorage.setItem('@swiggy_address_id', best.id);
      if (best.name) await AsyncStorage.setItem('@swiggy_address_name', best.name);
      if (best.location) {
        await AsyncStorage.setItem('@swiggy_lat', String(best.location.latitude));
        await AsyncStorage.setItem('@swiggy_lng', String(best.location.longitude));
      }
      return resolvedAddr;
    } catch {
      return null;
    }
  },

  async swiggyApiFetch(url: string, method: string = 'GET', body?: string): Promise<Response | { ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }> {
    const bridged = await requestViaSwiggyBridge(url, method, body);
    if (bridged && bridged.status >= 200 && bridged.status < 300) {
      return {
        ok: true,
        status: bridged.status,
        json: async () => JSON.parse(bridged.text),
        text: async () => bridged.text
      };
    }
    const token = await storage.getToken('swiggy');
    const headers: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
    };
    if (token) headers['Cookie'] = token;
    if (body) headers['Content-Type'] = 'application/json';
    return this.fetchWithTimeout(url, {
      method,
      credentials: 'include',
      headers,
      ...(body ? { body } : {})
    }, 8000);
  },

  async search(query: string, onPlatformResults?: (platform: Platform, results: UnifiedProduct[], error?: string) => void): Promise<UnifiedProduct[]> {
    const platforms: Platform[] = ['blinkit', 'swiggy'];
    const searchPromises = platforms.map(async (platform) => {
      const token = await storage.getToken(platform);
      const location = await storage.getLocation();

      let results: UnifiedProduct[] = [];
      let platformError: string | undefined;
      if (token) {
        try {
          results = await this.fetchDirectAPI(platform, query, token, location);
        } catch (error: any) {
          const msg = error?.message || String(error);
          if (msg.includes('_TOO_FAR') || msg.includes('_NO_ADDRESS') || msg.includes('_UNAVAILABLE')) {
          } else {
            console.warn(`[Search Warning - ${platform} for "${query}"]: ${msg}`);
          }
          results = [];
          platformError = error?.message;
        }
      }

      onPlatformResults?.(platform, results, platformError);
      return results;
    });

    const allResults = await Promise.all(searchPromises);
    return allResults.flat();
  },

  async searchSingle(platform: Platform, query: string): Promise<UnifiedProduct[]> {
    const token = await storage.getToken(platform);
    if (!token) return [];
    const location = await storage.getLocation();
    try {
      return await this.fetchDirectAPI(platform, query, token, location);
    } catch {
      return [];
    }
  },

  async fetchDirectAPI(platform: Platform, query: string, token: string, location: LocationData | null): Promise<UnifiedProduct[]> {
    if (!location) return [];
    const lat = location.latitude;
    const lng = location.longitude;

    if (platform === 'blinkit') {
      let bLat = lat;
      let bLng = lng;
      try {
        const savedBLat = await AsyncStorage.getItem('@blinkit_lat');
        const savedBLng = await AsyncStorage.getItem('@blinkit_lng');
        if (savedBLat && savedBLng && Number.isFinite(Number(savedBLat)) && Number.isFinite(Number(savedBLng))) {
          bLat = Number(savedBLat);
          bLng = Number(savedBLng);
        }
      } catch {}
      // Check if Blinkit closest address is too far (>35km) or no address found
      let bStatusRaw = await AsyncStorage.getItem('@blinkit_address_status');
      if (!bStatusRaw) {
        await this.getClosestBlinkitAddress(lat, lng);
        bStatusRaw = await AsyncStorage.getItem('@blinkit_address_status');
      }
      const bStatus = bStatusRaw ? JSON.parse(bStatusRaw) : null;
      if (bStatus?.status === 'too_far') {
        throw new Error('BLINKIT_UNAVAILABLE: Cannot search Blinkit on your current location.');
      }
      if (bStatus?.status === 'no_address') {
        throw new Error('BLINKIT_UNAVAILABLE: Cannot search Blinkit on your current location.');
      }

      const q = encodeURIComponent(query);
      const url = `https://blinkit.com/v1/layout/search?offset=0&limit=60&actual_query=${q}&q=${q}&search_type=type_to_search`;

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'app_client': 'consumer_web',
          'auth_key': token,
          'lat': String(bLat),
          'lon': String(bLng),
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
        },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        throw new Error(`Blinkit API error: ${response.status}`);
      }

      const json = await response.json();
      const parsed = parseBlinkitProducts(json);

      return parsed.map((item: any) => ({
        id: `blinkit-${item.productId || Math.random()}`,
        title: item.name,
        brand: 'Blinkit',
        quantity: item.unit || '1 unit',
        price: item.price || 0,
        originalPrice: item.mrp || item.price,
        imageUrl: item.image || 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=200&q=80',
        platform: 'blinkit' as Platform,
        originalId: item.productId,
        productId: item.productId,
        spinId: item.spinId,
        storeId: item.storeId,
        availableStock: item.availableStock,
        maxQuantity: item.maxQuantity,
      }));
    }

    if (platform === 'swiggy') {
      const delivery = await this.resolveSwiggyDeliveryAddress(lat, lng);
      const sStatusRaw = await AsyncStorage.getItem('@swiggy_address_status');
      const sStatus = sStatusRaw ? JSON.parse(sStatusRaw) : null;

      // If user is out of range (>35km) or has no address, do not return results
      if (!delivery || !delivery.id || sStatus?.status === 'too_far' || sStatus?.status === 'no_address') {
        if (sStatus?.status === 'no_address') {
          throw new Error('SWIGGY_UNAVAILABLE: Cannot search Instamart on your current location.');
        }
        throw new Error('SWIGGY_UNAVAILABLE: Cannot search Instamart on your current location.');
      }

      const searchLat = delivery?.location?.latitude ?? lat;
      const searchLng = delivery?.location?.longitude ?? lng;

      // 1. Check cached store info for this location first
      const locKey = `${searchLat.toFixed(3)},${searchLng.toFixed(3)}`;
      let store: SwiggyStoreInfo | null = null;
      try {
        const rawCache = await AsyncStorage.getItem('@swiggy_store_cache');
        const parsedCache = rawCache ? JSON.parse(rawCache) : null;
        if (parsedCache && parsedCache.locKey === locKey && parsedCache.storeInfo?.storeId && Date.now() - parsedCache.at < 24 * 3600 * 1000) {
          store = parsedCache.storeInfo;
        }
      } catch {}

      // 2. Discover store from home/v2 if not cached
      if (!store || !store.storeId) {
        const homeUrl = `https://www.swiggy.com/api/instamart/home/v2?offset=0&storeId=&primaryStoreId=&secondaryStoreId=&clientId=INSTAMART-APP&lat=${searchLat.toFixed(6)}&lng=${searchLng.toFixed(6)}&overrideLocation=true`;
        let homeResponse = await this.swiggyApiFetch(homeUrl);
        if (!homeResponse.ok) {
          homeResponse = await this.fetchWithTimeout(homeUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'Cookie': token,
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
            }
          });
        }

        if (homeResponse.ok) {
          try {
            const homeJson = await homeResponse.json();
            if (homeJson) store = findStoreInfo(homeJson);
          } catch {}
        }
      }

      // 3. Fallback: check session cart for active store
      if (!store || !store.storeId) {
        try {
          const getCartRes = await this.swiggyApiFetch('https://www.swiggy.com/api/instamart/checkout/v2/cart?pageType=INSTAMART_CART');
          if (getCartRes && getCartRes.ok) {
            const cartJson = await getCartRes.json().catch(() => null);
            const sessionItems = cartJson?.data?.data?.items || [];
            const sId = sessionItems[0]?.storeId;
            if (sId) {
              store = { storeId: String(sId), primaryStoreId: String(sId), secondaryStoreId: '', layoutId: '' };
            }
          }
        } catch {}
      }

      // 4. Fallback: any previously cached store
      if (!store || !store.storeId) {
        try {
          const rawCache = await AsyncStorage.getItem('@swiggy_store_cache');
          const parsedCache = rawCache ? JSON.parse(rawCache) : null;
          if (parsedCache?.storeInfo?.storeId) {
            store = parsedCache.storeInfo;
          }
        } catch {}
      }

      // Save to cache if found
      if (store && store.storeId) {
        try {
          await AsyncStorage.setItem('@swiggy_store_cache', JSON.stringify({ locKey, at: Date.now(), storeInfo: store }));
        } catch {}
      }

      if (!store || !store.storeId) {
        throw new Error('No active Swiggy store ID discovered from your location');
      }

      const params = 'offset=0&ageConsent=false' +
        (store.layoutId ? '&layoutId=' + encodeURIComponent(store.layoutId) : '') +
        '&voiceSearchTrackingId=' +
        '&storeId=' + encodeURIComponent(store.storeId) +
        '&primaryStoreId=' + encodeURIComponent(store.primaryStoreId || store.storeId) +
        '&secondaryStoreId=' + encodeURIComponent(store.secondaryStoreId || store.storeId);

      const searchUrl = `https://www.swiggy.com/api/instamart/search/v2?${params}`;
      const searchBody = JSON.stringify({
        facets: [],
        sortAttribute: '',
        query: query,
        search_results_offset: '0',
        page_type: 'INSTAMART_PRE_SEARCH_PAGE',
        is_pre_search_tag: false
      });
      let searchResponse = await this.swiggyApiFetch(searchUrl, 'POST', searchBody);
      if (!searchResponse.ok) {
        searchResponse = await this.fetchWithTimeout(searchUrl, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Cookie': token,
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
          },
          body: searchBody
        });
      }

      if (!searchResponse.ok) {
        throw new Error(`Swiggy search/v2 API error: ${searchResponse.status}`);
      }

      let searchJson: any = null;
      try {
        searchJson = await searchResponse.json();
      } catch {
        const text = await searchResponse.text();
        searchJson = JSON.parse(text);
      }


      const parsed = extractSwiggySearchProducts(searchJson, query);

      return parsed.map((item: any) => ({
        id: `swiggy-${item.itemId || Math.random()}`,
        title: item.name,
        brand: 'Instamart',
        quantity: item.unit || '1 unit',
        price: item.price || 0,
        originalPrice: item.mrp || item.price,
        imageUrl: item.image || 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=200&q=80',
        platform: 'swiggy' as Platform,
        originalId: item.itemId,
        productId: item.productId || item.itemId,
        spinId: item.spinId,
        storeId: item.storeId,
        availableStock: item.availableStock,
        maxQuantity: item.maxQuantity,
      }));
    }

    return [];
  },

  /**
   * Calculate Comparative Cart Totals.
   * Both platforms are priced in parallel; onPlatformResult fires as soon as
   * each platform's bill is resolved so the UI can show partial results.
   */
  async calculateCart(
    items: { product: UnifiedProduct; quantity: number }[],
    onPlatformResult?: (calc: CartCalculation) => void,
    targetPlatform?: Platform
  ): Promise<CartCalculation[]> {
    const platforms: Platform[] = targetPlatform ? [targetPlatform] : ['blinkit', 'swiggy'];

    const simulateNoAddress = (await AsyncStorage.getItem('@blinkit_simulate_no_address')) === '1';

    // Load tokens and location in parallel
    const [blinkitToken, swiggyToken, storedLocation] = await Promise.all([
      storage.getToken('blinkit'),
      storage.getToken('swiggy'),
      storage.getLocation()
    ]);
    const gpsLat = storedLocation?.latitude;
    const gpsLng = storedLocation?.longitude;
    const gpsCoords = typeof gpsLat === 'number' && typeof gpsLng === 'number';

    const promises = platforms.map(async (platform) => {
      const platformItemLimits: Record<string, number> = {};
      const platformItemQuantities: Record<string, number> = {};

      // Filter and use only the items that exist on this platform — either
      // via an auto-matched variant (platformPrices) or by originating here.
      const platformItems = items
        .map((cartItem) => resolvePlatformProduct(cartItem, platform))
        .filter((ci): ci is { product: UnifiedProduct; quantity: number } => ci !== null);

      // The item subtotal starts from the search-API prices, capped by known item limits,
      // and gets overwritten by the live bill's itemTotal when the cart API responds.
      let subtotal = platformItems.filter(item => platform !== 'swiggy' || !isKnownUnavailable(item.product)).reduce((sum, item) => {
        const lim = getItemPlatformLimit(item.product);
        const q = (typeof lim === 'number' && lim > 0) ? Math.min(item.quantity, lim) : item.quantity;
        return sum + (item.product.price * q);
      }, 0);

      // No charge is ever estimated locally — every fee/tax below comes from
      // the platform's own cart/bill API. Until an API responds we only know
      // the item subtotal, so that is the baseline total.
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

      if (subtotal > 0) {
        try {
          if (platform === 'blinkit' && blinkitToken && gpsCoords) {
            const r = await priceBlinkitCart({
              items,
              platformItems,
              subtotal,
              token: blinkitToken,
              gpsLat,
              gpsLng,
              simulateNoAddress,
              platformItemLimits,
              platformItemQuantities,
            }, {
              getClosestBlinkitAddress: (la, ln) => this.getClosestBlinkitAddress(la, ln),
              fetchWithTimeout: (u, o, t) => this.fetchWithTimeout(u, o, t),
              parseBlinkitBill,
              getItemPlatformLimit,
              resolvePlatformProduct: (ci) => resolvePlatformProduct(ci, 'blinkit'),
            });
            ({ subtotal, deliveryFee, handlingFee, smallCartFee, surgeFee, surgeLabel, freeDeliveryGap, tax, total, liveBill } = r);
            outOfStockProductIds.push(...r.outOfStockProductIds);
            inStockProductIds.push(...r.inStockProductIds);
          } else if (platform === 'swiggy' && swiggyToken && gpsCoords) {
            // Same flow as the desktop grocery-order-optimizer extension:
            // Resolve delivery address first, discover the dark store matching the user's location,
            // resolve every basket item against Swiggy's own catalog, POST the basket to checkout/v2/cart,
            // then read every charge straight off the bill JSON.
            const CART_URL = 'https://www.swiggy.com/api/instamart/checkout/v2/cart';

            // Resolve delivery address based on GPS location
            const delivery = await this.resolveSwiggyDeliveryAddress(gpsLat, gpsLng);
            const targetLat = delivery?.location?.latitude ?? gpsLat;
            const targetLng = delivery?.location?.longitude ?? gpsLng;


            const HOME_URL = `https://www.swiggy.com/api/instamart/home/v2?offset=0&storeId=&primaryStoreId=&secondaryStoreId=&clientId=INSTAMART-APP&lat=${targetLat.toFixed(6)}&lng=${targetLng.toFixed(6)}&overrideLocation=true`;

            let shipmentIdV2 = '';
            let cartMetaData = {
              contactlessDelivery: false,
              deliveryType: 'INSTANT',
              ageConsentProvided: false,
              useGiftBagPackaging: false
            };
            let storeInfo: SwiggyStoreInfo | null = null;

            // Store/session metadata is stable per location — cache it so discovery can be skipped on later runs.
            const locKey = `${targetLat.toFixed(3)},${targetLng.toFixed(3)}`;
            const saveStoreCache = async () => {
              if (!storeInfo) return;
              try {
                await AsyncStorage.setItem('@swiggy_store_cache', JSON.stringify({ locKey, at: Date.now(), storeInfo, cartMetaData }));
              } catch {}
            };
            try {
              const rawCache = await AsyncStorage.getItem('@swiggy_store_cache');
              const parsedCache = rawCache ? JSON.parse(rawCache) : null;
              if (parsedCache && parsedCache.locKey === locKey && parsedCache.storeInfo && Date.now() - parsedCache.at < 24 * 3600 * 1000) {
                storeInfo = parsedCache.storeInfo;
                cartMetaData = { ...cartMetaData, ...(parsedCache.cartMetaData || {}) };
              }
            } catch {}

            // Primary discovery: discover store from HOME_URL for the target location
            if (!storeInfo) {
              try {
                const homeResponse = await this.swiggyApiFetch(HOME_URL);
                if (homeResponse.ok) {
                  storeInfo = findStoreInfo(await homeResponse.json());
                }
              } catch (e) {
                console.warn('[Swiggy API Checkout] home/v2 discovery failed:', e);
              }
            }

            // Fallback: discover from session cart if HOME_URL failed
            if (!storeInfo) {
              try {
                const getCartRes = await this.swiggyApiFetch(`${CART_URL}?pageType=INSTAMART_CART`);
                if (getCartRes.ok) {
                  const getCartJson = await getCartRes.json();
                  const cart = getCartJson?.data?.data;
                  if (cart) {
                    const metaValues = cart.metadata?.values || {};
                    const sessionItems = cart.items || [];
                    shipmentIdV2 = (sessionItems[0]?.shipmentIdV2 || sessionItems[0]?.shipmentId) || '';
                    cartMetaData = {
                      contactlessDelivery: !!metaValues.contactless_delivery,
                      deliveryType: cart.deliveryType || 'INSTANT',
                      ageConsentProvided: !!metaValues.age_consent_provided,
                      useGiftBagPackaging: !!metaValues.use_gift_bag_packaging
                    };
                    const sessionStoreId = sessionItems[0]?.storeId;
                    if (sessionStoreId) {
                      storeInfo = {
                        storeId: String(sessionStoreId),
                        primaryStoreId: String(sessionStoreId),
                        secondaryStoreId: '',
                        layoutId: ''
                      };
                    }
                  }
                }
              } catch (e) {
                console.warn('[Swiggy API Checkout] GET cart failed:', e);
              }
            }

            await saveStoreCache();

            const resolvedStoreId = storeInfo?.storeId || storeInfo?.primaryStoreId || null;
            if (resolvedStoreId) {

              const buildBody = (productId: any, itemId: any, spinId: any, qty: number) => ({
                productId: productId || itemId,
                quantity: Math.max(1, Math.round(Number(qty) || 1)),
                tradeFreebie: false,
                spin: spinId || '',
                itemId: itemId || productId,
                meta: { type: 'structure', storeId: resolvedStoreId, freebie: false, isGiftBag: false },
                serviceLine: 'INSTAMART',
                ...(shipmentIdV2 ? { shipmentIdV2 } : {})
              });

              // FAST PATH: reuse the catalog IDs captured during auto-match
              const billableItems = platformItems.filter(ci => !isKnownUnavailable(ci.product));
              let usedFastPath = billableItems.length > 0;
              let bodies: any[] = [];
              for (const ci of billableItems) {
                const src: any = ci.product.platformPrices?.swiggy || (ci.product.platform === 'swiggy' ? ci.product : null);
                const pid = src?.productId || src?.originalId || src?.itemId;
                const iid = src?.originalId || src?.itemId || src?.productId;
                if (!src || !pid || !iid) { usedFastPath = false; break; }
                const lim = getItemPlatformLimit(src);
                const q = (typeof lim === 'number' && lim > 0) ? Math.min(ci.quantity, lim) : ci.quantity;
                bodies.push(buildBody(pid, iid, src.spinId, q));
              }
              if (!usedFastPath) bodies = [];

              // Fallback builder: fresh search/v2 per item (concurrent pool).
              const freshSearchBodies = async (): Promise<{ bodies: any[]; oosItemIds: string[]; candidateMap: Map<string, any> }> => {
                const searchItem = async (title: string, quantity: string, price?: number, preferId?: string): Promise<any> => {
                  try {
                    const queriesToTry = [title];
                    const stripped = stripSizeToken(title);
                    if (stripped && stripped !== title) {
                      queriesToTry.push(stripped);
                    }
                    const cleanParens = title.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
                    if (cleanParens && !queriesToTry.includes(cleanParens)) {
                      queriesToTry.push(cleanParens);
                    }
                    const words = title.split(/[^a-zA-Z0-9]+/).filter(w => w.length > 2);
                    if (words.length > 3) {
                      const shortQuery = words.slice(0, 3).join(' ');
                      if (!queriesToTry.includes(shortQuery)) queriesToTry.push(shortQuery);
                    }

                    for (const q of queriesToTry) {
                      const candidates = await this.searchSingle('swiggy', q);
                      if (Array.isArray(candidates) && candidates.length > 0) {
                        const matched = pickInstamartCandidate(candidates, title, quantity, price, preferId);
                        if (matched) {
                          const pid = matched.productId || matched.originalId || matched.itemId;
                          const iid = matched.originalId || matched.itemId || matched.productId;
                          if (pid && iid) {
                            return {
                              productId: String(pid),
                              itemId: String(iid),
                              spinId: matched.spinId || '',
                              price: matched.price,
                              unit: matched.quantity || matched.unit,
                              availableStock: matched.availableStock,
                              maxQuantity: matched.maxQuantity,
                            };
                          }
                        }
                      }
                    }
                  } catch (e) {
                    console.warn(`[Swiggy API Checkout] search error for "${title}":`, e);
                  }
                  return null;
                };

                const SEARCH_POOL = 5;
                const searchResults: any[] = new Array(items.length).fill(null);
                for (let start = 0; start < items.length; start += SEARCH_POOL) {
                  const slice = items.slice(start, start + SEARCH_POOL);
                  const settled = await Promise.all(slice.map(cartItem => {
                    const resolved = resolvePlatformProduct(cartItem, 'swiggy');
                    if (!resolved || isKnownUnavailable(resolved.product)) return Promise.resolve(null);
                    return searchItem(resolved.product.title, resolved.product.quantity, resolved.product.price, resolved.product.productId || resolved.product.originalId);
                  }));
                  settled.forEach((r, i) => { searchResults[start + i] = r; });
                }

                const outBodies: any[] = [];
                const oosItemIds: string[] = [];
                const candidateMap = new Map<string, any>();

                items.forEach((cartItem, i) => {
                  const resolved = resolvePlatformProduct(cartItem, 'swiggy');
                  if (!resolved || isKnownUnavailable(resolved.product)) {
                    oosItemIds.push(cartItem.product.id);
                    return;
                  }
                  const cand = searchResults[i];
                  const pid = cand?.productId || cand?.itemId;
                  const iid = cand?.itemId || cand?.productId;
                  if (!cand || !pid || !iid) {
                    oosItemIds.push(cartItem.product.id);
                    return;
                  }
                  candidateMap.set(cartItem.product.id, cand);
                  const lim = getItemPlatformLimit(cand) ?? getItemPlatformLimit(resolved.product);
                  const q = (typeof lim === 'number' && lim > 0) ? Math.min(cartItem.quantity, lim) : cartItem.quantity;
                  outBodies.push(buildBody(pid, iid, cand.spinId, q));
                });

                return { bodies: outBodies, oosItemIds, candidateMap };
              };

              let freshOosItemIds: string[] = [];
              let freshCandidateMap = new Map<string, any>();
              if (bodies.length === 0 && billableItems.length > 0) {
                const fresh = await freshSearchBodies();
                freshOosItemIds = fresh.oosItemIds;
                freshCandidateMap = fresh.candidateMap;
                bodies = fresh.bodies;
              }

              if (bodies.length > 0) {
                const delivery = await this.resolveSwiggyDeliveryAddress(gpsLat, gpsLng);
                const postBasket = async (storeIds: string[], deliveryFor?: { id: string | null; location?: { latitude: number; longitude: number } | null } | null) => this.swiggyApiFetch(CART_URL, 'POST', JSON.stringify({
                  data: {
                    items: bodies,
                    cartMetaData: {
                      contactlessDelivery: cartMetaData.contactlessDelivery,
                      deliveryType: cartMetaData.deliveryType,
                      owner: 'APP',
                      preferredAddressId: deliveryFor?.id ?? null,
                      ageConsentProvided: cartMetaData.ageConsentProvided,
                      useGiftBagPackaging: cartMetaData.useGiftBagPackaging,
                      useReusablePackaging: false,
                      incognitoCart: false,
                      includeConsents: ['PHARMA'],
                      primaryStoreId: resolvedStoreId,
                      storeIds
                    },
                    cartType: 'INSTAMART',
                    ...(deliveryFor?.id ? { addressId: deliveryFor.id } : {}),
                    ...(deliveryFor?.location ? { location: deliveryFor.location } : {})
                  },
                  source: 'userInitiated'
                }));

                const extractSwiggyCartItems = (root: any): any[] => {
                  if (!root) return [];
                  const cd = root?.data?.data || root?.data || root;
                  if (Array.isArray(cd.items)) return cd.items;
                  if (Array.isArray(cd.cart_items)) return cd.cart_items;
                  if (Array.isArray(cd.cartItems)) return cd.cartItems;
                  if (Array.isArray(cd.cart?.items)) return cd.cart.items;
                  if (Array.isArray(cd.sellerCarts)) {
                    const all = cd.sellerCarts.flatMap((sc: any) => sc?.items || []);
                    if (all.length > 0) return all;
                  }
                  if (Array.isArray(cd.storeCarts)) {
                    const all = cd.storeCarts.flatMap((sc: any) => sc?.items || []);
                    if (all.length > 0) return all;
                  }
                  if (Array.isArray(root?.items)) return root.items;
                  return [];
                };

                let postCartRes = await postBasket([resolvedStoreId], delivery);
                if (!postCartRes.ok) {
                  const rejText = (await postCartRes.text().catch(() => '')).slice(0, 800);
                  console.warn(`[Swiggy API Checkout] POST rejected (${postCartRes.status}): ${rejText}`);

                  let rejJson: any = null;
                  try { rejJson = JSON.parse(rejText); } catch {}

                  const stockInRej = extractStockCount(rejJson?.statusMessage) ??
                    extractStockCount(rejJson?.message) ??
                    extractStockCount(rejJson?.data?.message) ??
                    extractStockCount(rejJson?.data?.statusMessage) ??
                    extractStockCount(rejJson?.error) ??
                    extractStockCount(rejText);

                  if (stockInRej !== undefined && stockInRej > 0) {
                    for (const b of bodies) {
                      b.quantity = Math.min(b.quantity, stockInRej);
                      if (b.itemId) platformItemLimits[String(b.itemId)] = stockInRej;
                      if (b.productId) platformItemLimits[String(b.productId)] = stockInRej;
                    }
                    postCartRes = await postBasket([resolvedStoreId], delivery);
                  } else {
                    postCartRes = await postBasket([resolvedStoreId, resolvedStoreId], delivery);
                  }
                }

                let postCartJson = postCartRes && postCartRes.ok ? await postCartRes.json().catch(() => null) : null;
                let bill = findSwiggyBillNode(postCartJson);
                let cartData = postCartJson?.data?.data || postCartJson?.data;
                let sItems = extractSwiggyCartItems(postCartJson);

                if ((!bill || sItems.length === 0) && postCartRes && postCartRes.ok) {
                  try {
                    const refetchRes = await this.swiggyApiFetch(`${CART_URL}?pageType=INSTAMART_CART`);
                    if (refetchRes.ok) {
                      const refetchJson = await refetchRes.json().catch(() => null);
                      if (!bill) bill = findSwiggyBillNode(refetchJson);
                      cartData = refetchJson?.data?.data || refetchJson?.data || cartData;
                      sItems = extractSwiggyCartItems(refetchJson);
                    }
                  } catch (e) {
                    console.warn('[Swiggy API Checkout] cart refetch failed:', e);
                  }
                }

                const sentPids = new Set<string>();
                for (const b of bodies) {
                  if (b.productId) sentPids.add(String(b.productId));
                  if (b.itemId) sentPids.add(String(b.itemId));
                }

                const sOosArraysInitial = [
                  cartData?.unavailableItems,
                  cartData?.outOfStockItems,
                  cartData?.unserviceableItems,
                  cartData?.itemsUnavailable,
                  postCartJson?.unavailableItems,
                  postCartJson?.outOfStockItems,
                  postCartJson?.data?.unavailableItems,
                  postCartJson?.data?.data?.unavailableItems
                ];
                const ourItemUnavailable = sOosArraysInitial.some(arr =>
                  Array.isArray(arr) && arr.some(it => {
                    const itPids = [it?.productId, it?.itemId, it?.skuId, it?.id, it?.item_id, it?.product_id].filter(Boolean).map(String);
                    return itPids.some(p => sentPids.has(p));
                  })
                );

                const fastPathNeedsRetry = usedFastPath && (
                  !postCartRes?.ok ||
                  !bill ||
                  ourItemUnavailable
                );

                if (fastPathNeedsRetry) {
                  console.warn('[Swiggy API Checkout] cached IDs rejected or dropped items — rebuilding basket via fresh search');
                  const freshRetry = await freshSearchBodies();
                  freshOosItemIds = freshRetry.oosItemIds;
                  freshCandidateMap = freshRetry.candidateMap;
                  bodies = freshRetry.bodies;
                  usedFastPath = false;
                  if (bodies.length > 0) {
                    postCartRes = await postBasket([resolvedStoreId], delivery);
                    if (!postCartRes.ok) {
                      postCartRes = await postBasket([resolvedStoreId, resolvedStoreId], delivery);
                    }
                    if (postCartRes && postCartRes.ok) {
                      postCartJson = await postCartRes.json().catch(() => null);
                      bill = findSwiggyBillNode(postCartJson);
                      cartData = postCartJson?.data?.data || postCartJson?.data;
                      sItems = extractSwiggyCartItems(postCartJson);
                      if (!bill || sItems.length === 0) {
                        try {
                          const refetchRes = await this.swiggyApiFetch(`${CART_URL}?pageType=INSTAMART_CART`);
                          if (refetchRes.ok) {
                            const refetchJson = await refetchRes.json().catch(() => null);
                            if (!bill) bill = findSwiggyBillNode(refetchJson);
                            cartData = refetchJson?.data?.data || refetchJson?.data || cartData;
                            sItems = extractSwiggyCartItems(refetchJson);
                          }
                        } catch {}
                      }
                    }
                  }
                }

                if (postCartRes && postCartRes.ok) {
                  const billedAddrId = postCartJson?.data?.data?.addressId
                    ?? postCartJson?.data?.data?.address?.id
                    ?? postCartJson?.data?.data?.shippingAddressId
                    ?? null;
                  if (billedAddrId && delivery?.id && String(billedAddrId) !== String(delivery.id)) {
                    console.warn(`[Swiggy Address] MISMATCH: bill priced for address "${billedAddrId}" but we sent "${delivery.id}"`);
                  }

                  const applySwiggyFees = (b: any) => {
                    const fees = parseSwiggyBill(b);
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
                  };

                  if (bill) {
                    applySwiggyFees(bill);
                  }

                  if (liveBill && (!subtotal || subtotal === 0)) {
                    const numFn = (v: any) => {
                      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
                      return isFinite(n) ? Math.round(n) : null;
                    };
                    const cdSub = numFn(cartData?.itemTotal) ?? numFn(cartData?.itemsTotal) ?? numFn(cartData?.subTotal) ?? numFn(cartData?.cartSubTotal) ?? numFn(cartData?.cartTotal);
                    if (cdSub !== null && cdSub > 0) {
                      subtotal = cdSub;
                    } else if (Array.isArray(sItems) && sItems.length > 0) {
                      let itemSum = 0;
                      for (const it of sItems) {
                        const p = Number(it.finalPrice ?? it.price ?? 0);
                        const q = Number(it.quantity ?? 1);
                        if (p > 0 && q > 0) itemSum += p * q;
                      }
                      if (itemSum > 0) subtotal = Math.round(itemSum);
                    }
                  }

                  // Extract Swiggy in-stock and out-of-stock items
                  const returnedActiveSwiggyPids = new Set<string>();
                  const returnedActiveSwiggyNames = new Set<string>();
                  const returnedOosSwiggyPids = new Set<string>();
                  const returnedOosSwiggyNames = new Set<string>();

                  const getSwiggyPids = (it: any): string[] => {
                    const ids: string[] = [];
                    if (it?.productId) ids.push(String(it.productId));
                    if (it?.itemId) ids.push(String(it.itemId));
                    if (it?.skuId) ids.push(String(it.skuId));
                    if (it?.id) ids.push(String(it.id));
                    if (it?.item_id) ids.push(String(it.item_id));
                    if (it?.product_id) ids.push(String(it.product_id));
                    if (it?.spinId) ids.push(String(it.spinId));
                    if (it?.spin) ids.push(String(it.spin));
                    if (it?.item?.productId) ids.push(String(it.item.productId));
                    if (it?.item?.itemId) ids.push(String(it.item.itemId));
                    if (it?.item?.id) ids.push(String(it.item.id));
                    if (it?.item?.skuId) ids.push(String(it.item.skuId));
                    if (it?.product?.id) ids.push(String(it.product.id));
                    if (it?.product?.productId) ids.push(String(it.product.productId));
                    return ids.filter(Boolean);
                  };

                  const getSwiggyNormName = (it: any): string => {
                    const name = it?.name || it?.displayName || it?.title || it?.item?.name || it?.item?.displayName || '';
                    return instamartNormKey(name);
                  };

                  if (Array.isArray(sItems)) {
                    for (const it of sItems) {
                      const isOos = it.inStock === false ||
                                    it.isAvailable === false ||
                                    it.outOfStock === true ||
                                    it.isOOS === true ||
                                    it.status === 'OUT_OF_STOCK' ||
                                    it.status === 'OOS' ||
                                    (typeof it.quantity === 'number' && it.quantity <= 0) ||
                                    (it.inventory?.inStock === false) ||
                                    (typeof it.inventory?.totalStock === 'number' && it.inventory.totalStock <= 0) ||
                                    (typeof it.inventory?.total_stock === 'number' && it.inventory.total_stock <= 0) ||
                                    (typeof it.inventory?.remaining_stock === 'number' && it.inventory.remaining_stock <= 0) ||
                                    (typeof it.inventory?.available_stock === 'number' && it.inventory.available_stock <= 0) ||
                                    (typeof it.inventory?.available_quantity === 'number' && it.inventory.available_quantity <= 0);
                      const pids = getSwiggyPids(it);
                      const normName = getSwiggyNormName(it);

                      let billedQty: number | undefined = undefined;
                      if (typeof it.quantity === 'number' && it.quantity > 0) billedQty = it.quantity;

                      const { availableStock: stockNum, maxQuantity: maxQ } = extractSwiggyStockAndLimit(it);

                      const matchingBody = bodies.find(b => pids.includes(String(b.itemId)) || pids.includes(String(b.productId)));
                      const reqQty = matchingBody?.quantity;

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

                      if (isOos) {
                        pids.forEach(p => {
                          returnedOosSwiggyPids.add(p);
                          platformItemLimits[p] = 0;
                        });
                        if (normName) returnedOosSwiggyNames.add(normName);
                      } else {
                        pids.forEach(p => {
                          returnedActiveSwiggyPids.add(p);
                          if (billedQty !== undefined) platformItemQuantities[p] = billedQty;
                          if (effLimit !== undefined) platformItemLimits[p] = effLimit;
                        });
                        if (normName) returnedActiveSwiggyNames.add(normName);
                      }
                    }
                  }

                  // Also inspect cart messages / warnings / notifications for stock limit text
                  const allMessages = [
                    ...(Array.isArray(cartData?.warnings) ? cartData.warnings : []),
                    ...(Array.isArray(cartData?.messages) ? cartData.messages : []),
                    ...(Array.isArray(cartData?.cartMessages) ? cartData.cartMessages : []),
                    ...(Array.isArray(cartData?.itemMessages) ? cartData.itemMessages : []),
                    ...(Array.isArray(postCartJson?.warnings) ? postCartJson.warnings : []),
                    ...(Array.isArray(postCartJson?.messages) ? postCartJson.messages : []),
                    ...(Array.isArray(postCartJson?.data?.warnings) ? postCartJson.data.warnings : []),
                    ...(Array.isArray(postCartJson?.data?.messages) ? postCartJson.data.messages : []),
                  ];
                  for (const m of allMessages) {
                    const stockInMsg = extractStockCount(m);
                    if (stockInMsg !== undefined && stockInMsg > 0) {
                      const msgPids = getSwiggyPids(m);
                      if (msgPids.length > 0) {
                        msgPids.forEach(p => { platformItemLimits[p] = stockInMsg; });
                      } else if (items.length === 1) {
                        platformItemLimits[items[0].product.id] = stockInMsg;
                      }
                    }
                  }

                  const sOosArrays = [
                    cartData?.unavailableItems,
                    cartData?.outOfStockItems,
                    cartData?.unserviceableItems,
                    cartData?.itemsUnavailable,
                    postCartJson?.unavailableItems,
                    postCartJson?.outOfStockItems,
                    postCartJson?.data?.unavailableItems,
                    postCartJson?.data?.data?.unavailableItems
                  ];
                  for (const arr of sOosArrays) {
                    if (Array.isArray(arr)) {
                      for (const it of arr) {
                        getSwiggyPids(it).forEach(p => {
                          returnedOosSwiggyPids.add(p);
                          platformItemLimits[p] = 0;
                        });
                        const normName = getSwiggyNormName(it);
                        if (normName) returnedOosSwiggyNames.add(normName);
                      }
                    }
                  }

                  for (const cartItem of items) {
                    const resolved = resolvePlatformProduct(cartItem, 'swiggy');
                    if (!resolved || freshOosItemIds.includes(cartItem.product.id) || isKnownUnavailable(resolved.product)) {
                      outOfStockProductIds.push(cartItem.product.id);
                      platformItemLimits[cartItem.product.id] = 0;
                      continue;
                    }
                    const src: any = resolved.product;
                    const freshCand = freshCandidateMap.get(cartItem.product.id);
                    const pidsToCheck = [
                      String(src.productId || ''),
                      String(src.originalId || ''),
                      String(src.id || '').replace(/^swiggy-/, ''),
                      String(src.spinId || ''),
                      ...(freshCand ? [String(freshCand.productId || ''), String(freshCand.itemId || ''), String(freshCand.spinId || '')] : [])
                    ].filter(Boolean);

                    const itemNormTitle = instamartNormKey(src.title || cartItem.product.title);

                    const isExplicitActive = pidsToCheck.some(id => returnedActiveSwiggyPids.has(id)) ||
                      (itemNormTitle && (
                        returnedActiveSwiggyNames.has(itemNormTitle) ||
                        Array.from(returnedActiveSwiggyNames).some(an => an.includes(itemNormTitle) || itemNormTitle.includes(an))
                      ));

                    const isExplicitOos = pidsToCheck.some(id => returnedOosSwiggyPids.has(id)) ||
                      (!isExplicitActive && itemNormTitle && returnedOosSwiggyNames.has(itemNormTitle));

                    let foundLimit: number | undefined = undefined;
                    let foundQty: number | undefined = undefined;
                    for (const p of pidsToCheck) {
                      if (platformItemLimits[p] !== undefined) { foundLimit = platformItemLimits[p]; break; }
                    }
                    for (const p of pidsToCheck) {
                      if (platformItemQuantities[p] !== undefined) { foundQty = platformItemQuantities[p]; break; }
                    }

                    if (isExplicitActive) {
                      inStockProductIds.push(cartItem.product.id);
                      const lim = foundLimit ?? getItemPlatformLimit(resolved.product);
                      if (lim !== undefined) platformItemLimits[cartItem.product.id] = lim;
                      if (foundQty !== undefined) platformItemQuantities[cartItem.product.id] = foundQty;
                    } else if (isExplicitOos) {
                      outOfStockProductIds.push(cartItem.product.id);
                      platformItemLimits[cartItem.product.id] = 0;
                    } else if (liveBill && subtotal > 0 && items.length === 1) {
                      // Single item in basket and live bill has subtotal > 0 -> definitely in stock!
                      inStockProductIds.push(cartItem.product.id);
                      const lim = getItemPlatformLimit(resolved.product);
                      if (lim !== undefined) platformItemLimits[cartItem.product.id] = lim;
                    } else if (liveBill && sItems.length > 0 && returnedOosSwiggyPids.size > 0 && !isExplicitActive) {
                      // Explicit OOS items reported by Swiggy, and this item was not found active
                      outOfStockProductIds.push(cartItem.product.id);
                      platformItemLimits[cartItem.product.id] = 0;
                    } else if (resolved.product.inStock === false) {
                      outOfStockProductIds.push(cartItem.product.id);
                      platformItemLimits[cartItem.product.id] = 0;
                    } else if (liveBill && subtotal > 0) {
                      // Cart is live and bill priced with no explicit OOS indication
                      inStockProductIds.push(cartItem.product.id);
                      const lim = getItemPlatformLimit(resolved.product);
                      if (lim !== undefined) platformItemLimits[cartItem.product.id] = lim;
                    } else {
                      outOfStockProductIds.push(cartItem.product.id);
                      platformItemLimits[cartItem.product.id] = 0;
                    }
                  }
                }
              }
            } else {
              console.warn('[Swiggy API Checkout] could not discover an Instamart store id — bill not priced');
            }
          }
        } catch (e) {
          console.warn(`[calculateCart] error fetching live API bill details for ${platform}:`, e);
        }
      }

      // Ensure every basket item is classified as in-stock or out-of-stock
      for (const cartItem of items) {
        if (!inStockProductIds.includes(cartItem.product.id) && !outOfStockProductIds.includes(cartItem.product.id)) {
          const resolved = resolvePlatformProduct(cartItem, platform);
          if (!resolved || resolved.product.inStock === false || (platform === 'swiggy' && isKnownUnavailable(resolved.product))) {
            outOfStockProductIds.push(cartItem.product.id);
          } else {
            inStockProductIds.push(cartItem.product.id);
          }
        }
      }

      // Map in-stock items from the user's cart to this platform's resolved products
      const inStockPlatformItems: { product: UnifiedProduct; quantity: number }[] = [];
      for (const cartItem of items) {
        const resolved = resolvePlatformProduct(cartItem, platform);
        if (resolved && inStockProductIds.includes(cartItem.product.id)) {
          inStockPlatformItems.push(resolved);
        }
      }

      // Fallback: if inStockPlatformItems is empty but platformItems has items and they aren't explicitly marked OOS
      if (inStockPlatformItems.length === 0 && platformItems.length > 0) {
        for (const cartItem of items) {
          const resolved = resolvePlatformProduct(cartItem, platform);
          if (resolved && !outOfStockProductIds.includes(cartItem.product.id)) {
            inStockPlatformItems.push(resolved);
            if (!inStockProductIds.includes(cartItem.product.id)) {
              inStockProductIds.push(cartItem.product.id);
            }
          }
        }
      }

      const activeItemsForCalc = inStockPlatformItems.length > 0 ? inStockPlatformItems : platformItems;
      const inStockOriginalSubtotal = activeItemsForCalc.reduce((sum, item) => sum + ((item.product.originalPrice || item.product.price) * item.quantity), 0);
      const savings = inStockOriginalSubtotal - subtotal;

      const calc: CartCalculation = {
        platform,
        items: inStockPlatformItems,
        subtotal,
        deliveryFee,
        handlingFee,
        smallCartFee,
        surgeFee,
        surgeLabel,
        freeDeliveryGap: liveBill && deliveryFee > 0 ? freeDeliveryGap : undefined,
        tax,
        total,
        savings: savings > 0 ? savings : 0,
        live: liveBill,
        outOfStockProductIds,
        inStockProductIds,
        platformItemLimits,
        platformItemQuantities,
      };

      onPlatformResult?.(calc);
      return calc;
    });

    const results = await Promise.all(promises);
    return results;
  }
};

// ==========================================
// --- Production Direct API Helper Parsers ---
// ==========================================

// --- Swiggy Helpers ---
export interface SwiggyStoreInfo {
  storeId: string;
  primaryStoreId: string;
  secondaryStoreId: string;
  layoutId: string;
}

export function findStoreInfo(json: any): SwiggyStoreInfo {
  const info: SwiggyStoreInfo = { storeId: '', primaryStoreId: '', secondaryStoreId: '', layoutId: '' };
  if (!json || typeof json !== 'object') return info;
  function setIf(attr: keyof SwiggyStoreInfo, v: any) {
    if (!info[attr] && v !== '' && v !== null && v !== undefined) info[attr] = String(v);
  }
  const visited = new Set<any>();
  function walk(node: any) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = node[k];
      if (typeof v === 'number' || typeof v === 'string') {
        if (k === 'storeId') setIf('storeId', v);
        if (k === 'podId') setIf('storeId', v);
        if (k === 'primaryStoreId') setIf('primaryStoreId', v);
        if (k === 'secondaryStoreId') setIf('secondaryStoreId', v);
        if (k === 'layoutId') setIf('layoutId', v);
      }
      if (v && typeof v === 'object') walk(v);
    }
  }
  walk(json);
  return info;
}

function moneyUnits(priceObj: any): number | null {
  if (!priceObj || typeof priceObj !== 'object') return null;
  const cands = ['offerPrice', 'salePrice', 'mrp'];
  for (let i = 0; i < cands.length; i++) {
    const c = priceObj[cands[i]];
    if (c && typeof c === 'object') {
      const n = asNum(c.units);
      if (n !== null && n > 0) return n;
    }
  }
  const direct = asNum(priceObj.units);
  return (direct !== null && direct > 0) ? direct : null;
}

function asNum(v: any): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = String(v).match(/^\s*(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d+)?)/i);
    if (m) return Number(m[1].replace(/,/g, ''));
  }
  return null;
}

function imageUrlFrom(id: any): string | null {
  if (!id) return null;
  id = String(id);
  if (/\.(mp4|webm|mov|avi)(\?|$)/i.test(id)) return null;
  let url: string;
  if (/^https?:/i.test(id)) {
    url = id;
  } else {
    url = 'https://instamart-media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_288,h_360/' + id;
  }
  if (suspiciousImageUrl(url)) return null;
  return url;
}

function suspiciousImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (/\/ciw\/\d+$/i.test(url)) return true;
  if (url.indexOf('rc-upload') !== -1) return true;
  return false;
}

function deepSwiggyImage(obj: any, depth: number): string {
  if (!obj || depth < 0) return '';
  if (typeof obj === 'string') {
    if (/\.(mp4|webm|mov|avi)(\?|$)/i.test(obj) || /\/videos\//i.test(obj)) return '';
    return /(?:instamart-media-assets|\.swiggy\.com)|^NI_CATALOG\//i.test(obj) ? obj : '';
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const fromArray = deepSwiggyImage(obj[i], depth - 1);
      if (fromArray) return fromArray;
    }
    return '';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    for (let j = 0; j < keys.length; j++) {
      const fromKey = deepSwiggyImage(obj[keys[j]], depth - 1);
      if (fromKey) return fromKey;
    }
  }
  return '';
}

function variationImage(product: any, v: any): string | null {
  function isVideo(str: any): boolean {
    if (!str || typeof str !== 'string') return false;
    return /\.(mp4|webm|mov|avi)(\?|$)/i.test(str) || /\/videos\//i.test(str);
  }

  function mediaRef(value: any, depth: number): string {
    if (!value || depth < 0) return '';
    if (typeof value === 'string') return isVideo(value) ? '' : value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const fromArray = mediaRef(value[i], depth - 1);
        if (fromArray) return fromArray;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    const preferred = ['imageId', 'image_id', 'imageUrl', 'image_url', 'mediaId', 'media_id', 'mediaUrl', 'media_url', 'assetId', 'asset_id', 'assetUrl', 'asset_url', 'thumbnail', 'thumbnailId', 'thumbnailUrl', 'thumbUrl', 'photoId', 'photo_id', 'url', 'src', 'id'];
    for (let p = 0; p < preferred.length; p++) {
      const candidate = value[preferred[p]];
      if (typeof candidate === 'string' && candidate && !isVideo(candidate)) return candidate;
    }
    const nested = ['image', 'images', 'media', 'medias', 'imageIds', 'imageUrls', 'mediaUrls', 'assets', 'thumbnails'];
    for (let n = 0; n < nested.length; n++) {
      const fromNested = mediaRef(value[nested[n]], depth - 1);
      if (fromNested && !isVideo(fromNested)) return fromNested;
    }
    return '';
  }
  const img = mediaRef(v.imageId, 1) || mediaRef(v.image, 2) || mediaRef(v.media, 2) ||
    mediaRef(v.medias, 2) || mediaRef(v.imageIds, 2) || mediaRef(v.assets, 2) ||
    mediaRef(v.imageUrls, 2) || mediaRef(v.imageUrl, 1) || mediaRef(v.thumbnail, 1) ||
    mediaRef(product.imageId, 1) || mediaRef(product.image, 2) || mediaRef(product.media, 2) ||
    mediaRef(product.medias, 2) || mediaRef(product.imageIds, 2) || mediaRef(product.assets, 2) ||
    mediaRef(product.imageUrls, 2) || mediaRef(product.imageUrl, 1) || mediaRef(product.thumbnail, 1);
  const finalImg = img || deepSwiggyImage(v, 6) || deepSwiggyImage(product, 6);
  return imageUrlFrom(finalImg);
}

function isSwiggyInStock(product: any, v: any): boolean {
  if (!v || typeof v !== 'object') return false;

  // 1. Explicit booleans
  if (v.inStock === false || v.in_stock === false) return false;
  if (product && (product.inStock === false || product.in_stock === false)) return false;
  if (v.isAvail === false || v.isAvailable === false || v.available === false) return false;
  if (product && (product.isAvail === false || product.isAvailable === false || product.available === false)) return false;
  if (v.outOfStock === true || v.out_of_stock === true || v.isOOS === true) return false;
  if (product && (product.outOfStock === true || product.out_of_stock === true || product.isOOS === true)) return false;

  // Cart allowed quantity <= 0 means item cannot be ordered
  if (typeof v.cartAllowedQuantity?.allowedQuantity === 'number' && v.cartAllowedQuantity.allowedQuantity <= 0) return false;
  if (typeof v.cart_allowed_quantity?.allowed_quantity === 'number' && v.cart_allowed_quantity.allowed_quantity <= 0) return false;
  if (product && typeof product.cartAllowedQuantity?.allowedQuantity === 'number' && product.cartAllowedQuantity.allowedQuantity <= 0) return false;
  if (product && typeof product.cart_allowed_quantity?.allowed_quantity === 'number' && product.cart_allowed_quantity.allowed_quantity <= 0) return false;

  // 2. Inventory object on variation
  if (v.inventory && typeof v.inventory === 'object') {
    if (v.inventory.inStock === false || v.inventory.in_stock === false || v.inventory.isAvailable === false) return false;
    if (typeof v.inventory.totalStock === 'number' && v.inventory.totalStock <= 0) return false;
    if (typeof v.inventory.quantity === 'number' && v.inventory.quantity <= 0) return false;
    if (typeof v.inventory.remainingStock === 'number' && v.inventory.remainingStock <= 0) return false;
    if (typeof v.inventory.remaining_stock === 'number' && v.inventory.remaining_stock <= 0) return false;
    if (typeof v.inventory.total_stock === 'number' && v.inventory.total_stock <= 0) return false;
    if (typeof v.inventory.available_stock === 'number' && v.inventory.available_stock <= 0) return false;
    if (typeof v.inventory.available_quantity === 'number' && v.inventory.available_quantity <= 0) return false;
    if (typeof v.inventory.stock === 'number' && v.inventory.stock <= 0) return false;
    const invStatus = String(v.inventory.status || '').toUpperCase();
    if (invStatus === 'OUT_OF_STOCK' || invStatus === 'OOS' || invStatus === 'SOLD_OUT') return false;
  }
  if (typeof v.inventory === 'number' && v.inventory <= 0) return false;

  // 3. Inventory object on parent product
  if (product && product.inventory && typeof product.inventory === 'object') {
    if (product.inventory.inStock === false || product.inventory.in_stock === false || product.inventory.isAvailable === false) return false;
    if (typeof product.inventory.totalStock === 'number' && product.inventory.totalStock <= 0) return false;
    if (typeof product.inventory.total_stock === 'number' && product.inventory.total_stock <= 0) return false;
    if (typeof product.inventory.quantity === 'number' && product.inventory.quantity <= 0) return false;
    if (typeof product.inventory.remainingStock === 'number' && product.inventory.remainingStock <= 0) return false;
    if (typeof product.inventory.remaining_stock === 'number' && product.inventory.remaining_stock <= 0) return false;
    if (typeof product.inventory.available_stock === 'number' && product.inventory.available_stock <= 0) return false;
    if (typeof product.inventory.available_quantity === 'number' && product.inventory.available_quantity <= 0) return false;
    const pInvStatus = String(product.inventory.status || '').toUpperCase();
    if (pInvStatus === 'OUT_OF_STOCK' || pInvStatus === 'OOS' || pInvStatus === 'SOLD_OUT') return false;
  }
  if (product && typeof product.inventory === 'number' && product.inventory <= 0) return false;

  // 4. Stock quantities
  if (typeof v.skuQuantity === 'number' && v.skuQuantity <= 0) return false;
  if (typeof v.sku_quantity === 'number' && v.sku_quantity <= 0) return false;
  if (typeof v.totalStock === 'number' && v.totalStock <= 0) return false;
  if (typeof v.total_stock === 'number' && v.total_stock <= 0) return false;
  if (typeof v.remainingStock === 'number' && v.remainingStock <= 0) return false;
  if (typeof v.remaining_stock === 'number' && v.remaining_stock <= 0) return false;
  if (typeof v.availableStock === 'number' && v.availableStock <= 0) return false;
  if (typeof v.available_stock === 'number' && v.available_stock <= 0) return false;
  if (typeof v.availableQuantity === 'number' && v.availableQuantity <= 0) return false;
  if (typeof v.available_quantity === 'number' && v.available_quantity <= 0) return false;
  if (product) {
    if (typeof product.remainingStock === 'number' && product.remainingStock <= 0) return false;
    if (typeof product.remaining_stock === 'number' && product.remaining_stock <= 0) return false;
    if (typeof product.availableStock === 'number' && product.availableStock <= 0) return false;
    if (typeof product.available_stock === 'number' && product.available_stock <= 0) return false;
  }

  // 5. Status strings
  const skuStatus = String(v.skuStatus || (product && product.skuStatus) || v.status || '').toUpperCase();
  if (skuStatus === 'OUT_OF_STOCK' || skuStatus === 'OOS' || skuStatus === 'INACTIVE' || skuStatus === 'SOLD_OUT') return false;

  const visStatus = String(v.visibilityStatus || (product && product.visibilityStatus) || '').toUpperCase();
  if (visStatus === 'OUT_OF_STOCK' || visStatus === 'HIDDEN') return false;

  // 6. CTA & Buttons ("Notify Me", "Out of stock")
  const checkTextOOS = (txt: any): boolean => {
    if (!txt || typeof txt !== 'string') return false;
    const lower = txt.toLowerCase();
    return lower.includes('notify') || lower.includes('out of stock') || lower.includes('sold out') || lower.includes('unavailable') || lower.includes('not available');
  };

  if (v.cta) {
    const ctaType = String(v.cta.type || '').toUpperCase();
    if (ctaType === 'NOTIFY_ME' || ctaType === 'OUT_OF_STOCK' || ctaType === 'OOS') return false;
    if (checkTextOOS(v.cta.text) || checkTextOOS(v.cta.title) || checkTextOOS(v.cta.cta_text)) return false;
  }
  if (product && product.cta) {
    const pCtaType = String(product.cta.type || '').toUpperCase();
    if (pCtaType === 'NOTIFY_ME' || pCtaType === 'OUT_OF_STOCK' || pCtaType === 'OOS') return false;
    if (checkTextOOS(product.cta.text) || checkTextOOS(product.cta.title) || checkTextOOS(product.cta.cta_text)) return false;
  }

  // 7. Badges & Tags
  const checkBadge = (b: any): boolean => {
    if (!b) return false;
    if (typeof b === 'string') return checkTextOOS(b);
    if (typeof b === 'object') {
      return checkTextOOS(b.text) || checkTextOOS(b.title) || checkTextOOS(b.name) || checkTextOOS(b.label);
    }
    return false;
  };

  if (checkBadge(v.badge) || (product && checkBadge(product.badge)) || checkBadge(v.tag) || (product && checkBadge(product.tag))) return false;
  if (Array.isArray(v.badges) && v.badges.some(checkBadge)) return false;
  if (product && Array.isArray(product.badges) && product.badges.some(checkBadge)) return false;

  return true;
}

export function extractStockCount(val: any): number | undefined {
  if (typeof val === 'number' && isFinite(val) && val >= 0) {
    return val;
  }
  if (typeof val === 'string') {
    const s = val.trim();
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (isFinite(n) && n >= 0 && n < 1000) return n;
    }
    // "Only 4 left", "4 left", "4 available", "Only 4 available", "4 left in stock", "Only 4 units", "4 in stock", "4 units left"
    const m1 = s.match(/(?:only\s+)?(\d+)\s*(?:left|available|in\s*stock|units?\s*(?:left|available)?)/i);
    if (m1 && m1[1]) {
      const n = parseInt(m1[1], 10);
      if (isFinite(n) && n >= 0 && n < 1000) return n;
    }
    // "Max 4 per order", "Limit 4 per customer", "Max 4 units", "Max 4"
    const m2 = s.match(/(?:max|limit|maximum)\s*(?:of\s*)?(\d+)/i);
    if (m2 && m2[1]) {
      const n = parseInt(m2[1], 10);
      if (isFinite(n) && n >= 0 && n < 1000) return n;
    }
  }
  if (typeof val === 'object' && val !== null) {
    if (typeof val.allowedQuantity === 'number' && isFinite(val.allowedQuantity) && val.allowedQuantity >= 0) {
      return val.allowedQuantity;
    }
    if (typeof val.allowed_quantity === 'number' && isFinite(val.allowed_quantity) && val.allowed_quantity >= 0) {
      return val.allowed_quantity;
    }
    if (typeof val.remaining_stock === 'number' && isFinite(val.remaining_stock) && val.remaining_stock >= 0) {
      return val.remaining_stock;
    }
    if (typeof val.remainingStock === 'number' && isFinite(val.remainingStock) && val.remainingStock >= 0) {
      return val.remainingStock;
    }
    if (typeof val.available_stock === 'number' && isFinite(val.available_stock) && val.available_stock >= 0) {
      return val.available_stock;
    }
    if (typeof val.availableStock === 'number' && isFinite(val.availableStock) && val.availableStock >= 0) {
      return val.availableStock;
    }
    if (typeof val.available_quantity === 'number' && isFinite(val.available_quantity) && val.available_quantity >= 0) {
      return val.available_quantity;
    }
    if (typeof val.availableQuantity === 'number' && isFinite(val.availableQuantity) && val.availableQuantity >= 0) {
      return val.availableQuantity;
    }
    if (typeof val.stock_quantity === 'number' && isFinite(val.stock_quantity) && val.stock_quantity >= 0) {
      return val.stock_quantity;
    }
    if (typeof val.stockQuantity === 'number' && isFinite(val.stockQuantity) && val.stockQuantity >= 0) {
      return val.stockQuantity;
    }
    if (typeof val.stock === 'number' && isFinite(val.stock) && val.stock >= 0) {
      return val.stock;
    }
    if (typeof val.totalStock === 'number' && isFinite(val.totalStock) && val.totalStock >= 0) {
      return val.totalStock;
    }
    if (typeof val.total_stock === 'number' && isFinite(val.total_stock) && val.total_stock >= 0) {
      return val.total_stock;
    }

    return (
      extractStockCount(val.allowedQuantity) ??
      extractStockCount(val.allowed_quantity) ??
      extractStockCount(val.quantityLimitBreachedMessage) ??
      extractStockCount(val.quantity_limit_breached_message) ??
      extractStockCount(val.text) ??
      extractStockCount(val.title) ??
      extractStockCount(val.message) ??
      extractStockCount(val.displayMessage) ??
      extractStockCount(val.display_message) ??
      extractStockCount(val.subText) ??
      extractStockCount(val.subtext) ??
      extractStockCount(val.sub_text) ??
      extractStockCount(val.label) ??
      extractStockCount(val.name)
    );
  }
  return undefined;
}

export function extractSwiggyStockAndLimit(v: any, product?: any): { availableStock?: number; maxQuantity?: number } {
  if (!v && !product) return {};

  let availableStock: number | undefined = undefined;
  let maxQuantity: number | undefined = undefined;

  // 1. Direct Swiggy cartAllowedQuantity structure
  const caq = v?.cartAllowedQuantity || v?.cart_allowed_quantity || product?.cartAllowedQuantity || product?.cart_allowed_quantity;
  if (caq && typeof caq === 'object') {
    const qty = typeof caq.allowedQuantity === 'number' ? caq.allowedQuantity
      : typeof caq.allowed_quantity === 'number' ? caq.allowed_quantity
      : extractStockCount(caq.allowedQuantity ?? caq.allowed_quantity);
    if (typeof qty === 'number' && isFinite(qty) && qty >= 0) {
      const msg = String(caq.quantityLimitBreachedMessage || caq.quantity_limit_breached_message || caq.message || '').toLowerCase();
      if (msg.includes('stock') || msg.includes('moment') || msg.includes('available')) {
        availableStock = qty;
      } else {
        maxQuantity = qty;
      }
      if (availableStock === undefined) {
        availableStock = qty;
      }
    }
  }

  const stockCandidates = [
    // Swiggy cartAllowedQuantity
    v?.cartAllowedQuantity?.allowedQuantity,
    v?.cart_allowed_quantity?.allowed_quantity,
    v?.cartAllowedQuantity,
    v?.cart_allowed_quantity,
    product?.cartAllowedQuantity?.allowedQuantity,
    product?.cart_allowed_quantity?.allowed_quantity,
    // Variation inventory object
    v?.inventory?.remainingStock,
    v?.inventory?.remaining_stock,
    v?.inventory?.totalStock,
    v?.inventory?.total_stock,
    v?.inventory?.availableStock,
    v?.inventory?.available_stock,
    v?.inventory?.availableQuantity,
    v?.inventory?.available_quantity,
    v?.inventory?.stock,
    v?.inventory?.available_units,
    v?.inventory?.availableUnits,
    v?.inventory?.stock_quantity,
    v?.inventory?.stockQuantity,
    v?.inventory?.remaining_quantity,
    v?.inventory?.remainingQuantity,
    typeof v?.inventory === 'number' ? v.inventory : undefined,
    // Variation direct fields
    v?.remainingStock,
    v?.remaining_stock,
    v?.availableStock,
    v?.available_stock,
    v?.availableQuantity,
    v?.available_quantity,
    v?.availableUnits,
    v?.available_units,
    v?.totalStock,
    v?.total_stock,
    v?.skuQuantity,
    v?.sku_quantity,
    v?.stockQuantity,
    v?.stock_quantity,
    v?.stock,
    // Variation actions / CTA
    v?.cta?.available_quantity,
    v?.cta?.availableQuantity,
    v?.action?.available_quantity,
    v?.action?.availableQuantity,
    v?.atc_action?.available_quantity,
    // Variation display messages / badges
    v?.inventory?.displayMessage,
    v?.inventory?.display_message,
    v?.inventory?.message,
    v?.inventory?.text,
    v?.inventory?.subText,
    v?.inventory?.subtext,
    v?.inventory?.sub_text,
    v?.inventoryBadge,
    v?.stockBadge,
    v?.badge,
    v?.tag,
    v?.subText,
    v?.subtext,
    v?.sub_text,
    v?.banner,
    v?.subtitle,
    v?.sub_title,
    // Product parent fields
    product?.inventory?.remainingStock,
    product?.inventory?.remaining_stock,
    product?.inventory?.totalStock,
    product?.inventory?.total_stock,
    product?.inventory?.availableStock,
    product?.inventory?.available_stock,
    product?.inventory?.availableQuantity,
    product?.inventory?.available_quantity,
    product?.inventory?.stock,
    typeof product?.inventory === 'number' ? product.inventory : undefined,
    product?.remainingStock,
    product?.remaining_stock,
    product?.availableStock,
    product?.available_stock,
    product?.availableQuantity,
    product?.available_quantity,
    product?.totalStock,
    product?.total_stock,
    product?.stock,
    product?.inventory?.displayMessage,
    product?.inventory?.display_message,
    product?.inventory?.message,
    product?.inventory?.text,
    product?.inventoryBadge,
    product?.stockBadge,
    product?.badge,
    product?.subText,
    product?.subtext,
    product?.subtitle,
    product?.sub_title,
  ];

  for (const c of stockCandidates) {
    const val = extractStockCount(c);
    if (typeof val === 'number') {
      availableStock = val;
      break;
    }
  }

  const maxQCandidates = [
    v?.cartAllowedQuantity?.allowedQuantity,
    v?.cart_allowed_quantity?.allowed_quantity,
    v?.cartAllowedQuantity,
    v?.cart_allowed_quantity,
    product?.cartAllowedQuantity?.allowedQuantity,
    product?.cart_allowed_quantity?.allowed_quantity,
    v?.maxAllowedQuantity,
    v?.max_allowed_quantity,
    v?.maxQuantity,
    v?.max_quantity,
    v?.max_order_quantity,
    v?.maxOrderQuantity,
    v?.order_limit,
    v?.orderLimit,
    v?.purchase_limit,
    v?.purchaseLimit,
    v?.cart_allowed_quantity,
    v?.cartAllowedQuantity,
    v?.inventory?.maxAllowedQuantity,
    v?.inventory?.max_allowed_quantity,
    v?.inventory?.maxQuantity,
    v?.inventory?.max_quantity,
    v?.inventory?.max_order_quantity,
    v?.inventory?.maxOrderQuantity,
    v?.inventory?.order_limit,
    v?.inventory?.orderLimit,
    v?.inventory?.purchase_limit,
    v?.inventory?.purchaseLimit,
    v?.cta?.max_quantity,
    v?.cta?.maxQuantity,
    v?.cta?.max,
    v?.action?.max_quantity,
    v?.action?.maxQuantity,
    v?.action?.max,
    v?.atc_action?.max_quantity,
    v?.atc_action?.maxQuantity,
    v?.stepper?.max,
    v?.stepper?.max_quantity,
    v?.stepper?.maxQuantity,
    v?.stepper?.max_allowed_quantity,
    product?.maxAllowedQuantity,
    product?.max_allowed_quantity,
    product?.maxQuantity,
    product?.max_quantity,
    product?.order_limit,
    product?.orderLimit,
    product?.purchase_limit,
    product?.purchaseLimit,
    product?.inventory?.maxAllowedQuantity,
    product?.inventory?.max_allowed_quantity,
    product?.inventory?.maxQuantity,
    product?.inventory?.max_quantity,
  ];

  for (const c of maxQCandidates) {
    const val = extractStockCount(c);
    if (typeof val === 'number' && val > 0) {
      maxQuantity = val;
      break;
    }
  }

  // Also check badge/tag arrays
  if (availableStock === undefined) {
    const badges = [
      ...(Array.isArray(v?.badges) ? v.badges : []),
      ...(Array.isArray(product?.badges) ? product.badges : []),
      ...(Array.isArray(v?.tags) ? v.tags : []),
      ...(Array.isArray(product?.tags) ? product.tags : []),
    ];
    for (const b of badges) {
      const val = extractStockCount(b);
      if (typeof val === 'number') {
        availableStock = val;
        break;
      }
    }
  }

  return { availableStock, maxQuantity };
}

function extractVariation(product: any, v: any, productId: string): any {
  if (!v || typeof v !== 'object') return null;
  if (!isSwiggyInStock(product, v)) return null;
  const name = (typeof v.displayName === 'string' && v.displayName.trim())
    ? v.displayName.trim()
    : (typeof product.displayName === 'string' ? product.displayName.trim() : '');
  const unit = (typeof v.quantityDescription === 'string') ? v.quantityDescription.trim() : '';
  const price = moneyUnits(v.price) || moneyUnits(product.price);
  if (!name || price === null) return null;
  if (name.length < 2 || name.length > 160) return null;
  let mrp: number | null = null;
  if (v.price && v.price.mrp && typeof v.price.mrp === 'object') {
    const m = asNum(v.price.mrp.units);
    if (m !== null && m > 0 && m !== price) mrp = m;
  }
  // Swiggy catalog IDs — the checkout API validates against these exact
  // spaces: itemId MUST be the variation's skuId (not v.id — see the
  // optimizer's background.js comment on treating these interchangeably),
  // spin comes from spinId ?? spin, never another id field.
  const itemIdVal = (typeof v.skuId === 'string' && v.skuId) ? v.skuId
    : (typeof v.itemId === 'string' && v.itemId) ? v.itemId
    : (typeof v.id === 'string' && v.id) ? v.id : '';
  const spinId = ((typeof v.spinId === 'string' && v.spinId) ? v.spinId
    : (typeof v.spin === 'string' && v.spin) ? v.spin : '');
  // Swiggy storeId: prefer v.storeId, fallback to v.podId
  const storeIdVal = (typeof v.storeId === 'string' || typeof v.storeId === 'number') ? String(v.storeId)
    : (typeof v.podId === 'string' || typeof v.podId === 'number') ? String(v.podId) : '';

  const prodIdVal = (typeof v.productId === 'string' && v.productId) ? v.productId
    : (typeof v.product_id === 'string' && v.product_id) ? v.product_id
    : (typeof productId === 'string' && productId) ? productId
    : (typeof product?.productId === 'string' && product.productId) ? product.productId
    : (typeof product?.product_id === 'string' && product.product_id) ? product.product_id
    : (typeof product?.id === 'string' && product.id) ? product.id
    : itemIdVal;

  const { availableStock, maxQuantity } = extractSwiggyStockAndLimit(v, product);

  const interestingKeys = Object.keys(v).filter(k => /inventory|stock|limit|max|stepper|cta|badge|quantity|available|count/i.test(k));
  if (interestingKeys.length > 0 || availableStock !== undefined || maxQuantity !== undefined) {
    const detail: Record<string, any> = {};
    for (const k of interestingKeys) detail[k] = v[k];
  }

  return {
    name: name,
    price: price,
    mrp: mrp,
    unit: unit,
    image: variationImage(product, v),
    type: 'product',
    productId: prodIdVal,
    itemId: itemIdVal,
    spinId: spinId,
    storeId: storeIdVal,
    inStock: true,
    availableStock,
    maxQuantity,
    _rawVariation: v  // kept temporarily for debugging
  };
}

export function extractSwiggySearchProducts(json: any, query?: string): any[] {
  const out: any[] = [];
  const seen: Record<string, boolean> = {};
  if (!json || typeof json !== 'object') return out;
  const visited = new Set<any>();
  function walk(node: any) {
    if (out.length >= 120 || !node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && out.length < 120; i++) walk(node[i]);
      return;
    }
    const hasVariations = Array.isArray(node.variations) && node.variations.length > 0;
    const hasName = typeof node.displayName === 'string' || typeof node.name === 'string' || typeof node.variations?.[0]?.displayName === 'string';
    if (hasVariations && hasName) {
      const productId = (typeof node.productId === 'string') ? node.productId : '';
      for (let v = 0; v < node.variations.length && out.length < 120; v++) {
        const p = extractVariation(node, node.variations[v], productId);
        if (p && p.inStock !== false) {
          const key = (p.productId || p.name) + '|' + p.unit;
          if (!seen[key]) { seen[key] = true; out.push(p); }
        }
      }
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length && out.length < 120; i++) {
      const v = node[keys[i]];
      if (v && typeof v === 'object' && v !== node.variations) walk(v);
    }
  }
  walk(json);

  // search/v2 responses mix genuine results with pre-search recommendations,
  // category tiles and ad carousels — the blind walk above happily returns
  // 'Arokya Milk' for an 'eggs' query. Keep only items whose name/brand/
  // category shares a token with the query (plural-stemmed); if filtering
  // would nearly empty the page, fall back to the raw ordering.
  const qTokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(tok => tok.length > 2)
    .map(tok => tok.replace(/s$/, ''));
  if (qTokens.length && out.length > 4) {
    const relevant = out.filter(p => {
      const rv: any = p._rawVariation || {};
      const cat = typeof rv.category === 'string' ? rv.category : (rv.category?.displayName || '');
      const hay = `${p.name} ${rv.brandName || ''} ${cat}`.toLowerCase();
      return qTokens.some(tok => hay.includes(tok));
    });
    if (relevant.length >= 3) return relevant;
  }
  return out;
}

// --- Blinkit Helpers ---
function findBlinkitImageUrl(n: any, depth: number): string | null {
  if (!n || depth > 4) return null;
  if (typeof n === 'string') {
    const str = n.trim();
    if (/\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(str) || str.indexOf('cdn-cgi') !== -1 || str.indexOf('grofers') !== -1 || str.indexOf('cms-assets') !== -1 || str.indexOf('product/') !== -1 || str.indexOf('rc-upload') !== -1) {
      return str;
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
      return str;
    }
    return null;
  }
  if (typeof n !== 'object') return null;
  const cand = n.url || n.src || n.image_url || n.media_url || n.tile_image_url || n.product_image_url || n.image_src || n.imageUrl || n.mediaUrl || n.image_id || n.photo_id || n.media_id;
  if (cand && typeof cand === 'string') {
    const cStr = cand.trim();
    if (/\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(cStr) || cStr.indexOf('rc-upload') !== -1 || cStr.indexOf('cms-assets') !== -1 || cStr.indexOf('product/') !== -1 || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cStr)) {
      return cStr;
    }
  }

  const keys = Object.keys(n);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'parent' || k === 'owner') continue;
    const subRes = findBlinkitImageUrl(n[k], depth + 1);
    if (subRes) return subRes;
  }
  return null;
}

function formatBlinkitImageUrl(url: string | null): string {
  if (!url || typeof url !== 'string') return '';
  url = url.trim();
  if (!url) return '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url)) {
    return 'https://cdn.grofers.com/da/cms-assets/cms/product/' + url + '.png';
  }
  if (url.startsWith('//')) url = 'https:' + url;
  else if (url.startsWith('/')) url = 'https://cdn.grofers.com' + url;

  // If already scaled via cdn-cgi, keep it
  if (url.includes('cdn-cgi/image/')) return url;

  // Scale down full-size grofers images to thumbnails (w=270, q=70) for 90%+ RAM & bandwidth reduction
  if (url.includes('cdn.grofers.com/app/images/')) {
    return url.replace('https://cdn.grofers.com/', 'https://cdn.grofers.com/cdn-cgi/image/f=auto,fit=scale-down,q=70,metadata=none,w=270/');
  }

  if (url.startsWith('http://') || url.startsWith('https://')) return url;

  return 'https://cdn.grofers.com/cdn-cgi/image/f=auto,fit=scale-down,q=70,metadata=none,w=270/' + url;
}

function isBlinkitInStock(node: any): boolean {
  if (!node || typeof node !== 'object') return false;

  // 1. Explicit booleans
  if (node.in_stock === false || node.is_available === false || node.available === false) return false;
  if (node.out_of_stock === true || node.is_oos === true || node.sold_out === true || node.is_sold_out === true) return false;
  if (node.is_disabled === true || node.disabled === true) return false;

  // 2. Inventory numbers
  if (typeof node.inventory === 'number' && node.inventory <= 0) return false;
  if (typeof node.inventory_level === 'number' && node.inventory_level <= 0) return false;
  if (typeof node.stock_level === 'number' && node.stock_level <= 0) return false;
  if (typeof node.available_units === 'number' && node.available_units <= 0) return false;
  if (typeof node.available_quantity === 'number' && node.available_quantity <= 0) return false;
  if (typeof node.stock === 'number' && node.stock <= 0) return false;

  // 3. Inventory object
  if (node.inventory && typeof node.inventory === 'object') {
    if (node.inventory.in_stock === false || node.inventory.is_available === false) return false;
    if (typeof node.inventory.quantity === 'number' && node.inventory.quantity <= 0) return false;
    if (typeof node.inventory.stock === 'number' && node.inventory.stock <= 0) return false;
    if (typeof node.inventory.total === 'number' && node.inventory.total <= 0) return false;
    const level = String(node.inventory.level || node.inventory.status || '').toUpperCase();
    if (level === 'OUT_OF_STOCK' || level === 'OOS' || level === 'SOLD_OUT') return false;
  }

  // 4. Status strings
  const statusStr = String(node.inventory_status || node.product_state || node.state || node.status || '').toUpperCase();
  if (statusStr === 'OUT_OF_STOCK' || statusStr === 'OOS' || statusStr === 'SOLD_OUT' || statusStr === 'INACTIVE') return false;

  // 5. CTA / Actions / Buttons ("Notify Me", "Out of stock")
  const checkTextOOS = (txt: any): boolean => {
    if (!txt || typeof txt !== 'string') return false;
    const lower = txt.toLowerCase();
    return lower.includes('notify') || lower.includes('out of stock') || lower.includes('sold out') || lower.includes('unavailable') || lower.includes('not available');
  };

  if (node.cta) {
    const ctaType = String(node.cta.type || '').toUpperCase();
    if (ctaType === 'NOTIFY_ME' || ctaType === 'OUT_OF_STOCK' || ctaType === 'OOS') return false;
    if (checkTextOOS(node.cta.text) || checkTextOOS(node.cta.title) || checkTextOOS(node.cta.cta_text)) return false;
  }

  if (node.action) {
    const actionType = String(node.action.type || '').toUpperCase();
    if (actionType === 'NOTIFY_ME' || actionType === 'OUT_OF_STOCK') return false;
    if (checkTextOOS(node.action.text) || checkTextOOS(node.action.title)) return false;
  }

  if (node.button && (checkTextOOS(node.button.text) || checkTextOOS(node.button.title) || checkTextOOS(node.button.cta_text))) {
    return false;
  }

  if (node.atc_action) {
    if (node.atc_action.is_disabled === true) return false;
    const atcType = String(node.atc_action.type || '').toUpperCase();
    if (atcType === 'NOTIFY_ME' || atcType === 'OUT_OF_STOCK') return false;
    if (checkTextOOS(node.atc_action.text) || checkTextOOS(node.atc_action.title)) return false;
  }

  // 6. Badges / Tags / Overlays
  const checkBadge = (b: any): boolean => {
    if (!b) return false;
    if (typeof b === 'string') return checkTextOOS(b);
    if (typeof b === 'object') {
      return checkTextOOS(b.text) || checkTextOOS(b.title) || checkTextOOS(b.name) || checkTextOOS(b.label);
    }
    return false;
  };

  if (checkBadge(node.badge) || checkBadge(node.overlay) || checkBadge(node.tag) || checkBadge(node.tag_text) || checkBadge(node.banner) || checkBadge(node.ribbon)) {
    return false;
  }
  if (Array.isArray(node.badges) && node.badges.some(checkBadge)) return false;
  if (Array.isArray(node.tags) && node.tags.some(checkBadge)) return false;

  // 7. Cart item checks
  if (node.cart_item && typeof node.cart_item === 'object') {
    if (node.cart_item.in_stock === false || node.cart_item.available === false) return false;
    if (typeof node.cart_item.inventory === 'number' && node.cart_item.inventory <= 0) return false;
    if (typeof node.cart_item.stock === 'number' && node.cart_item.stock <= 0) return false;
  }

  return true;
}

export function parseBlinkitProducts(json: any): any[] {
  const out: any[] = [];
  if (!json || typeof json !== 'object') return out;
  const visited = new Set<any>();
  function walk(node: any) {
    if (out.length >= 80 || !node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && out.length < 80; i++) walk(node[i]);
      return;
    }

    let name: string | null = null;
    let price: any = null;
    let mrp: any = null;
    let unit: string | null = null;
    let image: string | null = null;

    if (node.name) {
      if (typeof node.name === 'string') name = node.name;
      else if (typeof node.name === 'object' && node.name.text) name = node.name.text;
    }
    if (!name && node.title) {
      if (typeof node.title === 'string') name = node.title;
      else if (typeof node.title === 'object' && node.title.text) name = node.title.text;
    }
    if (!name && node.product_name) name = node.product_name;

    if (node.price) {
      if (typeof node.price === 'number') price = node.price;
      else if (typeof node.price === 'string') price = node.price;
      else if (typeof node.price === 'object' && node.price.text) price = node.price.text;
      else if (typeof node.price === 'object' && node.price.value) price = node.price.value;
    }
    if (price == null && node.offer_price) price = node.offer_price;
    if (price == null && node.unit_price) price = node.unit_price;

    if (node.mrp) {
      if (typeof node.mrp === 'number') mrp = node.mrp;
      else if (typeof node.mrp === 'string') mrp = node.mrp;
      else if (typeof node.mrp === 'object' && node.mrp.text) mrp = node.mrp.text;
    }
    if (mrp == null && node.normal_price) mrp = node.normal_price;

    if (node.unit) {
      if (typeof node.unit === 'string') unit = node.unit;
      else if (typeof node.unit === 'object' && node.unit.text) unit = node.unit.text;
    }
    if (!unit && node.pack_size) unit = typeof node.pack_size === 'object' ? node.pack_size.text : node.pack_size;
    if (!unit && node.weight) unit = typeof node.weight === 'object' ? node.weight.text : node.weight;

    if (name && typeof name === 'string' && price != null) {
      const numPrice = typeof price === 'number' ? price : Number((String(price).match(/\d[\d,]*/) || [])[0] || 0);
      const numMrp = typeof mrp === 'number' ? mrp : Number((String(mrp || price).match(/\d[\d,]*/) || [])[0] || 0);
      if (numPrice > 0 && name.length >= 3 && name.length <= 150) {
        if (isBlinkitInStock(node)) {
          const rawImg = findBlinkitImageUrl(node, 0);
          image = formatBlinkitImageUrl(rawImg);
          const cleanName = String(name).trim();
          let cleanUnit = (unit && typeof unit === 'string') ? unit.trim() : '';
          let cartItem: any = null;
          try { cartItem = node.atc_action && node.atc_action.add_to_cart && node.atc_action.add_to_cart.cart_item; } catch {}
          if (!cartItem && node.cart_item) cartItem = node.cart_item;
          if (!cleanUnit && cartItem && (cartItem.unit || cartItem.variant)) {
            cleanUnit = String(cartItem.unit || cartItem.variant).trim();
          }

          let availableStock: number | undefined = undefined;
          for (const val of [
            cartItem?.inventory,
            cartItem?.available_units,
            cartItem?.available_quantity,
            cartItem?.stock,
            typeof node.inventory === 'number' ? node.inventory : undefined,
            node.inventory?.quantity,
            node.inventory?.stock,
            node.inventory?.total,
            node.available_units,
            node.available_quantity,
            node.inventory_level,
            node.stock_level,
            node.stock,
          ]) {
            if (typeof val === 'number' && isFinite(val) && val >= 0) {
              availableStock = val;
              break;
            }
          }

          let maxQuantity: number | undefined = undefined;
          for (const val of [
            cartItem?.max_quantity,
            cartItem?.purchase_limit,
            node.max_quantity,
            node.purchase_limit,
            node.order_limit,
            node.max_allowed_quantity,
          ]) {
            if (typeof val === 'number' && isFinite(val) && val > 0) {
              maxQuantity = val;
              break;
            }
          }

          out.push({
            name: cleanName,
            price: numPrice,
            mrp: numMrp || numPrice,
            unit: cleanUnit,
            image: image,
            type: 'product',
            productId: String((cartItem && (cartItem.product_id || cartItem.type_id)) || node.id || node.product_id || ''),
            itemId: String((cartItem && cartItem.sku_id) || ''),
            spinId: String((cartItem && (cartItem.spin_id || cartItem.spin)) || ''),
            storeId: String((cartItem && (cartItem.pod_id || cartItem.store_id)) || ''),
            availableStock,
            maxQuantity,
          });
        }
      }
    }

    const keys = Object.keys(node);
    for (let k = 0; k < keys.length && out.length < 80; k++) {
      if (keys[k] !== 'parent' && keys[k] !== 'owner' && typeof node[keys[k]] === 'object') {
        walk(node[keys[k]]);
      }
    }
  }

  walk(json);

  const finalOut: any[] = [];
  const finalSeen: Record<string, number> = {};

  for (let k = 0; k < out.length; k++) {
    const item = out[k];
    const normName = item.name.toLowerCase();
    const cleanUnit = (item.unit || '').trim().toLowerCase();
    const normKey = normName + '|' + cleanUnit;

    if (finalSeen[normKey] != null) {
      const existing = finalOut[finalSeen[normKey]];
      if (!existing.image && item.image) existing.image = item.image;
    } else if (finalSeen[normName] != null) {
      const existingNameIdx = finalSeen[normName];
      const existingNameItem = finalOut[existingNameIdx];
      if (!item.unit && !item.image) {
        continue;
      }
      if (!existingNameItem.unit && item.unit) existingNameItem.unit = item.unit;
      if (!existingNameItem.image && item.image) existingNameItem.image = item.image;

      if (existingNameItem.unit.toLowerCase() === cleanUnit || !cleanUnit) {
        continue;
      }
      finalSeen[normKey] = finalOut.length;
      finalOut.push(item);
    } else {
      finalSeen[normKey] = finalOut.length;
      finalSeen[normName] = finalOut.length;
      finalOut.push(item);
    }
  }

  return finalOut.filter((p) => p.name && p.price > 0);
}

interface BillFees {
  subtotal: number | null;
  deliveryFee: number | null;
  handlingFee: number | null;
  smallCartFee: number | null;
  surgeFee: number | null;
  surgeLabel?: string | null;
  freeDeliveryGap?: number | null;
  tax: number | null;
  total: number | null;
}

export function parseBlinkitBill(json: any): BillFees {
  const cd = json?.cart_data || json?.data?.cart_data || json?.data || json;
  let bill = cd?.bill_details || cd?.billDetails || cd?.bill || json?.bill_details || json?.billDetails || json?.bill || null;
  if (!bill && cd?.shipments?.[0]) {
    bill = cd.shipments[0].bill_details || cd.shipments[0].billDetails || null;
  }
  if (!bill && Array.isArray(cd?.shipments)) {
    for (const s of cd.shipments) {
      if (s?.bill_details || s?.billDetails) {
        bill = s.bill_details || s.billDetails;
        break;
      }
    }
  }
  if (!bill && !cd) return { subtotal: null, deliveryFee: null, handlingFee: null, smallCartFee: null, surgeFee: 0, tax: null, total: null };

  const num = (v: any) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const m = v.match(/-?[\d,]+(?:\.\d+)?/);
      return m ? Number(m[0].replace(/,/g, '')) : null;
    }
    return null;
  };

  const getVal = (keys: string[], targetObj: any = bill) => {
    if (!targetObj || typeof targetObj !== 'object') return null;
    for (const key of keys) {
      if (targetObj[key] !== undefined && targetObj[key] !== null) {
        const n = num(targetObj[key]);
        if (n !== null) return n;
      }
    }
    return null;
  };

  let handlingCharge = null;
  let smallCartCharge = null;
  // Named fees beyond handling(3)/small-cart(7) — e.g. Blinkit's late-night
  // surge — arrive as their own additional_charges entry with display text.
  // Without this they were silently dropped.
  let acSurge = null;
  let acSurgeLabel: string | null = null;
  const ac = cd?.additional_charges || [];
  for (const c of ac) {
    if (!c) continue;
    const amt = num(c.amount);
    if (amt === null) continue;
    const cid = Number(c.charge_id);
    if (cid === 3) handlingCharge = amt;
    else if (cid === 7) smallCartCharge = amt;
    else if (cid === 5) {
      // Blinkit's late-night/slot surge — arrives UNNAMED (name: null,
      // assignment tag like 'mov|nc_15'), so it must be mapped by id.
      acSurge = Math.max(acSurge ?? 0, amt);
      if (!acSurgeLabel) acSurgeLabel = 'Late night charge';
    } else {
      const label = String(c.display_text || c.name || c.title || '');
      if (/late|night|surge|rain|high.?demand/i.test(label)) {
        acSurge = Math.max(acSurge ?? 0, amt);
        if (!acSurgeLabel && label) acSurgeLabel = label;
      }
    }
  }

  // Rain/slot/late-night surge rides in slot_charge AND/OR
  // surge_charge_v2.surge_amount (both part of payable_amount). They are
  // independent lines — one being present-but-₹0 must not mask the other.
  const slotSurge = bill && bill.slot_charge != null ? num(bill.slot_charge) : null;
  const v2Surge = bill?.surge_charge_v2?.surge_amount != null ? num(bill.surge_charge_v2.surge_amount) : null;

  const subtotalKeys = [
    'total_cost', 'totalCost',
    'item_total', 'itemTotal',
    'items_total', 'itemsTotal',
    'item_price_total', 'itemPriceTotal',
    'total_item_cost', 'totalItemCost',
    'subtotal', 'sub_total', 'subTotal',
    'cart_value', 'cartValue',
    'cart_total', 'cartTotal',
    'product_total', 'productTotal',
    'items_cost', 'itemsCost'
  ];

  let parsedSubtotal = getVal(subtotalKeys);

  // If bill is an array of line items (e.g. [{ display_text: "Item Total", value: 120 }])
  if (parsedSubtotal === null && Array.isArray(bill)) {
    for (const item of bill) {
      const label = String(item?.display_text || item?.name || item?.title || item?.type || item?.key || '').toLowerCase();
      const val = num(item?.amount ?? item?.value ?? item?.cost ?? item?.price);
      if (val !== null && /item|subtotal|cart.?value|products/i.test(label) && !/tax|fee|charge|delivery/i.test(label)) {
        parsedSubtotal = val;
        break;
      }
    }
  }

  // If subtotal is at the cart_data level directly
  if (parsedSubtotal === null && cd) {
    parsedSubtotal = getVal(subtotalKeys, cd);
  }

  // If subtotal is in cart_data.items or cart_items (live items from API)
  if (parsedSubtotal === null && cd) {
    const rawItems = Array.isArray(cd.items) ? cd.items : Array.isArray(cd.cart_items) ? cd.cart_items : null;
    if (rawItems && rawItems.length > 0) {
      let sum = 0;
      let hasValid = false;
      for (const it of rawItems) {
        const itemP = num(it.item_total ?? it.total_price ?? it.final_price)
          ?? (num(it.price) !== null && num(it.quantity) !== null ? num(it.price)! * num(it.quantity)! : null);
        if (itemP !== null && itemP > 0) {
          sum += itemP;
          hasValid = true;
        }
      }
      if (hasValid && sum > 0) {
        parsedSubtotal = sum;
      }
    }
  }

  const totalVal = getVal(['payable_amount', 'payableAmount', 'bill_total', 'billTotal', 'to_pay', 'toPay', 'grand_total', 'grandTotal']);
  const deliveryVal = getVal(['delivery_charge', 'deliveryCharge', 'delivery_charges', 'deliveryCharges', 'delivery_fee']);
  const handlingVal = handlingCharge !== null ? handlingCharge : getVal(['additional_charge', 'additionalCharge', 'platform_fee', 'convenience_fee']);
  const smallCartVal = smallCartCharge !== null ? smallCartCharge : 0;
  const surgeVal = Math.max(slotSurge ?? 0, v2Surge ?? 0, acSurge ?? 0);
  const taxVal = getVal(['total_tax_on_charges', 'totalTaxOnCharges', 'tax', 'gst']);

  if (parsedSubtotal === null && totalVal !== null) {
    const otherFees = (deliveryVal ?? 0) + (handlingVal ?? 0) + (smallCartVal ?? 0) + (surgeVal ?? 0) + (taxVal ?? 0);
    if (totalVal >= otherFees) {
      parsedSubtotal = totalVal - otherFees;
    }
  }

  // Free-delivery gap. The live threshold sits in
  // flat_delivery_charge_attributes.free_delivery_mov and is measured against
  // total_cost (item total after discounts) — verified against the native app
  // ("shop ₹19 more": 199 − 180). bill_details.free_delivery_mov (250) is NOT
  // what the app uses, so it is deliberately ignored.
  let freeDeliveryGap: number | null = null;
  const flatMov = bill && typeof bill === 'object' ? num(bill.flat_delivery_charge_attributes?.free_delivery_mov) : null;
  if (flatMov !== null && flatMov > 0 && parsedSubtotal !== null && (deliveryVal ?? 0) > 0) {
    const gap = Math.ceil(flatMov - parsedSubtotal);
    if (gap > 0) freeDeliveryGap = gap;
  }

  return {
    subtotal: parsedSubtotal,
    freeDeliveryGap,
    deliveryFee: deliveryVal,
    handlingFee: handlingVal,
    smallCartFee: smallCartVal,
    surgeFee: surgeVal,
    surgeLabel: acSurgeLabel || undefined,
    tax: taxVal,
    total: totalVal
  };
}

export function instamartNormKey(s: any): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Pick the search-v2 variation for a basket item. Exact catalog-id match wins;
// otherwise only a candidate that is the SAME product (strict name + pack size)
// is accepted. There is deliberately no loose fallback: returning null (so the
// item is treated as unavailable) is better than silently linking a different
// product ("Pav Bread" vs "Milk Bread").
export function pickInstamartCandidate(candidates: any[], name: string, unit: string, price?: number, preferId?: string): any | null {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  if (preferId) {
    const exact = candidates.find(c => [c.productId, c.originalId, c.itemId, c.id].some(v => v && String(v) === preferId));
    if (exact) return exact;
  }

  const target = { name, title: name, unit, quantity: unit, price };
  const bestMatch = pickBestMatch(target, candidates);
  if (bestMatch && bestMatch.candidate && isSameProduct(target, bestMatch.candidate)) {
    return bestMatch.candidate;
  }
  return null;
}

// Locates the bill node in a checkout/v2/cart response. The documented spot
// (data.data.bill) is tried first, then a structural scan keyed on the bill's
// own numeric fields — Swiggy occasionally nests the bill deeper or returns
// only an ack on POST, with the bill arriving on the follow-up GET instead.
export function findSwiggyBillNode(json: any): any | null {
  // Swiggy sends bill values as strings ("125.0") as often as numbers.
  const toNum = (v: any) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return isFinite(n) ? n : NaN;
  };
  const looksLikeBill = (n: any) =>
    n && typeof n === 'object'
    && isFinite(toNum(n.toPay)) && toNum(n.toPay) > 0
    && (isFinite(toNum(n.gst))
      || isFinite(toNum(n.itemTotal))
      || isFinite(toNum(n.deliveryFeeAfterDiscount)));

  // Direct paths must STILL validate — Swiggy returns an empty bill object
  // here when the session has no resolvable address, which previously
  // short-circuited parsing and masked the real failure.
  const direct = json?.data?.data?.bill || json?.data?.bill || json?.bill;
  if (looksLikeBill(direct)) return direct;

  const visited = new Set<any>();

  const walk = (node: any): any => {
    if (!node || typeof node !== 'object' || visited.has(node)) return null;
    visited.add(node);
    if (looksLikeBill(node)) return node;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    for (const key of Object.keys(node)) {
      const found = walk(node[key]);
      if (found) return found;
    }
    return null;
  };
  return walk(json);
}

// Maps Swiggy Instamart's checkout/v2/cart `bill` object into BillFees using
// the API's own field names (mirrors instamartBillToFees in the desktop
// grocery-order-optimizer extension). Every value is taken verbatim from the
// response — packaging + convenience are only summed because the app shows
// them as one "Packaging/Conv." line.
export function parseSwiggyBill(bill: any): BillFees {
  const empty: BillFees = { subtotal: null, deliveryFee: null, handlingFee: null, smallCartFee: null, surgeFee: 0, tax: null, total: null };
  if (!bill || typeof bill !== 'object') return empty;

  // Accepts numbers AND numeric strings ("30.0") — Swiggy sends both.
  // Values are rounded because Swiggy computes fees as floats (12.0006)
  // but displays and charges rounded rupees (₹12), confirmed by toPay.
  const num = (v: any) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return isFinite(n) ? Math.round(n) : null;
  };

  // The authoritative fee lines live in bill.charges[], typed and
  // display-named by Swiggy itself ("Delivery Partner Fee", "Handling Fee").
  //
  // Discount encoding (verified against toPay across waived & paid runs):
  // - delivery: Swiggy One free-delivery appears as ctx.chargesBreakup[]
  //   discValue equal to the base — the NET (value − disc) is what's charged.
  // - handling/packaging: discValue exists but is NOT deducted from toPay
  //   (informational only) — the GROSS value is what's charged and shown.
  const chargeNet = (...types: string[]) => {
    if (!Array.isArray(bill.charges)) return null;
    const hit = bill.charges.find((c: any) => types.includes(c?.type));
    if (!hit) return null;
    const value = num(hit.value);
    if (value === null) return null;
    const disc = Array.isArray(hit.ctx?.chargesBreakup)
      ? (hit.ctx.chargesBreakup as any[]).reduce((s, b) => s + (num(b?.discValue) ?? 0), 0)
      : 0;
    return Math.max(0, value - disc);
  };
  const chargeGross = (...types: string[]) => {
    if (!Array.isArray(bill.charges)) return null;
    const hit = bill.charges.find((c: any) => types.includes(c?.type));
    return hit ? num(hit.value) : null;
  };

  const packaging = chargeGross('storePackagingCharges', 'packagingCharge', 'handlingCharge');
  const convenience = num(bill.convenienceFee);

  // Rain/weather surge is a dynamic charge — matched loosely because its
  // type/name varies ("RAIN_FEE", "surgeCharge", …).
  let surge: number | null = null;
  let surgeLabel: string | null = null;
  if (Array.isArray(bill.charges)) {
    const hit = bill.charges.find((c: any) =>
      /surge|rain/i.test(`${c?.type || ''} ${c?.name || ''}`)
    );
    if (hit) {
      surge = num(hit.value);
      // Use Swiggy's own display name ("Late Night Fee", "Rain Fee", …).
      surgeLabel = String(hit.ctx?.displayName || '').trim() || null;
    }
  }
  if (surge === null) {
    surge = num(bill.surgeFee) ?? num(bill.rainFee) ?? num(bill.surgeCharge) ?? 0;
  }

  const subtotalKeys = ['itemTotal', 'itemsTotal', 'subTotal', 'subtotal', 'item_total', 'cartSubTotal', 'cartSubtotal', 'totalCost', 'total_cost'];
  let swiggySubtotal: number | null = null;
  for (const k of subtotalKeys) {
    if (bill[k] != null) {
      const n = num(bill[k]);
      if (n !== null) { swiggySubtotal = n; break; }
    }
  }
  if (swiggySubtotal === null && Array.isArray(bill.charges)) {
    const itemCharge = bill.charges.find((c: any) => /item|subtotal/i.test(`${c?.type || ''} ${c?.name || ''}`));
    if (itemCharge) swiggySubtotal = num(itemCharge.value);
  }
  const toPayVal = num(bill.toPay);
  const deliveryVal = chargeNet('deliveryCharge', 'deliveryFee')
    ?? num(bill.deliveryFeeAfterDiscount != null ? bill.deliveryFeeAfterDiscount : bill.deliveryCharges);
  const handlingVal = (packaging !== null || convenience !== null)
    ? (packaging ?? 0) + (convenience ?? 0)
    : null;
  const smallCartVal = chargeGross('smallCartCharges') ?? num(bill.smallCartCharges);

  // Swiggy states the remaining gap itself on the delivery charge line, e.g.
  // "Add items worth ₹34 to avail your Swiggy One Free Delivery on this order".
  // Only trusted when the message is about free delivery and a rupee amount.
  let freeDeliveryGap: number | null = null;
  if (Array.isArray(bill.charges)) {
    const del = bill.charges.find((c: any) => c?.type === 'deliveryCharge' || c?.type === 'deliveryFee');
    const msg = String(del?.ctx?.inlineMessage || '');
    const m = /free\s+delivery/i.test(msg) ? msg.match(/₹\s*(\d+(?:\.\d+)?)/) : null;
    if (m) {
      const gap = Math.ceil(Number(m[1]));
      if (gap > 0) freeDeliveryGap = gap;
    }
  }
  const taxVal = num(bill.gst);

  if (swiggySubtotal === null && toPayVal !== null) {
    const other = (deliveryVal ?? 0) + (handlingVal ?? 0) + (smallCartVal ?? 0) + (surge ?? 0) + (taxVal ?? 0);
    if (toPayVal >= other) {
      swiggySubtotal = toPayVal - other;
    }
  }

  return {
    subtotal: swiggySubtotal,
    deliveryFee: deliveryVal,
    handlingFee: handlingVal,
    smallCartFee: smallCartVal,
    surgeFee: surge,
    surgeLabel,
    freeDeliveryGap,
    tax: taxVal,
    total: toPayVal
  };
}
