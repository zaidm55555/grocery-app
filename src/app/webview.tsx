import React, { useState, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, RotateCw } from 'lucide-react-native';
import { storage, Platform } from '../services/storage';
import { setSwiggySetupMode } from '../services/swiggyBridgeUi';
import { notifyBlinkitBridgeCookies } from '../services/blinkitBridge';
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
          // Record every cart/bill request the REAL site makes so our own
          // /v5/carts call can be diffed against ground truth.
          let buf = [];
          const rec = (u, m, b, r, h) => {
            try {
              u = String(u);
              // Analytics beacons smuggle blinkit.com inside query params —
              // check the HOSTNAME, not the whole string.
              let host = '';
              try { host = new URL(u).hostname; } catch (e0) { return; }
              if (!/(^|\.)blinkit\.com$/.test(host)) return;
              if (!/cart|bill|checkout/i.test(u)) return;
              if (buf.length >= 20) return;
              buf.push({ m: m || 'GET', u: u.slice(0, 220), h: h ? String(h).slice(0, 900) : '', b: b ? String(b).slice(0, 2500) : '', r: r ? String(r).slice(0, 4500) : '' });
            } catch (e2) {}
          };
          if (!window.__blRec) {
            window.__blRec = true;
            // Blinkit's PWA routes API calls through a Service Worker, which
            // silently bypasses page-level fetch/XHR hooks. Kill any
            // registration and RELOAD once — an already-controlled page keeps
            // its worker until a fresh load, so this is the only way its
            // network traffic falls back into the hooked window.fetch.
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

          let sentAddress = false;
          let sentDump = false;
          const checkToken = setInterval(() => {
            try {
              // Re-sweep: a worker registering after load would hijack traffic.
              try {
                navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
              } catch (e7) {}

              // Ship anything the site itself requested since last tick.
              if (buf.length) {
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_NETLOG', entries: buf.splice(0, buf.length) }));
              }

              // The SPA stores the chosen delivery address here once a
              // location is selected; /v5/carts needs it for real pricing.
              if (!sentAddress) {
                const aid = sessionStorage.getItem('selected_address_id')
                  || localStorage.getItem('selected_address_id')
                  || localStorage.getItem('address_id') || '';
                if (aid) {
                  sentAddress = true;
                  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_ADDRESS', addressId: String(aid) }));
                }
              }

              // Diagnostic sweep: show every storage key that sounds
              // address/location related so the right source can be picked.
              if (!sentDump) {
                const entries = [];
                [window.localStorage, window.sessionStorage].forEach((store, si) => {
                  for (let i = 0; i < store.length && entries.length < 25; i++) {
                    const k = String(store.key(i));
                    if (/address|location|lat|lng|city/i.test(k)) {
                      let v = '';
                      try { v = String(store.getItem(k)); } catch (e2) {}
                      // Address books are long — keep enough of the payload
                      // for the id fields deep inside records to survive.
                      entries.push({ s: si === 0 ? 'L' : 'S', k: k.slice(0, 60), v: v.slice(0, 6000) });
                    }
                  }
                });
                if (entries.length) {
                  sentDump = true;
                  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BLINKIT_STORAGE_DUMP', entries }));
                }
              }

              // Report login immediately: link and close.
              const token = localStorage.getItem('authKey') || localStorage.getItem('token') || localStorage.getItem('auth_token');
              if (token) {
                clearInterval(checkToken);
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SUCCESS', token, cookie: document.cookie }));
                return;
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
        // Automatically fetch and save dummy coordinates if not set to mimic full session
        const existingLocation = await storage.getLocation();
        if (!existingLocation) {
          await storage.saveLocation({
            latitude: 12.9716,
            longitude: 77.5946,
            address: 'Bengaluru, Karnataka, India'
          });
        }
        alert(`${currentMeta.name} Linked successfully!`);
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
