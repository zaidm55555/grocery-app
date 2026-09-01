import { storage, Platform, LocationData } from './storage';
import { requestViaSwiggyBridge, requestEvalViaSwiggyBridge } from './swiggyBridge';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestViaBlinkitBridge, getBlinkitPageStorage } from './blinkitBridge';

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
  // Auto-match: per-platform representation of the SAME cart line, filled by
  // the matcher so one line carries prices from every app (like the desktop
  // optimizer's platformPrices model).
  platformPrices?: Partial<Record<Platform, PlatformVariant>>;
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
}

// Effective product used when pricing a cart line on a given platform:
// the auto-matched variant when present, otherwise the line's own fields
// if it originated from that platform, else null (line doesn't exist there).
export function resolvePlatformProduct(item: { product: UnifiedProduct; quantity: number }, platform: Platform): { product: UnifiedProduct; quantity: number } | null {
  const v = item.product.platformPrices?.[platform];
  if (v) {
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
      },
      quantity: item.quantity
    };
  }
  return item.product.platform === platform ? item : null;
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
  // True when a live checkout bill was fetched from the platform's own API
  // (false = baseline estimate only / not fetched).
  live?: boolean;
}

// fetchWithTimeout is now defined inside the api object

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

  async getClosestBlinkitAddress(lat: number, lng: number): Promise<any | null> {
    const addresses = await this.getBlinkitAddresses(lat, lng);
    if (addresses.length === 0) return null;

    const distanceKm = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
      const R = 6371;
      const dLat = (bLat - aLat) * Math.PI / 180;
      const dLng = (bLng - aLng) * Math.PI / 180;
      return 2 * R * Math.asin(Math.sqrt(
        Math.sin(dLat / 2) ** 2 +
        Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
      ));
    };

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
      return closest;
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

    let cached: any = null;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      cached = raw ? JSON.parse(raw) : null;
    } catch {}

    if (!force && cached?.id && typeof cached.lat === 'number' && typeof cached.lng === 'number') {
      const fresh = typeof cached.at === 'number' && Date.now() - cached.at < 24 * 3600 * 1000;
      const nearby = distanceKm(lat, lng, cached.lat, cached.lng) < 6;
      const cachedLocNearby = !cached.location || distanceKm(lat, lng, cached.location.latitude, cached.location.longitude) <= 35;
      if (fresh && nearby && cachedLocNearby) {
        return {
          id: String(cached.id),
          name: cached.name || null,
          location: cached.location ? { latitude: cached.location.latitude, longitude: cached.location.longitude } : null,
          distanceKm: typeof cached.distanceKm === 'number' ? cached.distanceKm : undefined
        };
      }
    }

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
        await AsyncStorage.removeItem(KEY);
        await AsyncStorage.removeItem('@swiggy_address_id');
        await AsyncStorage.removeItem('@swiggy_address_name');
        await AsyncStorage.removeItem('@swiggy_lat');
        await AsyncStorage.removeItem('@swiggy_lng');
        return null;
      }

      const best = scored[0];
      if (!best || best.distanceKm > 35 || best.distanceKm < 0) {
        // No saved address within 35km of current location
        await AsyncStorage.removeItem(KEY);
        await AsyncStorage.removeItem('@swiggy_address_id');
        await AsyncStorage.removeItem('@swiggy_address_name');
        await AsyncStorage.removeItem('@swiggy_lat');
        await AsyncStorage.removeItem('@swiggy_lng');
        return null;
      }

      await AsyncStorage.setItem(KEY, JSON.stringify({
        id: best.id,
        name: best.name,
        location: best.location,
        distanceKm: best.distanceKm,
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
      return {
        id: best.id,
        name: best.name,
        location: best.location,
        distanceKm: best.distanceKm
      };
    } catch (e) {
      return null;
    }
  },

  async swiggyApiFetch(url: string, method: string = 'GET', body?: string): Promise<Response | { ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }> {
    const bridged = await requestViaSwiggyBridge(url, method, body);
    if (bridged) {
      return {
        ok: bridged.status >= 200 && bridged.status < 300,
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

  async search(query: string, onPlatformResults?: (platform: Platform, results: UnifiedProduct[]) => void): Promise<UnifiedProduct[]> {
    const platforms: Platform[] = ['blinkit', 'swiggy'];
    const searchPromises = platforms.map(async (platform) => {
      const token = await storage.getToken(platform);
      const location = await storage.getLocation();

      let results: UnifiedProduct[] = [];
      if (token) {
        try {
          results = await this.fetchDirectAPI(platform, query, token, location);
        } catch (error) {
          results = [];
        }
      }

      onPlatformResults?.(platform, results);
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
    } catch (error) {
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
        storeId: item.storeId
      }));
    }

    if (platform === 'swiggy') {
      const delivery = await this.resolveSwiggyDeliveryAddress(lat, lng);
      const searchLat = delivery?.location?.latitude ?? lat;
      const searchLng = delivery?.location?.longitude ?? lng;

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

      if (!homeResponse.ok) {
        throw new Error(`Swiggy home/v2 discovery error: ${homeResponse.status}`);
      }

      const homeJson = await homeResponse.json();
      const store = findStoreInfo(homeJson);

      if (!store.storeId) {
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

      const searchJson = await searchResponse.json();
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
        productId: item.productId,
        spinId: item.spinId,
        storeId: item.storeId
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
    onPlatformResult?: (calc: CartCalculation) => void
  ): Promise<CartCalculation[]> {
    const platforms: Platform[] = ['blinkit', 'swiggy'];

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
      // Filter and use only the items that exist on this platform — either
      // via an auto-matched variant (platformPrices) or by originating here.
      const platformItems = items
        .map((cartItem) => resolvePlatformProduct(cartItem, platform))
        .filter((ci): ci is { product: UnifiedProduct; quantity: number } => ci !== null);

      // The item subtotal starts from the search-API prices and gets
      // overwritten by the live bill's itemTotal when the cart API responds.
      let subtotal = platformItems.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);
      const originalSubtotal = platformItems.reduce((sum, item) => sum + ((item.product.originalPrice || item.product.price) * item.quantity), 0);

      // No charge is ever estimated locally — every fee/tax below comes from
      // the platform's own cart/bill API. Until an API responds we only know
      // the item subtotal, so that is the baseline total.
      let deliveryFee = 0;
      let handlingFee = 0;
      let smallCartFee = 0;
      let surgeFee = 0;
      let surgeLabel: string | undefined;
      let tax = 0;
      let total = subtotal;
      let liveBill = false;

      if (subtotal > 0) {
        try {
          if (platform === 'blinkit' && blinkitToken && gpsCoords) {
            const slimItems = platformItems.map((ci) => ({
              product_id: String(ci.product.originalId || ci.product.id.replace('blinkit-', '')),
              quantity: ci.quantity
            }));

            // /v5/carts lives on blinkit.com and the gateway validates
            // AppVersion + DeviceID as required (case-sensitive whitelist),
            // so every plausible header-name variant is emitted — mirrors
            // blinkitCredHeaders in the reference extension.
            let deviceId = (await AsyncStorage.getItem('@blinkit_device_id')) || '';
            if (!deviceId) {
              deviceId = 'web-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
              await AsyncStorage.setItem('@blinkit_device_id', deviceId);
            }
            if (simulateNoAddress) {
              deviceId = 'sim-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
            }
            // The site's own cookie jar decides its fee arm — prefer the
            // device id embedded in those cookies over ours.
            const siteCookies = simulateNoAddress ? '' : ((await AsyncStorage.getItem('@blinkit_cookies')) || '');
            const devCookieM = siteCookies.match(/(?:^|;\s*)(?:device_id|deviceId)=([^;]+)/);
            if (devCookieM) deviceId = decodeURIComponent(devCookieM[1]);
            const atCookieM = siteCookies.match(/(?:^|;\s*)gr_1_accessToken=([^;]+)/);
            const siteAccessToken = atCookieM ? decodeURIComponent(atCookieM[1]) : '';
            const BLINKIT_APP_VERSION = '52434333';

            // Resolve the closest address from saved addresses based on the current GPS location
            let addrNum: number = NaN;
            let blLat = gpsLat;
            let blLng = gpsLng;

            if (!simulateNoAddress && gpsCoords) {
              try {
                const closestAddr = await this.getClosestBlinkitAddress(gpsLat, gpsLng);
                if (closestAddr && closestAddr.id) {
                  addrNum = Number(closestAddr.id);
                  await AsyncStorage.setItem('@blinkit_address_id', String(closestAddr.id));
                  await AsyncStorage.setItem('@blinkit_address_name', closestAddr.address || closestAddr.text || '');
                  const aLat = closestAddr.latitude || closestAddr.lat;
                  const aLng = closestAddr.longitude || closestAddr.lon || closestAddr.lng;
                  if (aLat && aLng) {
                    blLat = Number(aLat);
                    blLng = Number(aLng);
                    await AsyncStorage.setItem('@blinkit_lat', String(aLat));
                    await AsyncStorage.setItem('@blinkit_lng', String(aLng));
                  }
                } else {
                  await AsyncStorage.removeItem('@blinkit_address_id');
                  await AsyncStorage.removeItem('@blinkit_address_name');
                  await AsyncStorage.removeItem('@blinkit_lat');
                  await AsyncStorage.removeItem('@blinkit_lng');
                }
              } catch {
                const addrRaw = await AsyncStorage.getItem('@blinkit_address_id');
                if (addrRaw) addrNum = Number(addrRaw);
              }
            }

            const cartsBody = JSON.stringify({
              items: slimItems,
              ...(isFinite(addrNum) && addrNum && !simulateNoAddress ? { address_id: addrNum } : {}),
              promo_codes: ['']
            });

            // Preferred path: run INSIDE the hidden blinkit.com page so the
            // user's full cookie jar (HttpOnly included) prices the bill under
            // their real experiment arm. Falls back to the direct call below.
            // When simulateNoAddress is on, skip the bridge entirely so the
            // server sees no address context (replicates the APK no-address bug).
            let resJson: any = null;
            const bridgeHeaders: Record<string, string> = {
              'app_client': 'consumer_web',
              'auth_key': blinkitToken,
              'lat': String(blLat),
              'lon': String(blLng),
              'access_token': siteAccessToken,
              'Content-Type': 'application/json',
              'AppVersion': BLINKIT_APP_VERSION,
              'appversion': BLINKIT_APP_VERSION,
              'app_version': BLINKIT_APP_VERSION,
              'x-app-version': BLINKIT_APP_VERSION
            };
            let bridged = simulateNoAddress ? null : await requestViaBlinkitBridge(
              'https://blinkit.com/v5/carts',
              'POST',
              cartsBody,
              bridgeHeaders
            );
            // Retry on 429 (rate limited) with backoff — fresh APK installs
            // often hit rate limits because address APIs + cart POST fire together.
            if (bridged && bridged.status === 429) {
              await new Promise(r => setTimeout(r, 2000));
              bridged = await requestViaBlinkitBridge(
                'https://blinkit.com/v5/carts',
                'POST',
                cartsBody,
                bridgeHeaders
              );
            }
            if (bridged && bridged.status === 429) {
              await new Promise(r => setTimeout(r, 3000));
              bridged = await requestViaBlinkitBridge(
                'https://blinkit.com/v5/carts',
                'POST',
                cartsBody,
                bridgeHeaders
              );
            }
            if (bridged) {
              if (bridged.status === 200) {
                try { resJson = JSON.parse(bridged.text); } catch {}
              }
            }

            // The site prices its PERSISTENT cart via PUT /v5/carts/{id} —
            // fresh-cart POSTs land in a different fee cohort than the user's
            // established cart (observed: dc_25_0/hc_2 vs dc_30_0/hc_12/scc_20).
            let cartId = Number(
              resJson?.cart_id ?? resJson?.data?.cart_id ??
              resJson?.cart_data?.id ?? resJson?.data?.cart_data?.id ?? NaN
            );
            if (!isFinite(cartId) || !cartId) {
              // The hidden page's localStorage 'cart' holds the user's
              // persistent cart object (incl. its id) — the same cart the
              // site itself prices via PUT.
              const pageCartRaw = getBlinkitPageStorage('cart');
              if (pageCartRaw) {
                try {
                  const pc = JSON.parse(pageCartRaw);
                  cartId = Number(pc?.id ?? pc?.cart_id ?? pc?.cl_id ?? pc?.cartId ?? NaN);
                } catch {}
              }
            }
            if (!isFinite(cartId) || !cartId) {
              const storedCart = await AsyncStorage.getItem('@blinkit_cart_id');
              cartId = storedCart ? Number(storedCart) : NaN;
            }
            if (!isFinite(cartId) || !cartId) {
              // POST quotes are ephemeral (no id) — ask the site's session
              // which cart is currently active.
              const got = await requestViaBlinkitBridge('https://blinkit.com/v5/carts', 'GET', '', {
                'app_client': 'consumer_web',
                'auth_key': blinkitToken,
                'lat': String(blLat),
                'lon': String(blLng),
                'AppVersion': BLINKIT_APP_VERSION,
                'appversion': BLINKIT_APP_VERSION,
                'app_version': BLINKIT_APP_VERSION,
                'x-app-version': BLINKIT_APP_VERSION
              });
              if (got && got.status === 200) {
                try {
                  const gj = JSON.parse(got.text);
                  cartId = Number(
                    gj?.cart_id ?? gj?.data?.cart_id ??
                    gj?.cart_data?.id ?? gj?.data?.cart_data?.id ?? NaN
                  );
                } catch {}
              }
            }
            if (isFinite(cartId) && cartId) {
              await AsyncStorage.setItem('@blinkit_cart_id', String(cartId));
              // Mirror the site's own PUT headers exactly: access_token is the
              // URL-decoded gr_1_accessToken cookie, session_uuid stable per
              // install, platform mobile_web.
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
              const putRes = await requestViaBlinkitBridge(
                `https://blinkit.com/v5/carts/${cartId}`,
                'PUT',
                cartsBody,
                {
                  'app_client': 'consumer_web',
                  'auth_key': blinkitToken,
                  ...(accessToken ? { 'access_token': accessToken } : {}),
                  'session_uuid': sessionUuid,
                  'platform': 'mobile_web',
                  'qd_sdk_request': 'true',
                  'web_app_version': '1008010016',
                  'x-age-consent-granted': 'false',
                  'lat': String(blLat),
                  'lon': String(blLng),
                  'AppVersion': BLINKIT_APP_VERSION,
                  'appversion': BLINKIT_APP_VERSION,
                  'app_version': BLINKIT_APP_VERSION,
                  'x-app-version': BLINKIT_APP_VERSION
                }
              );
              if (putRes && putRes.status === 200) {
                try {
                  const putJson = JSON.parse(putRes.text);
                  resJson = putJson;
                } catch {}
              } else {
                if (putRes && (putRes.status === 404 || putRes.status === 410)) {
                  await AsyncStorage.removeItem('@blinkit_cart_id');
                }
              }
            }

            if (!resJson) {
              const response = await this.fetchWithTimeout('https://blinkit.com/v5/carts', {
                method: 'POST',
                headers: {
                  'Accept': 'application/json, text/plain, */*',
                  'app_client': 'consumer_web',
                  'auth_key': simulateNoAddress ? '' : blinkitToken,
                  'lat': String(blLat),
                  'lon': String(blLng),
                  'Content-Type': 'application/json',
                  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
                  'DeviceID': deviceId,
                  'device_id': deviceId,
                  'deviceid': deviceId,
                  'x-device-id': deviceId,
                  'AppVersion': BLINKIT_APP_VERSION,
                  'appversion': BLINKIT_APP_VERSION,
                  'app_version': BLINKIT_APP_VERSION,
                  'x-app-version': BLINKIT_APP_VERSION,
                  ...(!simulateNoAddress && siteCookies ? { 'Cookie': siteCookies } : {})
                },
                body: cartsBody
              }, 6000);

              if (response.ok) {
                resJson = await response.json();
              }
            }

            if (resJson) {
              const fees = parseBlinkitBill(resJson);
              if (fees.total !== null) {
                deliveryFee = fees.deliveryFee ?? 0;
                handlingFee = fees.handlingFee ?? 0;
                smallCartFee = fees.smallCartFee ?? 0;
                surgeFee = fees.surgeFee ?? 0;
                tax = fees.tax ?? 0;
                total = fees.total;
                liveBill = true;
              }
            }
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
              const storeParams = 'offset=0&ageConsent=false' +
                (storeInfo?.layoutId ? '&layoutId=' + encodeURIComponent(storeInfo.layoutId) : '') +
                '&voiceSearchTrackingId=' +
                '&storeId=' + encodeURIComponent(resolvedStoreId) +
                '&primaryStoreId=' + encodeURIComponent(storeInfo?.primaryStoreId || resolvedStoreId) +
                '&secondaryStoreId=' + encodeURIComponent(storeInfo?.secondaryStoreId || resolvedStoreId);

              const buildBody = (productId: any, itemId: any, spinId: any, qty: number) => ({
                productId,
                quantity: Math.max(1, Math.round(Number(qty) || 1)),
                tradeFreebie: false,
                spin: spinId || '',
                itemId,
                // meta.storeId is always the session store (the extension's
                // exact behavior — per-item store ids get baskets rejected)
                meta: { type: 'structure', storeId: resolvedStoreId, freebie: false, isGiftBag: false },
                serviceLine: 'INSTAMART',
                ...(shipmentIdV2 ? { shipmentIdV2 } : {})
              });

              // FAST PATH: reuse the catalog IDs captured during auto-match
              // (or from a source-Swiggy listing) — skips N catalog searches.
              let usedFastPath = platformItems.length > 0;
              let bodies: any[] = [];
              for (const ci of platformItems) {
                const src: any = ci.product.platformPrices?.swiggy || (ci.product.platform === 'swiggy' ? ci.product : null);
                if (!src || !src.productId || !src.originalId) { usedFastPath = false; break; }
                bodies.push(buildBody(src.productId, src.originalId, src.spinId, ci.quantity));
              }
              if (!usedFastPath) bodies = [];

              // Fallback builder: fresh search/v2 per item (concurrent pool).
              const freshSearchBodies = async (): Promise<{ bodies: any[]; unmappedName: string | null }> => {
              const searchItem = async (title: string, quantity: string): Promise<any> => {
                try {
                  const searchRes = await this.swiggyApiFetch(`https://www.swiggy.com/api/instamart/search/v2?${storeParams}`, 'POST', JSON.stringify({
                    facets: [],
                    sortAttribute: '',
                    query: title,
                    search_results_offset: '0',
                    page_type: 'INSTAMART_PRE_SEARCH_PAGE',
                    is_pre_search_tag: false
                  }));
                  if (searchRes.ok) {
                    const candidates = extractSwiggySearchProducts(await searchRes.json(), title);
                    return pickInstamartCandidate(candidates, title, quantity);
                  }
                  console.warn(`[Swiggy API Checkout] search failed (${searchRes.status}) for "${title}"`);
                } catch (e) {
                  console.warn(`[Swiggy API Checkout] search error for "${title}":`, e);
                }
                return null;
              };
              const SEARCH_POOL = 5;
              const searchResults: any[] = new Array(platformItems.length).fill(null);
              for (let start = 0; start < platformItems.length; start += SEARCH_POOL) {
                const slice = platformItems.slice(start, start + SEARCH_POOL);
                const settled = await Promise.all(slice.map(ci => searchItem(ci.product.title, ci.product.quantity)));
                settled.forEach((r, i) => { searchResults[start + i] = r; });
              }

                const outBodies: any[] = [];
                let unmappedInner: string | null = null;
                platformItems.forEach((ci, i) => {
                  const cand = searchResults[i];
                  if (!cand || !cand.productId || !cand.itemId) {
                    if (!unmappedInner) unmappedInner = ci.product.title;
                    return;
                  }
                  outBodies.push(buildBody(cand.productId, cand.itemId, cand.spinId, ci.quantity));
                });
                return { bodies: outBodies, unmappedName: unmappedInner };
              };

              let unmappedName: string | null = null;
              if (bodies.length === 0 && platformItems.length > 0) {
                const fresh = await freshSearchBodies();
                unmappedName = fresh.unmappedName;
                bodies = fresh.bodies;
              }

              if (unmappedName) {
                console.warn(`[Swiggy API Checkout] no catalog match for "${unmappedName}" — bill not priced`);
              } else if (bodies.length > 0) {
                // Bind the delivery address (closest saved address to GPS) so
                // the cart is priced for AND opened at the right location —
                // Swiggy resolves "select delivery address" from server cart
                // state, not the local store.
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
                    // The SPA binds an address the same way on change
                    // (updateCartAddressWithResetSlot): preferredAddressId +
                    // top-level addressId + location.
                    ...(deliveryFor?.id ? { addressId: deliveryFor.id } : {}),
                    ...(deliveryFor?.location ? { location: deliveryFor.location } : {})
                  },
                  source: 'userInitiated'
                }));

                  let postCartRes = await postBasket([resolvedStoreId], delivery);
                if (!postCartRes.ok) {
                  const rejText = (await postCartRes.text().catch(() => '')).slice(0, 300);
                  console.warn(`[Swiggy API Checkout] POST rejected (${postCartRes.status}): ${rejText}`);
                  // Rejected baskets are retried with the SPA's paired
                  // [primaryStoreId, secondaryStoreId] shape before giving up.
                  postCartRes = await postBasket([resolvedStoreId, resolvedStoreId], delivery);
                }
                if (!postCartRes.ok && usedFastPath) {
                  // Stale/wrong stored IDs are what Swiggy answers with
                  // "no valid items in cart" — rebuild via fresh search.
                  console.warn('[Swiggy API Checkout] cached IDs rejected — rebuilding basket via fresh search');
                  const freshRetry = await freshSearchBodies();
                  if (freshRetry.unmappedName) {
                    console.warn(`[Swiggy API Checkout] no catalog match for "${freshRetry.unmappedName}" — bill not priced`);
                  } else {
                    usedFastPath = false;
                    bodies = freshRetry.bodies;
                    postCartRes = await postBasket([resolvedStoreId], delivery);
                    if (!postCartRes.ok) {
                      const rejText2 = (await postCartRes.text().catch(() => '')).slice(0, 300);
                      console.warn(`[Swiggy API Checkout] POST rejected (${postCartRes.status}): ${rejText2}`);
                      postCartRes = await postBasket([resolvedStoreId, resolvedStoreId], delivery);
                    }
                  }
                }

                if (postCartRes.ok) {
                  const postCartJson = await postCartRes.json();

                  // Diagnose address intermittency: compare the address the
                  // bill was actually priced for vs the one we sent.
                  const billedAddrId = postCartJson?.data?.data?.addressId
                    ?? postCartJson?.data?.data?.address?.id
                    ?? postCartJson?.data?.data?.shippingAddressId
                    ?? null;
                  if (billedAddrId && delivery?.id && String(billedAddrId) !== String(delivery.id)) {
                    console.warn(`[Swiggy Address] MISMATCH: bill priced for address "${billedAddrId}" but we sent "${delivery.id}"`);
                  }

                  // The POST often only acknowledges the write — the bill then
                  // shows up on a fresh GET cart (exactly how the SPA renders
                  // its cart page), so look in both.
                  const applySwiggyFees = (b: any) => {
                    const fees = parseSwiggyBill(b);
                    if (fees.subtotal !== null) subtotal = fees.subtotal;
                    if (fees.deliveryFee !== null) deliveryFee = fees.deliveryFee;
                    if (fees.handlingFee !== null) handlingFee = fees.handlingFee;
                    if (fees.smallCartFee !== null) smallCartFee = fees.smallCartFee;
                    if (fees.surgeFee) surgeFee = fees.surgeFee;
                    if (fees.surgeLabel) surgeLabel = fees.surgeLabel;
                    if (fees.tax !== null) tax = fees.tax;
                    if (fees.total !== null) { total = fees.total; liveBill = true; }
                  };

                  let bill = findSwiggyBillNode(postCartJson);
                  if (!bill) {
                    try {
                      const refetchRes = await this.swiggyApiFetch(`${CART_URL}?pageType=INSTAMART_CART`);
                      if (refetchRes.ok) {
                        bill = findSwiggyBillNode(await refetchRes.json());
                      }
                    } catch (e) {
                      console.warn('[Swiggy API Checkout] bill refetch failed:', e);
                    }
                  }

                  if (bill) {
                    applySwiggyFees(bill);
                  } else {
                    // The POST ack's "User Addresses not found" message is
                    // normal for sessions without preferredAddressId; no bill
                    // anywhere means the session genuinely has no resolvable
                    // delivery address (user must select one in setup).
                    console.warn('[Swiggy API Checkout] no bill — session has no resolvable delivery address');
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

      const savings = originalSubtotal - subtotal;

      const calc: CartCalculation = {
        platform,
        items: platformItems,
        subtotal,
        deliveryFee,
        handlingFee,
        smallCartFee,
        surgeFee,
        surgeLabel,
        tax,
        total,
        savings: savings > 0 ? savings : 0,
        live: liveBill
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

function extractVariation(product: any, v: any, productId: string): any {
  if (!v || typeof v !== 'object') return null;
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
  let inStock = true;
  if (v.inventory && typeof v.inventory === 'object' && v.inventory.inStock === false) inStock = false;
  if (product.inStock === false) inStock = false;
  if (v.isAvail === false || product.isAvail === false) inStock = false;
  // Swiggy catalog IDs — the checkout API validates against these exact
  // spaces: itemId MUST be the variation's skuId (not v.id — see the
  // optimizer's background.js comment on treating these interchangeably),
  // spin comes from spinId ?? spin, never another id field.
  const itemIdVal = (typeof v.skuId === 'string' && v.skuId) ? v.skuId : '';
  const spinId = ((typeof v.spinId === 'string' && v.spinId) ? v.spinId
    : (typeof v.spin === 'string' && v.spin) ? v.spin : '');
  // Swiggy storeId: prefer v.storeId, fallback to v.podId
  const storeIdVal = (typeof v.storeId === 'string' || typeof v.storeId === 'number') ? String(v.storeId)
    : (typeof v.podId === 'string' || typeof v.podId === 'number') ? String(v.podId) : '';
  return {
    name: name,
    price: price,
    mrp: mrp,
    unit: unit,
    image: variationImage(product, v),
    type: 'product',
    productId: productId,
    itemId: itemIdVal,
    spinId: spinId,
    storeId: storeIdVal,
    inStock: inStock,
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
    if (Array.isArray(node.variations) && node.variations.length && typeof node.displayName === 'string') {
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
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return 'https://cdn.grofers.com' + url;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url)) {
    return 'https://cdn.grofers.com/da/cms-assets/cms/product/' + url + '.png';
  }
  if (url.indexOf('cdn-cgi') !== -1 || url.indexOf('grofers') !== -1 || url.indexOf('cms-assets') !== -1) {
    return 'https://cdn.grofers.com/' + url.replace(/^https?:\/\/cdn\.grofers\.com\//, '');
  }
  return 'https://cdn.grofers.com/cdn-cgi/image/f=auto,fit=scale-down,q=70,metadata=none,w=270/' + url;
}

export function parseBlinkitProducts(json: any): any[] {
  const out: any[] = [];
  if (!json || typeof json !== 'object') return out;
  const visited = new Set<any>();
  function walk(node: any) {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
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

    const rawImg = findBlinkitImageUrl(node, 0);
    image = formatBlinkitImageUrl(rawImg);

    if (name && typeof name === 'string' && price != null) {
      const numPrice = typeof price === 'number' ? price : Number((String(price).match(/\d[\d,]*/) || [])[0] || 0);
      const numMrp = typeof mrp === 'number' ? mrp : Number((String(mrp || price).match(/\d[\d,]*/) || [])[0] || 0);
      if (numPrice > 0 && name.length >= 3 && name.length <= 150) {
        let inStock = true;
        if (node.in_stock === false || node.is_available === false || node.available === false) inStock = false;
        if (inStock && typeof node.inventory === 'number' && node.inventory <= 0) inStock = false;
        if (inStock && node.inventory && typeof node.inventory === 'object' && node.inventory.in_stock === false) inStock = false;

        if (inStock) {
          const cleanName = String(name).trim();
          let cleanUnit = (unit && typeof unit === 'string') ? unit.trim() : '';
          let cartItem: any = null;
          try { cartItem = node.atc_action && node.atc_action.add_to_cart && node.atc_action.add_to_cart.cart_item; } catch {}
          if (!cartItem && node.cart_item) cartItem = node.cart_item;
          if (!cleanUnit && cartItem && (cartItem.unit || cartItem.variant)) {
            cleanUnit = String(cartItem.unit || cartItem.variant).trim();
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
            storeId: String((cartItem && (cartItem.pod_id || cartItem.store_id)) || '')
          });
        }
      }
    }

    const keys = Object.keys(node);
    for (let k = 0; k < keys.length; k++) {
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
  tax: number | null;
  total: number | null;
}

function parseBlinkitBill(json: any): BillFees {
  const cd = json?.cart_data || json?.data || json;
  let bill = cd?.bill_details || cd?.billDetails || cd?.bill || null;
  if (!bill && cd?.shipments?.[0]) {
    bill = cd.shipments[0].bill_details || cd.shipments[0].billDetails || null;
  }
  if (!bill) return { subtotal: null, deliveryFee: null, handlingFee: null, smallCartFee: null, surgeFee: 0, tax: null, total: null };

  const num = (v: any) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const m = v.match(/-?[\d,]+(?:\.\d+)?/);
      return m ? Number(m[0].replace(/,/g, '')) : null;
    }
    return null;
  };

  const getVal = (keys: string[]) => {
    for (const key of keys) {
      if (bill[key] !== undefined && bill[key] !== null) {
        const n = num(bill[key]);
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
  const slotSurge = bill.slot_charge != null ? num(bill.slot_charge) : null;
  const v2Surge = bill.surge_charge_v2?.surge_amount != null ? num(bill.surge_charge_v2.surge_amount) : null;

  return {
    subtotal: getVal(['total_cost', 'totalCost', 'item_total', 'items_total', 'subtotal', 'sub_total']),
    deliveryFee: getVal(['delivery_charge', 'deliveryCharge', 'delivery_charges', 'deliveryCharges', 'delivery_fee']),
    handlingFee: handlingCharge !== null ? handlingCharge : getVal(['additional_charge', 'additionalCharge', 'platform_fee', 'convenience_fee']),
    smallCartFee: smallCartCharge !== null ? smallCartCharge : 0,
    surgeFee: Math.max(slotSurge ?? 0, v2Surge ?? 0, acSurge ?? 0),
    surgeLabel: acSurgeLabel || undefined,
    tax: getVal(['total_tax_on_charges', 'totalTaxOnCharges', 'tax', 'gst']),
    total: getVal(['payable_amount', 'payableAmount', 'bill_total', 'billTotal', 'to_pay', 'toPay', 'grand_total', 'grandTotal'])
  };
}

export function instamartNormKey(s: any): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Pick the search-v2 variation that best matches a basket item (name first,
// pack size to break ties) — mirrors matchInstamartCandidate in the desktop
// grocery-order-optimizer extension. Requires some name overlap so a wrong
// product never gets priced in place of the real one.
export function pickInstamartCandidate(candidates: any[], name: string, unit: string): any | null {
  const nn = instamartNormKey(name);
  const nu = instamartNormKey(unit);
  let best: any = null;
  let bestScore = 0;
  for (const c of candidates) {
    const cn = instamartNormKey(c.name);
    const cu = instamartNormKey(c.unit);
    let score = 0;
    if (cn === nn) score += 20;
    else if (cn.indexOf(nn) === 0) score += 10;
    else if (nn.indexOf(cn) === 0) score += 8;
    else if (cn.indexOf(nn) !== -1 || nn.indexOf(cn) !== -1) score += 5;
    if (nu && cu === nu) score += 12;
    else if (nu && (cu.indexOf(nu) === 0 || nu.indexOf(cu) === 0)) score += 6;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 5 ? best : null;
}

// Locates the bill node in a checkout/v2/cart response. The documented spot
// (data.data.bill) is tried first, then a structural scan keyed on the bill's
// own numeric fields — Swiggy occasionally nests the bill deeper or returns
// only an ack on POST, with the bill arriving on the follow-up GET instead.
function findSwiggyBillNode(json: any): any | null {
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
function parseSwiggyBill(bill: any): BillFees {
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

  return {
    subtotal: num(bill.itemTotal),
    deliveryFee: chargeNet('deliveryCharge', 'deliveryFee')
      ?? num(bill.deliveryFeeAfterDiscount != null ? bill.deliveryFeeAfterDiscount : bill.deliveryCharges),
    handlingFee: (packaging !== null || convenience !== null)
      ? (packaging ?? 0) + (convenience ?? 0)
      : null,
    smallCartFee: chargeGross('smallCartCharges') ?? num(bill.smallCartCharges),
    surgeFee: surge,
    surgeLabel,
    tax: num(bill.gst),
    total: num(bill.toPay)
  };
}
