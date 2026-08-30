import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, RotateCw } from 'lucide-react-native';
import { storage, Platform } from '../services/storage';
import { setSwiggySetupMode } from '../services/swiggyBridgeUi';
import { notifyBlinkitBridgeCookies, reloadBlinkitBridge } from '../services/blinkitBridge';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Swiggy (Instamart) export: the cart is already committed server-side via the
// persistent bridge API calls, so the visible page only needs to navigate to
// the cache-busted cart URL so the SPA refetches the committed basket. We do
// NOT wipe localStorage/sessionStorage/IndexedDB here — Swiggy's SPA persists
// auth + app state there, and clearing it crashes hydration into a blank page.
// No DOM clicking — Swiggy has a real /instamart/cart route.
function buildSwiggyOpenCartScript(cartUrl: string, cookieStr: string, exportCartB64: string): string {
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

  // Swiggy export: the basket is already committed server-side via the bridge
  // API calls; the visible page navigates to this cache-busted cart URL.
  const exportCartUrl = isExport ? String(params.url || '') : '';
  const exportCartB64 = isExport ? String(params.cart || '') : '';
  const exportCartId = isExport ? String(params.cartId || '') : '';
  const exportOldCartId = isExport ? String(params.oldCartId || '') : '';

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
      webViewRef.current?.injectJavaScript(buildSwiggyOpenCartScript(exportCartUrl, cookieStr, exportCartB64));
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
            var curLat = lat;
            var curLng = lng;
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
                // Try to fetch addresses from Blinkit /v4/address API — only
                // when real coordinates are known (no fabricated city defaults).
                var storedLat = localStorage.getItem('selected_lat') || localStorage.getItem('latitude') || '';
                var storedLng = localStorage.getItem('selected_lng') || localStorage.getItem('longitude') || '';
                if (storedLat && storedLng) {
                  tryFetchAddresses(accessToken, storedLat, storedLng, deviceId);
                }
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
        alert(`${currentMeta.name} Linked successfully!`);
        if (platform === 'blinkit') {
          setTimeout(() => reloadBlinkitBridge(), 500);
        }
        router.back();
      }
    } catch {
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

  const beforeContentScript = (() => {
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
