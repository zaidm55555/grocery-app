import { storage, Platform, LocationData } from './storage';
import { requestViaSwiggyBridge, isSwiggyBridgeConnected } from './swiggyBridge';
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

// Simulated data generator for fallback
const MOCK_PRODUCTS: Record<Platform, { title: string; brand: string; quantity: string; price: number; originalPrice: number; imageUrl: string }[]> = {
  blinkit: [
    { title: 'Amul Taaza Toned Milk', brand: 'Amul', quantity: '500 ml', price: 28, originalPrice: 28, imageUrl: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?auto=format&fit=crop&w=200&q=80' },
    { title: 'Nandini GoodLife UHT Milk', brand: 'Nandini', quantity: '1 L', price: 58, originalPrice: 58, imageUrl: 'https://images.unsplash.com/photo-1563636619-e9143da7973b?auto=format&fit=crop&w=200&q=80' },
    { title: 'Britannia Sandwich Bread', brand: 'Britannia', quantity: '400 g', price: 38, originalPrice: 45, imageUrl: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=200&q=80' },
    { title: 'Harvest Gold Brown Bread', brand: 'Harvest Gold', quantity: '400 g', price: 46, originalPrice: 50, imageUrl: 'https://images.unsplash.com/photo-1549931319-a545dcf3bc73?auto=format&fit=crop&w=200&q=80' },
    { title: 'Eggs Table White Pack', brand: 'Blinkit Select', quantity: '6 pcs', price: 42, originalPrice: 50, imageUrl: 'https://images.unsplash.com/photo-1506976785307-8732e854ad03?auto=format&fit=crop&w=200&q=80' },
    { title: 'Amul Salted Butter', brand: 'Amul', quantity: '100 g', price: 59, originalPrice: 60, imageUrl: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?auto=format&fit=crop&w=200&q=80' },
    { title: 'Amul Cheese Slices', brand: 'Amul', quantity: '10 pcs (200 g)', price: 138, originalPrice: 145, imageUrl: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?auto=format&fit=crop&w=200&q=80' },
  ],
  swiggy: [
    { title: 'Amul Taaza Toned Fresh Milk', brand: 'Amul', quantity: '500 ml', price: 28, originalPrice: 28, imageUrl: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?auto=format&fit=crop&w=200&q=80' },
    { title: 'Nandini GoodLife Premium Milk', brand: 'Nandini', quantity: '1 L', price: 57, originalPrice: 58, imageUrl: 'https://images.unsplash.com/photo-1563636619-e9143da7973b?auto=format&fit=crop&w=200&q=80' },
    { title: 'Britannia Jumbo Sandwich Bread', brand: 'Britannia', quantity: '400 g', price: 42, originalPrice: 45, imageUrl: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=200&q=80' },
    { title: 'Harvest Gold Brown Bread Premium', brand: 'Harvest Gold', quantity: '400 g', price: 47, originalPrice: 50, imageUrl: 'https://images.unsplash.com/photo-1549931319-a545dcf3bc73?auto=format&fit=crop&w=200&q=80' },
    { title: 'Egg First Premium Fresh Eggs', brand: 'Egg First', quantity: '6 pcs', price: 50, originalPrice: 60, imageUrl: 'https://images.unsplash.com/photo-1506976785307-8732e854ad03?auto=format&fit=crop&w=200&q=80' },
    { title: 'Amul Salted Butter Classic', brand: 'Amul', quantity: '100 g', price: 60, originalPrice: 60, imageUrl: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?auto=format&fit=crop&w=200&q=80' },
    { title: 'Amul Cheese Slices Value Pack', brand: 'Amul', quantity: '10 pcs (200 g)', price: 142, originalPrice: 145, imageUrl: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?auto=format&fit=crop&w=200&q=80' },
  ]
};

export const api = {
  fetchWithTimeout(url: string, options: RequestInit, timeout = 6000): Promise<Response> {
    return Promise.race([
      fetch(url, options),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('Network timeout')), timeout))
    ]);
  },

  /**
   * Swiggy Instamart APIs sit behind auth + WAF and reject calls made outside
   * a real page context (same constraint the desktop optimizer extension
   * documents), so requests are executed inside a hidden swiggy.com WebView
   * via requestViaSwiggyBridge. Falls back to a direct cookie-header fetch
   * when no page is connected.
   */
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
    console.warn('[Swiggy API Checkout] bridge not connected — falling back to direct fetch');
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

  /**
   * Universal Search Products across platforms.
   * Platforms are queried in parallel; onPlatformResults fires the moment a
   * single platform answers so the UI can render partial results without
   * waiting for both Blinkit and Swiggy.
   */
  async search(query: string, onPlatformResults?: (platform: Platform, results: UnifiedProduct[]) => void): Promise<UnifiedProduct[]> {
    const platforms: Platform[] = ['blinkit', 'swiggy'];
    const searchPromises = platforms.map(async (platform) => {
      const startedAt = Date.now();
      const token = await storage.getToken(platform);
      const location = await storage.getLocation();

      let results: UnifiedProduct[];
      if (!token) {
        // Return simulated products for this platform
        results = this.getSimulatedProducts(platform, query);
      } else {
        try {
          // Make the direct network fetch
          results = await this.fetchDirectAPI(platform, query, token, location);
        } catch (error) {
          console.warn(`Direct fetch failed for ${platform}, falling back to simulation.`, error);
          // Fall back to simulation but mark them as simulated
          results = this.getSimulatedProducts(platform, query).map(p => ({
            ...p,
            isSimulated: true
          }));
        }
      }

      console.log(`[timing] search "${query}" ${platform}: ${Date.now() - startedAt}ms (${results.length} items)`);
      onPlatformResults?.(platform, results);
      return results;
    });

    const allResults = await Promise.all(searchPromises);
    return allResults.flat();
  },

  /**
   * Search a single platform — used by the auto-matcher to find candidates
   * for the same product on the other apps. Empty array when no session.
   */
  async searchSingle(platform: Platform, query: string): Promise<UnifiedProduct[]> {
    const token = await storage.getToken(platform);
    if (!token) return [];
    const location = await storage.getLocation();
    try {
      return await this.fetchDirectAPI(platform, query, token, location);
    } catch (error) {
      console.warn(`[searchSingle] ${platform} failed for "${query}":`, error);
      return [];
    }
  },

  /**
   * Internal direct API calls
   */
  async fetchDirectAPI(platform: Platform, query: string, token: string, location: LocationData | null): Promise<UnifiedProduct[]> {
    const lat = location?.latitude || 12.9716;
    const lng = location?.longitude || 77.5946;

    // fetchWithTimeout is now a shared property on the api object

    if (platform === 'blinkit') {
      const q = encodeURIComponent(query);
      const url = `https://blinkit.com/v1/layout/search?offset=0&limit=60&actual_query=${q}&q=${q}&search_type=type_to_search`;

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'app_client': 'consumer_web',
          'auth_key': token,
          'lat': String(lat),
          'lon': String(lng),
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
      // Step 1: Discover store and layout info
      const homeStart = Date.now();
      const homeUrl = 'https://www.swiggy.com/api/instamart/home/v2?offset=0&storeId=&primaryStoreId=&secondaryStoreId=&clientId=INSTAMART-APP';
      const homeResponse = await this.fetchWithTimeout(homeUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Cookie': token,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
        }
      });

      console.log(`[Swiggy API Home] status: ${homeResponse.status} (${Date.now() - homeStart}ms)`);
      if (!homeResponse.ok) {
        throw new Error(`Swiggy home/v2 discovery error: ${homeResponse.status}`);
      }

      const homeJson = await homeResponse.json();
      const store = findStoreInfo(homeJson);
      console.log(`[Swiggy API Home] storeId: ${store.storeId}, layoutId: ${store.layoutId}`);

      if (!store.storeId) {
        throw new Error('No active Swiggy store ID discovered from your location');
      }

      // Step 2: Search products using discovered store params
      const params = 'offset=0&ageConsent=false' +
        (store.layoutId ? '&layoutId=' + encodeURIComponent(store.layoutId) : '') +
        '&voiceSearchTrackingId=' +
        '&storeId=' + encodeURIComponent(store.storeId) +
        '&primaryStoreId=' + encodeURIComponent(store.primaryStoreId || store.storeId) +
        '&secondaryStoreId=' + encodeURIComponent(store.secondaryStoreId || store.storeId);

      const searchUrl = `https://www.swiggy.com/api/instamart/search/v2?${params}`;
      const searchStart = Date.now();
      const searchResponse = await this.fetchWithTimeout(searchUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'Cookie': token,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
        },
        body: JSON.stringify({
          facets: [],
          sortAttribute: '',
          query: query,
          search_results_offset: '0',
          page_type: 'INSTAMART_PRE_SEARCH_PAGE',
          is_pre_search_tag: false
        })
      });

      console.log(`[Swiggy API Search] status: ${searchResponse.status} (${Date.now() - searchStart}ms)`);
      if (!searchResponse.ok) {
        throw new Error(`Swiggy search/v2 API error: ${searchResponse.status}`);
      }

      const searchJson = await searchResponse.json();
      const widgetList: any[] = searchJson?.data?.widgets || searchJson?.data?.searchResults?.widgets || searchJson?.widgets || [];
      console.log(`[Swiggy API Search] widgets: ${JSON.stringify(widgetList.map((w: any) => w.type || w.name).filter(Boolean).slice(0, 14))}`);
      const parsed = extractSwiggySearchProducts(searchJson, query);
      console.log(`[Swiggy API Search] parsed items: ${parsed.length}, sample product:`, parsed[0] ? { name: parsed[0].name, price: parsed[0].price, mrp: parsed[0].mrp } : 'none');
      if (parsed[0]) {
        console.log('[Swiggy Search IDs] First item:', {
          productId: parsed[0].productId,
          itemId: parsed[0].itemId,
          spinId: parsed[0].spinId,
          storeId: parsed[0].storeId
        });
      }

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
   * Helper to fetch simulated/mock data
   */
  getSimulatedProducts(platform: Platform, query: string): UnifiedProduct[] {
    const q = query.toLowerCase();
    const sourceList = MOCK_PRODUCTS[platform];
    const filtered = sourceList.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.brand.toLowerCase().includes(q) ||
      query === ''
    );

    // If query didn't match standard terms, generate dynamic search responses
    if (filtered.length === 0 && query !== '') {
      const capitalized = query.charAt(0).toUpperCase() + query.slice(1);
      return [
        {
          id: `${platform}-gen-1`,
          title: `${capitalized} Fresh Pack`,
          brand: `${platform.toUpperCase()} Premium`,
          quantity: '500 g',
          price: platform === 'blinkit' ? 85 : 92,
          originalPrice: 100,
          imageUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=200&q=80',
          platform,
          isSimulated: true
        },
        {
          id: `${platform}-gen-2`,
          title: `Organic ${capitalized} Selection`,
          brand: 'Organic Farm',
          quantity: '1 unit',
          price: platform === 'blinkit' ? 149 : 139,
          originalPrice: 180,
          imageUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=200&q=80',
          platform,
          isSimulated: true
        }
      ];
    }

    return filtered.map((p, index) => ({
      id: `${platform}-${index}-${p.title.replace(/\s+/g, '-').toLowerCase()}`,
      ...p,
      platform,
      isSimulated: true
    }));
  },

  /**
   * Post direct item add to cart or simulate it
   */
  async addToCart(platform: Platform, productId: string, quantity: number): Promise<boolean> {
    const token = await storage.getToken(platform);
    if (!token) return true; // Simulated success

    try {
      // Add implementations for Blinkit and Swiggy Instamart as needed
      return true;
    } catch {
      return false; // Fallback to local app simulation
    }
  },

  /**
   * Calculate Comparative Cart Totals.
   * Both platforms are priced in parallel; onPlatformResult fires as soon as
   * each platform's bill is resolved so the UI can show partial results.
   */
  async calculateCart(
    items: { product: UnifiedProduct; quantity: number }[],
    forceEstimate: boolean = false,
    onPlatformResult?: (calc: CartCalculation) => void
  ): Promise<CartCalculation[]> {
    const platforms: Platform[] = ['blinkit', 'swiggy'];
    const runStart = Date.now();

    const simulateNoAddress = (await AsyncStorage.getItem('@blinkit_simulate_no_address')) === '1';
    console.log(`[calculateCart] simulateNoAddress=${simulateNoAddress}`);

    // Load tokens and location in parallel
    const [blinkitToken, swiggyToken, storedLocation, bLat, bLng] = await Promise.all([
      storage.getToken('blinkit'),
      storage.getToken('swiggy'),
      storage.getLocation(),
      AsyncStorage.getItem('@blinkit_lat'),
      AsyncStorage.getItem('@blinkit_lng')
    ]);
    let location = storedLocation;
    // Blinkit store-level fees/surge are keyed to the delivery address's own
    // coordinates — prefer the ones captured with the saved address.
    if (bLat && bLng && !simulateNoAddress) {
      location = {
        latitude: parseFloat(bLat),
        longitude: parseFloat(bLng),
        address: storedLocation?.address || 'Bengaluru, Karnataka, India'
      };
    }
    const lat = location?.latitude ?? 12.9716;
    const lng = location?.longitude ?? 77.5946;

    const promises = platforms.map(async (platform) => {
      const platformStart = Date.now();
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

      if (subtotal > 0 && !forceEstimate) {
        console.log(`[calculateCart] platform: ${platform}, subtotal: ${subtotal}`);
        try {
          if (platform === 'blinkit' && blinkitToken) {
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

            // The saved address personalizes the bill (fee cohorts, delivery
            // constructs) — the reference extension always sends it when known.
            const addrRaw = simulateNoAddress ? '' : (await AsyncStorage.getItem('@blinkit_address_id'));
            const addrNum = addrRaw ? Number(addrRaw) : NaN;

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
            let billStatus = 0;
            const blPostStart = Date.now();
            if (simulateNoAddress) {
            }
            const bridgeHeaders: Record<string, string> = {
              'app_client': 'consumer_web',
              'auth_key': blinkitToken,
              'lat': String(lat),
              'lon': String(lng),
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
              billStatus = bridged.status;
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
              const blGetStart = Date.now();
              const got = await requestViaBlinkitBridge('https://blinkit.com/v5/carts', 'GET', '', {
                'app_client': 'consumer_web',
                'auth_key': blinkitToken,
                'lat': String(lat),
                'lon': String(lng),
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
              const blPutStart = Date.now();
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
                  'lat': String(lat),
                  'lon': String(lng),
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
                  billStatus = 200;
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
                  'lat': String(lat),
                  'lon': String(lng),
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
                billStatus = response.status;
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
          } else if (platform === 'swiggy' && swiggyToken) {
            // Same flow as the desktop grocery-order-optimizer extension:
            // GET the session cart for its metadata, resolve every basket item
            // against Swiggy's own catalog (stored IDs when present, otherwise
            // a fresh search/v2 lookup), POST the EXACT basket to
            // checkout/v2/cart, then read every charge straight off the bill
            // JSON (itemTotal, delivery, packaging/convenience, small-cart,
            // gst tax line, toPay). All calls run inside a real swiggy.com
            // page context (SwiggyBridgeWebView) — no display scraping, no
            // estimated rates.
            const CART_URL = 'https://www.swiggy.com/api/instamart/checkout/v2/cart';
            const HOME_URL = 'https://www.swiggy.com/api/instamart/home/v2?offset=0&storeId=&primaryStoreId=&secondaryStoreId=&clientId=INSTAMART-APP';

            let shipmentIdV2 = '';
            let cartMetaData = {
              contactlessDelivery: false,
              deliveryType: 'INSTANT',
              ageConsentProvided: false,
              useGiftBagPackaging: false
            };
            let storeInfo: SwiggyStoreInfo | null = null;

            // Store/session metadata is stable per location — cache it so the
            // expensive checkout/v2/cart GET (observed 0.6–10s, occasionally
            // stalling the whole bridge) can be skipped on later runs.
            const locKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
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
                console.log('[Swiggy API Checkout] using cached store metadata — skipping session GET');
              }
            } catch {}

            if (!storeInfo) {
            try {
              const swGetCartStart = Date.now();
              const getCartRes = await this.swiggyApiFetch(`${CART_URL}?pageType=INSTAMART_CART`);

              console.log(`[Swiggy API Checkout] GET status: ${getCartRes.status} (${Date.now() - swGetCartStart}ms)`);
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

            if (!storeInfo) {
              try {
                const swHomeStart = Date.now();
                const homeResponse = await this.swiggyApiFetch(HOME_URL);
                console.log(`[Swiggy API Checkout] home/v2 status: ${homeResponse.status} (${Date.now() - swHomeStart}ms)`);
                if (homeResponse.ok) {
                  storeInfo = findStoreInfo(await homeResponse.json());
                }
              } catch (e) {
                console.warn('[Swiggy API Checkout] home/v2 discovery failed:', e);
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
                const itemSearchStart = Date.now();
                try {
                  const searchRes = await this.swiggyApiFetch(`https://www.swiggy.com/api/instamart/search/v2?${storeParams}`, 'POST', JSON.stringify({
                    facets: [],
                    sortAttribute: '',
                    query: title,
                    search_results_offset: '0',
                    page_type: 'INSTAMART_PRE_SEARCH_PAGE',
                    is_pre_search_tag: false
                  }));
                  console.log(`[timing] swiggy catalog search "${title.slice(0, 24)}": ${Date.now() - itemSearchStart}ms (status: ${searchRes.status})`);
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
                console.log(`[Swiggy API Checkout] POST basket:`, JSON.stringify(bodies));
                const swPostStart = Date.now();
                const postBasket = async (storeIds: string[], preferredAddressId: any = null) => this.swiggyApiFetch(CART_URL, 'POST', JSON.stringify({
                  data: {
                    items: bodies,
                    cartMetaData: {
                      contactlessDelivery: cartMetaData.contactlessDelivery,
                      deliveryType: cartMetaData.deliveryType,
                      owner: 'APP',
                      preferredAddressId,
                      ageConsentProvided: cartMetaData.ageConsentProvided,
                      useGiftBagPackaging: cartMetaData.useGiftBagPackaging,
                      useReusablePackaging: false,
                      incognitoCart: false,
                      includeConsents: ['PHARMA'],
                      primaryStoreId: resolvedStoreId,
                      storeIds
                    },
                    cartType: 'INSTAMART'
                  },
                  source: 'userInitiated'
                }));

                  let postCartRes = await postBasket([resolvedStoreId]);
                if (!postCartRes.ok) {
                  const rejText = (await postCartRes.text().catch(() => '')).slice(0, 300);
                  console.warn(`[Swiggy API Checkout] POST rejected (${postCartRes.status}): ${rejText}`);
                  // Rejected baskets are retried with the SPA's paired
                  // [primaryStoreId, secondaryStoreId] shape before giving up.
                  postCartRes = await postBasket([resolvedStoreId, resolvedStoreId]);
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
                    postCartRes = await postBasket([resolvedStoreId]);
                    if (!postCartRes.ok) {
                      const rejText2 = (await postCartRes.text().catch(() => '')).slice(0, 300);
                      console.warn(`[Swiggy API Checkout] POST rejected (${postCartRes.status}): ${rejText2}`);
                      postCartRes = await postBasket([resolvedStoreId, resolvedStoreId]);
                    }
                  }
                }

                console.log(`[Swiggy API Checkout] POST status: ${postCartRes.status} (${Date.now() - swPostStart}ms incl. retries)`);
                if (postCartRes.ok) {
                  const postCartJson = await postCartRes.json();

                  // The POST often only acknowledges the write — the bill then
                  // shows up on a fresh GET cart (exactly how the SPA renders
                  // its cart page), so look in both.
                  const applySwiggyFees = (b: any) => {
                    const fees = parseSwiggyBill(b);
                    console.log(`[Swiggy API Checkout] Bill parsed:`, fees);
                    // Dev-only: inspect how waivers/discounts are encoded.
                    console.log(`[Swiggy API Checkout] charges: ${JSON.stringify(b?.charges)?.slice(0, 2000)}`);
                    // Dev-only: surface ANY surge/rain-shaped field wherever
                    // it hides in the bill tree.
                    try {
                      const s = JSON.stringify(b);
                      const hits = s.match(/"[^"]*(?:surge|rain)[^"]*"\s*:\s*("[^"]*"|[\d.]+|true|false|null)/gi);
                      console.log(`[Swiggy API Checkout] surge/rain fields: ${hits ? hits.slice(0, 15).join(' | ') : 'NONE'}`);
                    } catch {}
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
                      console.log(`[Swiggy API Checkout] bill refetch GET status: ${refetchRes.status}`);
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

      console.log(`[timing] calculateCart ${platform}: ${Date.now() - platformStart}ms (live bill: ${liveBill ? 'yes' : 'no'})`);

      onPlatformResult?.(calc);
      return calc;
    });

    const results = await Promise.all(promises);
    console.log(`[timing] calculateCart TOTAL: ${Date.now() - runStart}ms`);
    return results;
  }
};

// ==========================================
// --- Production Direct API Helper Parsers ---
// ==========================================

// --- Swiggy Helpers ---
interface SwiggyStoreInfo {
  storeId: string;
  primaryStoreId: string;
  secondaryStoreId: string;
  layoutId: string;
}

function findStoreInfo(json: any): SwiggyStoreInfo {
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

function extractSwiggySearchProducts(json: any, query?: string): any[] {
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
      // Log raw first variation to understand real field names from Swiggy API
      if (out.length === 0 && node.variations[0]) {
        console.log('[Swiggy extractVariation] RAW first variation keys:', Object.keys(node.variations[0]));
        console.log('[Swiggy extractVariation] RAW first variation sample:', JSON.stringify(node.variations[0]).slice(0, 400));
      }
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

function parseBlinkitProducts(json: any): any[] {
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
          try { cartItem = node.atc_action && node.atc_action.add_to_cart && node.atc_action.add_to_cart.cart_item; } catch (e) {}
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

function instamartNormKey(s: any): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Pick the search-v2 variation that best matches a basket item (name first,
// pack size to break ties) — mirrors matchInstamartCandidate in the desktop
// grocery-order-optimizer extension. Requires some name overlap so a wrong
// product never gets priced in place of the real one.
function pickInstamartCandidate(candidates: any[], name: string, unit: string): any | null {
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
