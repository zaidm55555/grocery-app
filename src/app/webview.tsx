import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, RotateCw } from 'lucide-react-native';
import { storage, Platform } from '../services/storage';
import { setSwiggySetupMode } from '../services/swiggyBridgeUi';
import { notifyBlinkitBridgeCookies, reloadBlinkitBridge } from '../services/blinkitBridge';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Builds the injected script that (1) disables + unregisters Blinkit's
// service worker (its stale cache is what served the blank white screen and
// broken CSS after the reload), (2) replays the captured session cookies into
// this visible page, (3) writes the resolved basket into localStorage['cart']
// preserving keys it doesn't own, and (4) reloads ONLY once the service worker
// is unregistered so the fresh assets load instead of a cached shell.
function buildBlinkitExportCartScript(cartB64: string, cookieStr: string): string {
  const js = `
  (function(){
    var reloaded = false;
    function doReload(){ if (reloaded) return; reloaded = true; try { window.location.reload(); } catch(e) {} }

    function applyCart() {
      var raw = '';
      try {
        var s = ${JSON.stringify(cartB64)}.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) { s += '='; }
        raw = decodeURIComponent(escape(window.atob(s)));
      } catch(e) {}
      var cart = {};
      try { cart = JSON.parse(raw) || {}; } catch(e) { cart = {}; }

      // Replay non-HttpOnly session cookies (same mirror the hidden bridge
      // uses) so the page sees the user's logged-in session.
      var parts = String(${JSON.stringify(cookieStr)}).split(/;\\s*/);
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var eq = parts[i].indexOf('=');
        if (eq <= 0) continue;
        try { document.cookie = parts[i] + '; path=/; domain=.blinkit.com; secure; SameSite=None'; } catch(e2) {}
      }

      // Persist the basket exactly as the extension does (items, count,
      // total, uniqueSkuInCart) while preserving the live cart's other keys.
      var existing = null;
      try { existing = JSON.parse(localStorage.getItem('cart')) || {}; } catch(e3) {}
      var merged = existing;
      for (var k in cart) { if (cart.hasOwnProperty(k)) merged[k] = cart[k]; }
      try {
        localStorage.setItem('cart', JSON.stringify(merged));
        localStorage.setItem('count', String(cart.count || 0));
        localStorage.setItem('total', String(cart.total || 0));
        localStorage.setItem('uniqueSkuInCart', String(cart.uniqueSkuInCart || 0));
      } catch(e4) {}
      window.__bbExportReady = true;
    }

    applyCart();

    // Disable + unregister the service worker so the upcoming reload is not
    // served from its stale cache (root cause of the blank white page and
    // broken basket CSS). Reload only after unregistration resolves.
    try {
      navigator.serviceWorker.register = function(){ return Promise.reject(new Error('sw-disabled')); };
    } catch(e6) {}
    try {
      navigator.serviceWorker.getRegistrations().then(function(rs){
        var list = Array.prototype.slice.call(rs || []);
        if (!list.length) { doReload(); return; }
        var remain = list.length;
        list.forEach(function(r){
          var done = function(){ remain--; if (remain <= 0) doReload(); };
          try { r.unregister().then(done, done); } catch(e7) { done(); }
        });
      }).catch(function(){ doReload(); });
      // Safety net: never get stuck if getRegistrations hangs.
      setTimeout(doReload, 4000);
    } catch(e5) { doReload(); }
    setTimeout(doReload, 5000);
  })();
  `;
  return js;
}

// After the export reload, land the user on Blinkit's dedicated cart page so
// they can review and checkout. The SPA reads the basket we wrote into
// localStorage['cart'] when it hydrates /cart. The service worker is already
// killed, so navigating to /cart loads fresh assets (not a cached shell).
function buildBlinkitOpenCartScript(): string {
  const js = `
  (function(){
    function goCart() {
      var target = '/cart';
      try {
        var base = window.location.origin || 'https://blinkit.com';
        if (String(window.location.pathname).indexOf('/cart') === 0) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_CART_OPENED' })); return true; }
        window.location.assign(base + target);
        return true;
      } catch(e) { return false; }
    }
    if (goCart()) {
      // Wait for the cart route to actually be current before signalling the
      // RN side that the redirect completed.
      var iv = setInterval(function(){
        if (String(window.location.pathname).indexOf('/cart') === 0) {
          clearInterval(iv);
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_CART_OPENED' }));
        }
      }, 500);
      setTimeout(function(){ clearInterval(iv); }, 15000);
    }
  })();
  `;
  return js;
}

export default function WebViewScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const platform = (params.platform as Platform) || 'blinkit';
  const isExport = params.mode === 'export';
  const launchedSwiggySession = useRef(false);
  const [loading, setLoading] = useState(true);
  const webViewRef = useRef<WebView>(null);
  const cartAppliedRef = useRef(isExport ? false : true);

  // Swiggy login/address work happens inside the single persistent bridge
  // WebView (its cookie jar is what prices carts), so just expand it.
  useEffect(() => {
    if (platform === 'swiggy' && !launchedSwiggySession.current) {
      launchedSwiggySession.current = true;
      setSwiggySetupMode(params.mode === 'address' ? 'address' : 'login');
      router.back();
    }
  }, [platform, params.mode, router]);

  // Blinkit export: replay the captured session cookies into a visible
  // Blinkit page, write the resolved basket into localStorage['cart'], reload
  // so the SPA hydrates, then open the cart drawer (openCartFn /
  // cartDrawerOpenFn — the only DOM step, per the reference extension).
  const exportCartB64 = isExport ? String(params.cart || '') : '';

  useEffect(() => {
    if (!isExport || platform !== 'blinkit') return;
    if (!exportCartB64) return;

    let applied = false;
    const injectCookieAndCart = async () => {
      if (applied || cartAppliedRef.current) return;
      let cookieStr = '';
      try {
        cookieStr = (await AsyncStorage.getItem('@blinkit_cookies')) || '';
      } catch {}
      cartAppliedRef.current = true;
      applied = true;
      webViewRef.current?.injectJavaScript(
        buildBlinkitExportCartScript(exportCartB64, cookieStr)
      );
    };
    const timer = setTimeout(injectCookieAndCart, 1500);
    return () => clearTimeout(timer);
  }, [isExport, platform, exportCartB64]);

  const platformMeta = {
    blinkit: {
      name: 'Blinkit',
      url: 'https://blinkit.com/',
      primaryColor: '#F7EC13',
      injectScript: `
        (function() {
          let buf = [];
          const rec = (u, m, b, r, h) => {
            try {
              u = String(u);
              let host = '';
              try { host = new URL(u).hostname; } catch (e0) { return; }
              if (!/(^|\.)blinkit\.com$/.test(host)) return;
              // Log ALL Blinkit API calls (not just cart) — we need to
              // discover the address endpoint. Exclude static assets.
              if (/\\.js$|\\.css$|\\.png$|\\.svg$|\\.woff|analytics|beacon|collect|perf/i.test(u)) return;
              if (buf.length >= 40) return;
              buf.push({ m: m || 'GET', u: u.slice(0, 300), h: h ? String(h).slice(0, 900) : '', b: b ? String(b).slice(0, 2500) : '', r: r ? String(r).slice(0, 4500) : '' });
            } catch (e2) {}
          };
          if (!window.__blRec) {
            window.__blRec = true;
            try {
              navigator.serviceWorker.register = () => Promise.reject(new Error('sw-disabled'));
              navigator.serviceWorker.getRegistrations().then((rs) => {
                if (!rs.length) return;
                rs.forEach((r) => r.unregister());
                if (!sessionStorage.getItem('__blSwKilled')) {
                  sessionStorage.setItem('__blSwKilled', '1');
                  location.reload();
                }
              }).catch(() => {});
            } catch (e6) {}
            const of_ = window.fetch;
            if (of_) {
              window.fetch = function(input, init) {
                const u = (typeof input === 'string') ? input : (input && input.url) || '';
                const m = (init && init.method) || (input && input.method) || 'GET';
                const b = init && init.body;
                let hh = '';
                try {
                  const srcH = (init && init.headers) || (input && input.headers);
                  if (srcH && typeof srcH.forEach === 'function') srcH.forEach((v, k) => { hh += k + ': ' + v + '; '; });
                } catch (e3) {}
                return of_.apply(this, arguments).then((res) => {
                  try { res.clone().text().then((t) => rec(u, m, b, t, hh)).catch(() => {}); } catch (e4) {}
                  return res;
                });
              };
            }
            const ox = XMLHttpRequest.prototype.open;
            const os = XMLHttpRequest.prototype.send;
            const osrh = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.open = function(mm, uu) { this.__blM = mm; this.__blU = uu; this.__blH = ''; return ox.apply(this, arguments); };
            XMLHttpRequest.prototype.setRequestHeader = function(k, v) { this.__blH = (this.__blH || '') + k + ': ' + v + '; '; return osrh.apply(this, arguments); };
            XMLHttpRequest.prototype.send = function(bb) {
              this.addEventListener('load', () => { try { rec(this.__blU, this.__blM, bb, this.responseText, this.__blH); } catch (e5) {} });
              return os.apply(this, arguments);
            };
          }

          var tokenFound = false;
          var sentAddress = false;
          var sentDump = false;
          var sentSuccess = false;
          var addrFound = false;

          function extractAddrFromStorage() {
            // Check selected_address_id
            var aid = sessionStorage.getItem('selected_address_id')
              || localStorage.getItem('selected_address_id')
              || localStorage.getItem('address_id') || '';
            if (aid) {
              sentAddress = true;
              addrFound = true;
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_ADDRESS', addressId: String(aid) }));
            }
            // Sweep all storage keys for address data
            [window.localStorage, window.sessionStorage].forEach(function(store, si) {
              for (var i = 0; i < store.length; i++) {
                var k = String(store.key(i));
                if (/address|location/i.test(k)) {
                  var v = '';
                  try { v = String(store.getItem(k)); } catch (e2) {}
                  if (v.length > 10) {
                    var m = v.match(/"id"\\s*:\\s*(\\d{5,})/);
                    if (m) {
                      addrFound = true;
                      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_ADDRESS', addressId: m[1] }));
                    }
                    var latM = v.match(/"latitude"\\s*:\\s*([\\d.]+)/);
                    var lngM = v.match(/"longitude"\\s*:\\s*([\\d.]+)/);
                    if (latM && lngM) {
                      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_LATLNG', lat: latM[1], lng: lngM[1] }));
                    }
                  }
                }
              }
            });
          }

          function tryFetchAddresses(token, lat, lng, deviceId) {
            var curLat = lat || '12.9716';
            var curLng = lng || '77.5946';
            var url = 'https://blinkit.com/v4/address?cur_lat=' + curLat + '&cur_lon=' + curLng;
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_ADDR_DEBUG', url: url, status: 'fetching', token: token ? token.slice(0, 30) + '...' : 'none' }));
            fetch(url, {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'access_token': token,
                'auth_key': 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
                'app_client': 'consumer_web',
                'lat': curLat,
                'lon': curLng,
                'device_id': deviceId,
                'platform': 'mobile_web'
              }
            }).then(function(r) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_ADDR_DEBUG', url: url, status: r.status }));
              if (!r.ok) return null;
              return r.text();
            }).then(function(t) {
              if (!t) return;
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_ADDR_DEBUG', url: url, body: t.slice(0, 3000) }));
              try {
                var aj = JSON.parse(t);
                // Response may be { addresses: [...] } or { data: [...] } or flat object
                var list = aj.addresses || aj.data || aj.addresses_data || (Array.isArray(aj) ? aj : null);
                if (list && !Array.isArray(list) && list.addresses_data) list = list.addresses_data;
                if (Array.isArray(list) && list.length) {
                  var a = list[0];
                  var addrId = a.id || a.address_id || '';
                  var aLat = a.latitude || a.lat || '';
                  var aLng = a.longitude || a.lng || a.lon || '';
                  if (addrId) {
                    addrFound = true;
                    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_ADDRESS', addressId: String(addrId) }));
                  }
                  if (aLat && aLng) {
                    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_LATLNG', lat: String(aLat), lng: String(aLng) }));
                  }
                }
              } catch (e) {}
            }).catch(function(e) {
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_ADDR_DEBUG', url: url, error: String(e) }));
            });
          }

          var checkCount = 0;
          var successSent = false;
          const checkToken = setInterval(function() {
            try {
              checkCount++;
              // Re-sweep service workers
              try {
                navigator.serviceWorker.getRegistrations().then(function(rs) { rs.forEach(function(r) { r.unregister(); }); }).catch(function() {});
              } catch (e7) {}

              // Ship network log
              if (buf.length) {
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_NETLOG', entries: buf.splice(0, buf.length) }));
              }

              // Keep scanning localStorage for address data every tick
              extractAddrFromStorage();

              var accessToken = '';
              try {
                var authRaw = localStorage.getItem('auth');
                if (authRaw) { var authObj = JSON.parse(authRaw); accessToken = authObj.accessToken || ''; }
              } catch (e) {}
              if (!accessToken) accessToken = localStorage.getItem('token') || localStorage.getItem('auth_token') || '';
              var deviceId = localStorage.getItem('deviceId') || 'basketbuddy_' + Date.now();
              if (accessToken && !tokenFound) {
                tokenFound = true;
                // Try to fetch addresses from Blinkit /v4/address API
                var storedLat = localStorage.getItem('selected_lat') || localStorage.getItem('latitude') || '';
                var storedLng = localStorage.getItem('selected_lng') || localStorage.getItem('longitude') || '';
                tryFetchAddresses(accessToken, storedLat, storedLng, deviceId);
              }

              // Send SUCCESS once we have a token. If we already found an
              // address OR after 10 seconds of polling, close.
              if (accessToken && !successSent && (addrFound || checkCount >= 10)) {
                successSent = true;
                clearInterval(checkToken);
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'SUCCESS', token: accessToken, cookie: document.cookie, address: null
                }));
              }
            } catch (e) {}
          }, 1000);
        })();
      `
    },
    swiggy: {
      name: 'Swiggy Instamart',
      url: 'https://www.swiggy.com/instamart',
      primaryColor: '#FC8019',
      injectScript: `
        (function() {
          const checkToken = setInterval(() => {
            try {
              const cookies = document.cookie;
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'DEBUG_COOKIES', cookies: cookies }));
              if (cookies.includes('_is_logged_in=1')) {
                clearInterval(checkToken);
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SUCCESS', token: cookies }));
                return;
              }
            } catch (e) {}
          }, 1500);
        })();
      `
    }
  };

  const currentMeta = platformMeta[platform];

  const isExportMode = isExport && platform === 'blinkit';
  const exportCookie = isExport ? '' : '';
  void exportCookie;

  const handleMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'DEBUG_COOKIES') {
        return;
      }
      if (data.type === 'BLINKIT_NETLOG') {
        return;
      }
      if (data.type === 'BLINKIT_CART_OPENED') {
        // The export completed and we've landed on Blinkit's cart page — keep
        // the webview open there so the user can review/checkout. (No app-side
        // redirect: the user wants to remain on the Blinkit cart, not return
        // to the app basket.)
        return;
      }
      if (data.type === 'BLINKIT_ADDRESS' && data.addressId) {
        await AsyncStorage.setItem('@blinkit_address_id', String(data.addressId));
        return;
      }
      if (data.type === 'BLINKIT_LATLNG' && data.lat && data.lng) {
        await AsyncStorage.setItem('@blinkit_lat', String(data.lat));
        await AsyncStorage.setItem('@blinkit_lng', String(data.lng));
        return;
      }
      if (data.type === 'BLINKIT_ADDR_DEBUG') {
        return;
      }
      if (data.type === 'BLINKIT_STORAGE_DUMP') {
        console.log(`[Blinkit WebView] storage dump: ${JSON.stringify(data.entries).slice(0, 3000)}`);
        // Auto-extract the saved address id. Values are truncated slices, so
        // JSON.parse can fail — fall back to scanning the raw text. Inside an
        // addresses_data record the bare "id" field precedes everything else.
        for (const e of (data.entries || []) as any[]) {
          if (!/address/i.test(String(e.k))) continue;
          const raw = String(e.v || '');
          let id: string | null = null;
          try {
            const parsed = JSON.parse(raw);
            const records = parsed?.addresses?.addresses_data || parsed?.addresses_data || (Array.isArray(parsed) ? parsed : null);
            const rec = Array.isArray(records) ? records[0] : null;
            if (rec && /^\d{2,}$/.test(String(rec.id ?? rec.address_id ?? ''))) {
              id = String(rec.id ?? rec.address_id);
            }
          } catch {}
          if (!id) {
            // Lazy match with no distance cap — records carry long fields
            // (line2, location_info…) before the id shows up.
            const m = raw.match(/"addresses_data"\s*:\s*\[[\s\S]*?"\bid"\s*:\s*(\d{5,})/)
              || raw.match(/[\s\S]*?"\bid"\s*:\s*(\d{5,})/);
            if (m) id = m[1];
          }
          if (id) {
            await AsyncStorage.setItem('@blinkit_address_id', id);
            const latM = raw.match(/"latitude"\s*:\s*([\d.]+)/);
            const lngM = raw.match(/"longitude"\s*:\s*([\d.]+)/);
            if (latM && lngM) {
              await AsyncStorage.setItem('@blinkit_lat', latM[1]);
              await AsyncStorage.setItem('@blinkit_lng', lngM[1]);
            }
            break;
          }
        }
        return;
      }
      if (data.type === 'SUCCESS' && data.token) {
        await storage.saveToken(platform, data.token);
        if (platform === 'blinkit' && data.cookie) {
          // Replay the site's own cookie jar (its device cookies decide the
          // fee-experiment arm and surge eligibility).
          await AsyncStorage.setItem('@blinkit_cookies', String(data.cookie).slice(0, 3000));
          notifyBlinkitBridgeCookies(String(data.cookie));
        }
        // Auto-capture address from the Blinkit addresses API response.
        if (platform === 'blinkit' && data.address) {
          const addr = data.address;
          const addrId = String(addr.id ?? addr.address_id ?? '');
          if (addrId && /^\d{2,}$/.test(addrId)) {
            await AsyncStorage.setItem('@blinkit_address_id', addrId);
          }
          const lat = addr.latitude ?? addr.lat;
          const lng = addr.longitude ?? addr.lng ?? addr.lon;
          if (lat && lng) {
            await AsyncStorage.setItem('@blinkit_lat', String(lat));
            await AsyncStorage.setItem('@blinkit_lng', String(lng));
          }
        }
        // Automatically fetch and save dummy coordinates if not set to mimic full session
        const existingLocation = await storage.getLocation();
        if (!existingLocation) {
          // Prefer the Blinkit address coords when available
          const bLat = await AsyncStorage.getItem('@blinkit_lat');
          const bLng = await AsyncStorage.getItem('@blinkit_lng');
          await storage.saveLocation({
            latitude: bLat ? parseFloat(bLat) : 12.9716,
            longitude: bLng ? parseFloat(bLng) : 77.5946,
            address: 'Bengaluru, Karnataka, India'
          });
        }
        alert(`${currentMeta.name} Linked successfully!`);
        if (platform === 'blinkit') {
          setTimeout(() => reloadBlinkitBridge(), 500);
        }
        router.back();
      }
    } catch (err) {
    }
  };

  const reloadPage = () => {
    webViewRef.current?.reload();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <ArrowLeft size={24} color="#FFF" />
        </TouchableOpacity>
        <View style={styles.titleContainer}>
          <Text style={styles.headerTitle}>{isExportMode ? 'Export to Blinkit' : `Link ${currentMeta.name}`}</Text>
          <Text style={styles.headerSubtitle}>
            {isExportMode ? 'Basket written — cart will open on the site' : 'Login to sync account'}
          </Text>
        </View>
        <TouchableOpacity style={styles.reloadButton} onPress={reloadPage}>
          <RotateCw size={20} color="#FFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.webContainer}>
        <WebView
          ref={webViewRef}
          source={{ uri: currentMeta.url }}
          injectedJavaScript={isExportMode ? undefined : currentMeta.injectScript}
          onLoadEnd={() => {
            // Export: after the cart is written + page reloads, open the
            // cart drawer so the user lands on their ready checkout.
            if (isExportMode && cartAppliedRef.current) {
              setTimeout(() => {
                webViewRef.current?.injectJavaScript(buildBlinkitOpenCartScript());
              }, 600);
            }
          }}
          onMessage={handleMessage}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          sharedCookiesEnabled={true}
          userAgent="Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Mobile Safari/537.36"
          startInLoadingState={true}
          renderLoading={() => (
            <View style={styles.loaderContainer}>
              <ActivityIndicator size="large" color={currentMeta.primaryColor} />
              <Text style={styles.loaderText}>
                {isExportMode ? 'Opening your Blinkit basket…' : 'Loading secure browser...'}
              </Text>
            </View>
          )}
        />
      </View>

      <View style={styles.footer}>
        <View style={[styles.indicatorBall, { backgroundColor: currentMeta.primaryColor }]} />
        <Text style={styles.footerText}>
          {isExportMode
            ? 'Your optimized basket is now in Blinkit. Review it, add the delivery address if asked, and place the order.'
            : 'Enter phone number & verify OTP. The app will capture the token and close automatically.'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0F0F12',
  },
  header: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1F1F24',
    backgroundColor: '#0F0F12',
  },
  backButton: {
    padding: 4,
  },
  titleContainer: {
    flex: 1,
    marginLeft: 16,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  reloadButton: {
    padding: 6,
  },
  webContainer: {
    flex: 1,
    backgroundColor: '#FFF',
    position: 'relative',
  },
  loaderContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 15, 18, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loaderText: {
    marginTop: 12,
    color: '#FFF',
    fontSize: 14,
    fontWeight: '500',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#16161D',
    borderTopWidth: 1,
    borderTopColor: '#272730',
  },
  indicatorBall: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 12,
  },
  footerText: {
    flex: 1,
    fontSize: 12,
    color: '#A0AEC0',
    lineHeight: 16,
  },
});
