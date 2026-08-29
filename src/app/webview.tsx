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
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'BLINKIT_CART_WRITTEN',
          count: cart.count,
          uniqueSkuInCart: cart.uniqueSkuInCart,
          items: Array.isArray(cart.items) ? cart.items.length : 0,
          total: cart.total,
          id: String(cart.id || ''),
          raw: String(JSON.stringify(merged)).slice(0, 4000)
        }));
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
// Also reports (once) a diagnostic snapshot of what the SPA hydrated vs what
// the server session cart actually holds — the aggregate data needed to debug
// the "prices have changed / blank cart" reconcile.
function buildBlinkitOpenCartScript(): string {
  const js = `
  (function(){
    var reported = false;
    function post(msg) { try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {} }
    function report() {
      if (reported) return;
      reported = true;
      post({ type: 'BLINKIT_CART_OPENED' });
      try {
        var local = {};
        try { local = JSON.parse(localStorage.getItem('cart')) || {}; } catch (e0) {}
        var localItems = Array.isArray(local.items) ? local.items : [];
        var localDetails = Array.isArray(local.item_details) ? local.item_details : [];
        var perItem = 0;
        for (var i = 0; i < localItems.length; i++) {
          perItem += Math.max(0, Number(localItems[i] && (localItems[i].qty || localItems[i].quantity)) || 0);
        }
        // /v5/carts has NO GET verb (405), so the server cart can't be read
        // directly — the SPA's own hydrated localStorage cart is the best
        // proxy for what checkout will price. Dump it right after the SPA
        // normalizes it (and again shortly after) to verify there is exactly
        // ONE line per product: if the same product_id appears under both
        // 'items' and 'item_details' (or twice in total), the SPA sends two
        // lines to /validate + PUT at checkout and the server SUMS them (+N).
        function dump() {
          var c2 = {};
          try { c2 = JSON.parse(localStorage.getItem('cart')) || {}; } catch (e8) {}
          var it = Array.isArray(c2.items) ? c2.items : [];
          var det = Array.isArray(c2.item_details) ? c2.item_details : [];
          var byPid = {};
          var dups = [];
          [it, det].forEach(function(list) {
            for (var j = 0; j < list.length; j++) {
              var pid = String((list[j] && (list[j].product_id || list[j].id)) || '') ;
              if (!pid) continue;
              if (byPid[pid]) dups.push(pid + ':qty=' + (list[j].qty || list[j].quantity));
              byPid[pid] = 1;
            }
          });
          post({
            type: 'BLINKIT_CART_DUMP',
            id: String(c2.id || ''),
            itemsLen: it.length,
            item_detailsLen: det.length,
            dupes: dups,
            count: c2.count,
            total: c2.total,
            raw: String(JSON.stringify(c2)).slice(0, 5000)
          });
        }
        dump();
        setTimeout(dump, 3500);
        post({ type: 'BLINKIT_CART_DIAG', localCount: local.count, localSku: local.uniqueSkuInCart, localItems: localItems.length, localQty: perItem, localTotal: local.total, localId: String(local.id || ''), serverItems: -2, serverQty: -2, serverId: '', note: 'GET /v5/carts is 405 — server cart unreadable; dumped hydrated local cart instead' });
      } catch (e2) {
        post({ type: 'BLINKIT_CART_DIAG', err: String(e2) });
      }
    }
    function goCart() {
      var target = '/cart';
      try {
        var base = window.location.origin || 'https://blinkit.com';
        if (String(window.location.pathname).indexOf('/cart') === 0) { report(); return true; }
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
          report();
        }
      }, 500);
      setTimeout(function(){ clearInterval(iv); }, 15000);
    }
  })();
  `;
  return js;
}

// Swiggy (Instamart) export: the cart is already committed server-side via the
// persistent bridge API calls, so the visible page only needs to navigate to
// the cache-busted cart URL so the SPA refetches the committed basket. We do
// NOT wipe localStorage/sessionStorage/IndexedDB here — Swiggy's SPA persists
// auth + app state there, and clearing it crashes hydration into a blank page.
// No DOM clicking — Swiggy has a real /instamart/cart route.
function buildSwiggyOpenCartScript(cartUrl: string, cookieStr: string, exportCartB64: string, cartId?: string): string {
  const js = `
  (function(){
    try {
      var entries = [];
      [window.localStorage, window.sessionStorage].forEach(function(store, si) {
        if (!store) return;
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i);
          var v = store.getItem(k);
          entries.push({ store: si === 0 ? 'local' : 'session', k: k, v: String(v).slice(0, 500) });
        }
      });
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SWIGGY_STORAGE_DUMP', entries: entries }));
    } catch(e) {}

    try {
      var cookieStr = ${JSON.stringify(cookieStr)};
      if (cookieStr) {
        var parts = String(cookieStr).split(/;\\s*/);
        for (var i = 0; i < parts.length; i++) {
          if (!parts[i]) continue;
          var eq = parts[i].indexOf('=');
          if (eq <= 0) continue;
          try {
            document.cookie = parts[i] + '; path=/; domain=.swiggy.com; secure; SameSite=None';
          } catch(e2) {}
        }
      }
    } catch(e3) {}

    try {
      if (window.navigator && navigator.serviceWorker) {
        navigator.serviceWorker.register = function(){ return Promise.reject(new Error('sw-disabled')); };
        if (navigator.serviceWorker.getRegistrations) {
          navigator.serviceWorker.getRegistrations().then(function(rs) {
            (rs || []).forEach(function(r) { r.unregister(); });
          });
        }
      }
    } catch(e4) {}
    try {
      if (window.caches && window.caches.keys) {
        window.caches.keys().then(function(keys) {
          (keys || []).forEach(function(key) {
            window.caches.delete(key);
          });
        });
      }
    } catch(e5) {}

    try {
      if (window.indexedDB && window.indexedDB.databases) {
        window.indexedDB.databases().then(function(dbs) {
          (dbs || []).forEach(function(dbInfo) {
            if (!dbInfo || !dbInfo.name) return;
            try {
              var req = window.indexedDB.open(dbInfo.name);
              req.onsuccess = function(e) {
                var db = e.target.result;
                try {
                  if (db && db.objectStoreNames && db.objectStoreNames.length > 0) {
                    var tx = db.transaction(db.objectStoreNames, 'readwrite');
                    for (var i = 0; i < db.objectStoreNames.length; i++) {
                      var storeName = db.objectStoreNames[i];
                      try {
                        tx.objectStore(storeName).clear();
                      } catch(err1) {}
                    }
                  }
                } catch(err2) {}
              };
            } catch(err3) {}
          });
        });
      }
    } catch(e6) {}

    try {
      var whitelist = [
        'swiggy_auth_headers',
        'swiggy_user_info',
        'auth_headers',
        '__payment_context__',
        '_gcl_ls',
        'aws_waf_token_challenge_attempts',
        'awswaf_session_storage',
        'awswaf_token_refresh_timestamp',
        'TNS_HASH'
      ];
      [window.localStorage, window.sessionStorage].forEach(function(store) {
        if (!store) return;
        var keysToDelete = [];
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i);
          if (whitelist.indexOf(k) === -1) {
            keysToDelete.push(k);
          }
        }
        keysToDelete.forEach(function(k) {
          store.removeItem(k);
        });
      });
    } catch(e8) {}

    function executeExport() {
      var cartB64 = ${JSON.stringify(exportCartB64)};
      var writePayload = null;
      try {
        var s = cartB64.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) { s += '='; }
        var decoded = window.atob(s);
        var raw = decodeURIComponent(Array.prototype.map.call(decoded, function(c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        writePayload = JSON.parse(raw);
      } catch(e) {}

      if (!writePayload) {
        window.location.assign(${JSON.stringify(cartUrl)});
        return;
      }

      var fetchHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };
      try {
        var ahRaw = localStorage.getItem('auth_headers');
        if (ahRaw) {
          var ah = JSON.parse(ahRaw);
          if (ah) {
            for (var k in ah) {
              if (ah.hasOwnProperty(k) && ah[k]) {
                fetchHeaders[k] = String(ah[k]);
              }
            }
          }
        }
      } catch(e) {}

      fetch('/api/instamart/checkout/v2/cart/clear', {
        method: 'POST',
        headers: fetchHeaders,
        credentials: 'include',
        body: JSON.stringify({ source: 'USER_INITIATED' })
      })
      .then(function(res1) {
        return res1.text().then(function(text1) {
          return fetch('/api/instamart/checkout/v2/cart', {
            method: 'POST',
            headers: fetchHeaders,
            credentials: 'include',
            body: JSON.stringify(writePayload)
          });
        });
      })
      .then(function(res2) {
        return res2.json().then(function(json) {
          var newCartId = json?.data?.data?.cartId || '';
          if (newCartId) {
            // Update auth_headers.cartkey
            var ahRaw = localStorage.getItem('auth_headers');
            if (ahRaw) {
              try {
                var ah = JSON.parse(ahRaw);
                if (ah) {
                  ah.cartkey = newCartId;
                  localStorage.setItem('auth_headers', JSON.stringify(ah));
                  fetchHeaders['cartkey'] = newCartId;
                }
              } catch(e2) {}
            }
            // Update __payment_context__.linkId
            var pcRaw = localStorage.getItem('__payment_context__');
            if (pcRaw) {
              try {
                var pc = JSON.parse(pcRaw);
                if (pc) {
                  pc.linkId = newCartId;
                  localStorage.setItem('__payment_context__', JSON.stringify(pc));
                }
              } catch(e3) {}
            }
          }

          return fetch('/api/instamart/checkout/v2/cart?pageType=INSTAMART_CART', {
            method: 'GET',
            headers: fetchHeaders,
            credentials: 'include',
            cache: 'reload'
          });
        });
      })
      .then(function(res3) {
        return res3.text().then(function(text3) {
          window.location.assign(${JSON.stringify(cartUrl)});
        });
      })
      .catch(function(err) {
        window.location.assign(${JSON.stringify(cartUrl)});
      });
    }

    executeExport();
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
  // WebView (its cookie jar is what prices carts), so just expand it and close.
  // Export mode is different: the visible webview must STAY open on the cart.
  useEffect(() => {
    if (isExport) return;
    if (platform === 'swiggy' && !launchedSwiggySession.current) {
      launchedSwiggySession.current = true;
      setSwiggySetupMode(params.mode === 'address' ? 'address' : 'login');
      router.back();
    }
  }, [isExport, platform, params.mode, router]);

  // Blinkit export: replay the captured session cookies into a visible
  // Blinkit page, write the resolved basket into localStorage['cart'], reload
  // so the SPA hydrates, then open the cart page.
  const exportCartB64 = isExport ? String(params.cart || '') : '';
  // Swiggy export: the basket is already committed server-side via the bridge
  // API calls; the visible page wipes local caches and navigates to this URL.
  const exportCartUrl = isExport ? String(params.url || '') : '';
  const exportCartId = isExport ? String(params.cartId || '') : '';
  const exportOldCartId = isExport ? String(params.oldCartId || '') : '';

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

  // Swiggy export: wipe stale local caches and navigate to the committed cart.
  useEffect(() => {
    if (!isExport || platform !== 'swiggy') return;
    if (!exportCartUrl) return;

    let applied = false;
    const injectSwiggy = async () => {
      if (applied || cartAppliedRef.current) return;
      cartAppliedRef.current = true;
      applied = true;
      let cookieStr = '';
      try {
        cookieStr = (await storage.getToken('swiggy')) || '';
      } catch {}
      webViewRef.current?.injectJavaScript(buildSwiggyOpenCartScript(exportCartUrl, cookieStr, exportCartB64, exportCartId));
    };
    const timer = setTimeout(injectSwiggy, 1200);
    return () => clearTimeout(timer);
  }, [isExport, platform, exportCartUrl, exportCartB64, exportCartId]);

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

  const isExportMode = isExport && (platform === 'blinkit' || platform === 'swiggy');
  const exportCookie = isExport ? '' : '';
  void exportCookie;

  const handleMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'DEBUG_COOKIES') {
        return;
      }
      if (data.type === 'BLINKIT_NETLOG') {
        // The SPA's real API traffic. /v5/carts supports no GET/DELETE, so the
        // site must mutate the session cart through some other endpoint we've
        // never seen — this recorder captures it the moment the user clears
        // the cart or taps "Proceed to pay". Log every entry (tokens redacted).
        try {
          const entries = (Array.isArray((data as any).entries) ? (data as any).entries : []) as any[];
          const redact = (s: string) => s.replace(/('access_token'\s*:\s*'|auth_key[''\s:=]+|gr_1_accessToken=)[^';,]{6,}/gi, '$1***');
          const lines = (entries as any[]).map((e: any) => ({
            m: e.m,
            u: (e.u || '').slice(0, 220),
            b: String(e.b || '').slice(0, 320),
            r: String(e.r || '').slice(0, 500),
            h: /\/v5\/carts|\/v1\/(cart|checkout)|\/clear|device|session/i.test(String(e.u || '')) ? redact(String(e.h || '')).slice(0, 500) : '',
          }));
          console.warn('[BlinkitNet]', JSON.stringify(lines));
        } catch {}
        return;
      }
      if (data.type === 'BLINKIT_CART_OPENED') {
        // The export completed and we've landed on Blinkit's cart page — keep
        // the webview open there so the user can review/checkout. (No app-side
        // redirect: the user wants to remain on the Blinkit cart, not return
        // to the app basket.)
        return;
      }
      if (data.type === 'BLINKIT_CART_WRITTEN' || data.type === 'BLINKIT_CART_DIAG' || data.type === 'BLINKIT_CART_DUMP' || data.type === 'BLINKIT_DEDUPE') {
        // Debug aid for the export flow: what the app wrote into the SPA's
        // localStorage vs what the SPA normalized it into (and whether any
        // product appears more than once — duplicated lines are what the site
        // SUMS at checkout, producing the observed +N inflation).
        console.warn(`[BlinkitExport] ${data.type}`, data);
        return;
      }
      if (data.type === 'SWIGGY_CART_OPENED') {
        // Landed on the Swiggy Instamart cart page — keep the webview open.
        return;
      }
      if (data.type === 'SWIGGY_STORAGE_DUMP') {
        // commented out to avoid log spam
        return;
      }
      if (data.type === 'SWIGGY_DEBUG') {
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

  const [swiggyCookies, setSwiggyCookies] = useState('');
  useEffect(() => {
    if (isExport && platform === 'swiggy') {
      storage.getToken('swiggy').then((c) => {
        if (c) setSwiggyCookies(c);
      }).catch(() => {});
    }
  }, [isExport, platform]);

  // Shared recorder + checkout-body deduper for the Blinkit export webview.
  // Runs before EVERY page load so the reloaded /cart page gets a live network
  // recorder. /v5/carts has no GET/DELETE (405), so the only way to see how the
  // site prices/clears the session cart is to capture the SPA's own requests.
  // It also REWRITES checkouts: the SPA maps over BOTH its hydrated 'items'
  // AND 'cartItems' slot arrays, so a single product is POSTed to
  // /validate + PUT as duplicate lines — Blinkit's server SUMS duplicate
  // product_ids *within one request* into the observed +N at "Proceed to pay".
  // Duplicate lines are collapsed to the first before they reach the network.
  // Tokens stay out of the log. Delivered via injectedJavaScriptBeforeContentLoaded
  // AND re-injected at onLoadStart/onLoadEnd, because Android intermittently
  // skips the before-content script for content-initiated reloads (that was
  // the flakiness: some runs shipped without any hook at all).
  const blinkitRecorderScript = `
    (function() {
      if (window.__bbNetHook) return; window.__bbNetHook = true;
      try {
        navigator.serviceWorker.register = function(){ return Promise.reject(new Error('sw-disabled')); };
        navigator.serviceWorker.getRegistrations().then(function(rs){ (rs || []).forEach(function(r){ r.unregister(); }); }).catch(function(){});
      } catch(e0) {}
      var buf = [];
      function send() {
        if (!buf.length) return;
        try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_NETLOG', entries: buf.splice(0, buf.length) })); } catch(e1) {}
      }
      setInterval(send, 800);
      function rec(u, m, b, r, h) {
        try {
          u = String(u || '');
          var host = '';
          try { host = new URL(u).hostname; } catch(e2) { return; }
          if (!/(^|\\.)blinkit\\.com$/.test(host)) return;
          if (/\\.(js|css|png|svg|woff2?|gif|jpg|jpeg|webp)(\\?|$)/i.test(u)) return;
          if (/\\/analytics|\\/beacon|\\/collect|perf\\/|session_replay/i.test(u)) return;
          if (buf.length >= 60) return;
          var hh = '';
          try {
            var m2 = String(h || '').replace(/('access_token'\\s*:\\s*'|auth_key[''"\\s:=]+|gr_1_accessToken=)[^';,]{6,}/gi, '$1***');
            hh = m2.slice(0, 600);
          } catch(e3) {}
          buf.push({ u: u.slice(0, 300), m: m || 'GET', b: b ? String(b).slice(0, 900) : '', h: hh, r: r ? String(r).slice(0, 1400) : '' });
        } catch(e4) {}
      }
      var of = window.fetch;
      if (of && !window.__bbFetchHooked) {
        window.__bbFetchHooked = true;
        window.fetch = function(input, init) {
          var u = (typeof input === 'string') ? input : (input && input.url) || '';
          var m = (init && init.method) || (input && input.method) || 'GET';
          var bb = init && init.body;
          var hh = '';
          try {
            var sh = (init && init.headers) || (input && input.headers);
            if (sh && typeof sh.forEach === 'function') sh.forEach(function(v, k) { hh += k + ': ' + v + '; '; });
          } catch(e5) {}
          var needRewrite = null;
          try {
            // Checkout payloads: /v5/carts/{id}/validate (POST) and
            // /v5/carts/{id} (PUT). Collapse duplicate product_ids to the
            // FIRST line (same intended quantity) — the server sums dupes.
            if (/\\/v5\\/carts\\/\\d+(\\/validate)?$/.test(u) && (m === 'PUT' || m === 'POST') && typeof bb === 'string' && bb) {
              var obj = JSON.parse(bb);
              if (obj && Array.isArray(obj.items) && obj.items.length) {
                var out = []; var seen = {};
                for (var d = 0; d < obj.items.length; d++) {
                  var it = obj.items[d];
                  if (!it || it.product_id === undefined || it.product_id === null) { out.push(it); continue; }
                  var pid = String(it.product_id);
                  if (seen[pid]) continue;
                  seen[pid] = true; out.push(it);
                }
                if (out.length !== obj.items.length) {
                  obj.items = out;
                  needRewrite = JSON.stringify(obj);
                  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_DEDUPE', url: u.slice(0, 200), before: String(bb).slice(0, 300), after: needRewrite.slice(0, 300) })); } catch (eD) {}
                }
              }
            }
          } catch(eD2) {}
          var callArgs = arguments;
          var sentBody = bb;
          if (needRewrite !== null) {
            sentBody = needRewrite;
            callArgs = [input, Object.assign({}, init || {}, { method: m, body: needRewrite })];
          }
          return of.apply(this, callArgs).then(function(res) {
            try { res.clone().text().then(function(t) { rec(u, m, sentBody, t, hh); }).catch(function(){}); } catch(e6) {}
            return res;
          });
        };
      }
      var ox = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send, orh = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function(mm, uu) { this.__bbM = mm; this.__bbU = uu; this.__bbH = ''; return ox.apply(this, arguments); };
      XMLHttpRequest.prototype.setRequestHeader = function(k, v) { this.__bbH = (this.__bbH || '') + k + ': ' + v + '; '; return orh.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function(bb) {
        this.addEventListener('load', function() { rec(this.__bbU, this.__bbM, bb, this.responseText, this.__bbH); });
        return os.apply(this, arguments);
      };
    })();
  `;

  const beforeContentScript = (() => {
    if (isExport && platform === 'blinkit') {
      return blinkitRecorderScript;

    }
    if (isExport && platform === 'swiggy' && exportCartId) {
      return `
        (function() {
          try {
            var cookieStr = ${JSON.stringify(swiggyCookies)};
            if (cookieStr) {
              var parts = String(cookieStr).split(/;\\s*/);
              for (var i = 0; i < parts.length; i++) {
                if (!parts[i]) continue;
                var eq = parts[i].indexOf('=');
                if (eq <= 0) continue;
                try {
                  document.cookie = parts[i] + '; path=/; domain=.swiggy.com; secure; SameSite=None';
                } catch(e) {}
              }
            }
          } catch(e3) {}

          try {
            if (window.navigator && navigator.serviceWorker) {
              navigator.serviceWorker.register = function(){ return Promise.reject(new Error('sw-disabled')); };
              if (navigator.serviceWorker.getRegistrations) {
                navigator.serviceWorker.getRegistrations().then(function(rs) {
                  (rs || []).forEach(function(r) { r.unregister(); });
                });
              }
            }
          } catch(e4) {}

          try {
            if (window.caches && window.caches.keys) {
              window.caches.keys().then(function(keys) {
                (keys || []).forEach(function(key) {
                  window.caches.delete(key);
                });
              });
            }
          } catch(e5) {}

          try {
            if (window.indexedDB && window.indexedDB.databases) {
              window.indexedDB.databases().then(function(dbs) {
                (dbs || []).forEach(function(dbInfo) {
                  if (!dbInfo || !dbInfo.name) return;
                  try {
                    var req = window.indexedDB.open(dbInfo.name);
                    req.onsuccess = function(e) {
                      var db = e.target.result;
                      try {
                        if (db && db.objectStoreNames && db.objectStoreNames.length > 0) {
                          var tx = db.transaction(db.objectStoreNames, 'readwrite');
                          for (var i = 0; i < db.objectStoreNames.length; i++) {
                            var storeName = db.objectStoreNames[i];
                            try {
                              tx.objectStore(storeName).clear();
                            } catch(err1) {}
                          }
                        }
                      } catch(err2) {}
                    };
                  } catch(err3) {}
                });
              });
            }
          } catch(e6) {}

          try {
            var whitelist = [
              'swiggy_auth_headers',
              'swiggy_user_info',
              'auth_headers',
              '__payment_context__',
              '_gcl_ls',
              'aws_waf_token_challenge_attempts',
              'awswaf_session_storage',
              'awswaf_token_refresh_timestamp',
              'TNS_HASH'
            ];
            [window.localStorage, window.sessionStorage].forEach(function(store) {
              if (!store) return;
              var keysToDelete = [];
              for (var i = 0; i < store.length; i++) {
                var k = store.key(i);
                if (whitelist.indexOf(k) === -1) {
                  keysToDelete.push(k);
                }
              }
              keysToDelete.forEach(function(k) {
                store.removeItem(k);
              });
            });
          } catch(e8) {}

          try {
            var newId = ${JSON.stringify(exportCartId)};
            var oldId = ${JSON.stringify(exportOldCartId)};
            if (newId) {
              [window.localStorage, window.sessionStorage].forEach(function(store) {
                if (!store) return;
                for (var i = 0; i < store.length; i++) {
                  var k = store.key(i);
                  var v = store.getItem(k);
                  if (v) {
                    if (oldId && v.indexOf(oldId) !== -1) {
                      store.setItem(k, v.split(oldId).join(newId));
                    } else if (k === 'auth_headers' || k === '__payment_context__') {
                      try {
                        var obj = JSON.parse(v);
                        if (obj) {
                          if (k === 'auth_headers') obj.cartkey = newId;
                          if (k === '__payment_context__') obj.linkId = newId;
                          store.setItem(k, JSON.stringify(obj));
                        }
                      } catch(e2) {}
                    }
                  }
                }
              });
            }
          } catch(e1) {}
        })();
      `;
    }
    return undefined;
  })();

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <ArrowLeft size={24} color="#FFF" />
        </TouchableOpacity>
        <View style={styles.titleContainer}>
          <Text style={styles.headerTitle}>{isExportMode ? `Export to ${platform === 'swiggy' ? 'Swiggy' : 'Blinkit'}` : `Link ${currentMeta.name}`}</Text>
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
          injectedJavaScriptBeforeContentLoaded={beforeContentScript}
          onLoadStart={() => {
            // Android intermittently drops injectedJavaScriptBeforeContentLoaded
            // for content-initiated reloads; re-throw the recorder+deduper in
            // as early as possible on every navigation (idempotent via guards).
            if (isExportMode && platform === 'blinkit') {
              webViewRef.current?.injectJavaScript(blinkitRecorderScript);
            }
          }}
          onLoadEnd={() => {
            // Export: after the cart is written + page reloads, open the
            // cart page so the user lands on their ready checkout. (Swiggy's
            // navigation is handled by its own export effect.)
            if (isExportMode && platform === 'blinkit' && cartAppliedRef.current) {
              setTimeout(() => {
                if (isExportMode) {
                  webViewRef.current?.injectJavaScript(blinkitRecorderScript);
                }
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
                {isExportMode
                  ? platform === 'swiggy' ? 'Opening your Swiggy Instamart basket…' : 'Opening your Blinkit basket…'
                  : 'Loading secure browser...'}
              </Text>
            </View>
          )}
        />
      </View>

      <View style={styles.footer}>
        <View style={[styles.indicatorBall, { backgroundColor: currentMeta.primaryColor }]} />
        <Text style={styles.footerText}>
          {isExportMode
            ? platform === 'swiggy'
              ? 'Your optimized basket is now in Swiggy Instamart. Review the items, add the delivery address if asked, and place the order.'
              : 'Your optimized basket is now in Blinkit. Review it, add the delivery address if asked, and place the order.'
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
