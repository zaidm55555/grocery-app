import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, RotateCw } from 'lucide-react-native';
import { storage, Platform } from '../services/storage';
import { setSwiggySetupMode } from '../services/swiggyBridgeUi';
import { notifyBlinkitBridgeCookies, reloadBlinkitBridge } from '../services/blinkitBridge';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function WebViewScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const platform = (params.platform as Platform) || 'blinkit';
  const launchedSwiggySession = useRef(false);
  const [loading, setLoading] = useState(true);
  const webViewRef = useRef<WebView>(null);

  // Swiggy login/address work happens inside the single persistent bridge
  // WebView (its cookie jar is what prices carts), so just expand it.
  useEffect(() => {
    if (platform === 'swiggy' && !launchedSwiggySession.current) {
      launchedSwiggySession.current = true;
      setSwiggySetupMode(params.mode === 'address' ? 'address' : 'login');
      router.back();
    }
  }, [platform, params.mode, router]);

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

          function tryFetchAddresses(token, lat, lng) {
            var curLat = lat || '12.9716';
            var curLng = lng || '77.5946';
            var url = 'https://blinkit.com/v4/address?cur_lat=' + curLat + '&cur_lon=' + curLng;
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
                'device_id': 'basketbuddy_' + Date.now(),
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

              var token = localStorage.getItem('authKey') || localStorage.getItem('token') || localStorage.getItem('auth_token');
              if (token && !tokenFound) {
                tokenFound = true;
                // Try to fetch addresses from Blinkit /v4/address API
                var storedLat = localStorage.getItem('selected_lat') || localStorage.getItem('latitude') || '';
                var storedLng = localStorage.getItem('selected_lng') || localStorage.getItem('longitude') || '';
                tryFetchAddresses(token, storedLat, storedLng);
              }

              // Send SUCCESS once we have a token. If we already found an
              // address OR after 10 seconds of polling, close.
              if (token && !successSent && (addrFound || checkCount >= 10)) {
                successSent = true;
                clearInterval(checkToken);
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'SUCCESS', token: token, cookie: document.cookie, address: null
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

  const handleMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'DEBUG_COOKIES') {
        console.log(`[Swiggy WebView Cookies Debug]: ${data.cookies}`);
        return;
      }
      if (data.type === 'BLINKIT_NETLOG') {
        for (const e of (data.entries || []) as any[]) {
          console.log(`[Blinkit Site Traffic] ${e.m} ${e.u}\n  headers: ${e.h}\n  body: ${e.b}\n  resp: ${e.r}`);
        }
        return;
      }
      if (data.type === 'BLINKIT_ADDRESS' && data.addressId) {
        console.log(`[Blinkit WebView] captured address id: ${data.addressId}`);
        await AsyncStorage.setItem('@blinkit_address_id', String(data.addressId));
        return;
      }
      if (data.type === 'BLINKIT_LATLNG' && data.lat && data.lng) {
        console.log(`[Blinkit WebView] captured coords: ${data.lat}, ${data.lng}`);
        await AsyncStorage.setItem('@blinkit_lat', String(data.lat));
        await AsyncStorage.setItem('@blinkit_lng', String(data.lng));
        return;
      }
      if (data.type === 'BLINKIT_ADDR_DEBUG') {
        console.log(`[Blinkit WebView] addr API ${data.url || ''} → status=${data.status || ''} error=${data.error || ''} body=${(data.body || '').slice(0, 500)}`);
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
            console.log(`[Blinkit WebView] auto-captured address id ${id} from key "${e.k}"`);
            await AsyncStorage.setItem('@blinkit_address_id', id);
            // The address record also carries the authoritative delivery
            // coordinates — store-level fees/surge are keyed to these, not
            // to any city-center default.
            const latM = raw.match(/"latitude"\s*:\s*([\d.]+)/);
            const lngM = raw.match(/"longitude"\s*:\s*([\d.]+)/);
            if (latM && lngM) {
              await AsyncStorage.setItem('@blinkit_lat', latM[1]);
              await AsyncStorage.setItem('@blinkit_lng', lngM[1]);
              console.log(`[Blinkit WebView] saved coords ${latM[1]}, ${lngM[1]}`);
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
            console.log(`[Blinkit WebView] auto-captured address id ${addrId} from API`);
          }
          const lat = addr.latitude ?? addr.lat;
          const lng = addr.longitude ?? addr.lng ?? addr.lon;
          if (lat && lng) {
            await AsyncStorage.setItem('@blinkit_lat', String(lat));
            await AsyncStorage.setItem('@blinkit_lng', String(lng));
            console.log(`[Blinkit WebView] saved API coords ${lat}, ${lng}`);
          }
          // Also try to call Blinkit's address select API from WITHIN
          // this WebView (which has the same cookies/session as the site)
          // to set the server-side session address.
          if (addrId) {
            // Set server-side session via /v4/address
            var sLat = String(addr.latitude ?? addr.lat ?? '12.9716');
            var sLng = String(addr.longitude ?? addr.lng ?? addr.lon ?? '77.5946');
            fetch('https://blinkit.com/v4/address?cur_lat=' + sLat + '&cur_lon=' + sLng, {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'access_token': data.token,
                'auth_key': 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
                'app_client': 'consumer_web',
                'lat': sLat,
                'lon': sLng,
                'device_id': 'basketbuddy_' + Date.now(),
                'platform': 'mobile_web'
              }
            }).then(function(r) {
              console.log(`[Blinkit WebView] v4/address status: ${r.status}`);
              return r.text();
            }).then(function(t) {
              console.log(`[Blinkit WebView] v4/address response: ${(t || '').slice(0, 500)}`);
            }).catch(function(e) {
              console.warn(`[Blinkit WebView] v4/address failed: ${e}`);
            });
            // Also try address select variants
            fetch('https://blinkit.com/v2/address/select', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'auth_key': data.token },
              body: JSON.stringify({ address_id: Number(addrId) })
            }).then(function(r) {
              console.log(`[Blinkit WebView] v2/address/select status: ${r.status}`);
              return r.text();
            }).then(function(t) {
              console.log(`[Blinkit WebView] v2/address/select response: ${(t || '').slice(0, 500)}`);
            }).catch(function(e) {
              console.warn(`[Blinkit WebView] v2/address/select failed: ${e}`);
            });
            fetch('https://blinkit.com/v1/address/select', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'auth_key': data.token },
              body: JSON.stringify({ id: Number(addrId) })
            }).then(function(r) {
              console.log(`[Blinkit WebView] v1/address/select status: ${r.status}`);
            }).catch(function() {});
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
        // Reload the hidden bridge WebView so it picks up the fresh login
        // cookies from the shared native cookie jar. Without this, the bridge
        // page keeps its old anonymous session and carts get priced under the
        // wrong delivery zone (₹25+₹2 instead of ₹30+₹12).
        if (platform === 'blinkit') {
          setTimeout(() => reloadBlinkitBridge(), 500);
        }
        router.back();
      }
    } catch (err) {
      console.error('Failed to parse WebView message:', err);
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
          <Text style={styles.headerTitle}>Link {currentMeta.name}</Text>
          <Text style={styles.headerSubtitle}>Login to sync account</Text>
        </View>
        <TouchableOpacity style={styles.reloadButton} onPress={reloadPage}>
          <RotateCw size={20} color="#FFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.webContainer}>
        <WebView
          ref={webViewRef}
          source={{ uri: currentMeta.url }}
          injectedJavaScript={currentMeta.injectScript}
          onMessage={handleMessage}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          sharedCookiesEnabled={true}
          userAgent="Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Mobile Safari/537.36"
          startInLoadingState={true}
          renderLoading={() => (
            <View style={styles.loaderContainer}>
              <ActivityIndicator size="large" color={currentMeta.primaryColor} />
              <Text style={styles.loaderText}>Loading secure browser...</Text>
            </View>
          )}
        />
      </View>

      <View style={styles.footer}>
        <View style={[styles.indicatorBall, { backgroundColor: currentMeta.primaryColor }]} />
        <Text style={styles.footerText}>
          Enter phone number & verify OTP. The app will capture the token and close automatically.
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
