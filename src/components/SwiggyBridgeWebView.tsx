import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import { X } from 'lucide-react-native';
import {
  registerSwiggyInjector,
  unregisterSwiggyInjector,
  handleSwiggyBridgeMessage,
} from '../services/swiggyBridge';
import {
  getSwiggySetupMode,
  setSwiggySetupMode,
  subscribeSwiggySetupMode,
} from '../services/swiggyBridgeUi';
import { storage } from '../services/storage';

// Runs inside the single persistent swiggy.com WebView: executes same-origin,
// credentialed API calls on behalf of the app and posts each result back
// (the extension's MAIN-world scrape-polyfill + background jsonFetch pair).
const BRIDGE_SCRIPT = `
(function() {
  if (window.__goBridgeInstalled) return;
  window.__goBridgeInstalled = true;

  // Replay cookies captured in a visible linking browser into this page's
  // jar (backup path; the fullscreen login already shares this jar).
  window.__goApplyCookies = function(cookieStr) {
    try {
      var parts = String(cookieStr || '').split(/;\\s*/);
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var eq = parts[i].indexOf('=');
        if (eq <= 0) continue;
        document.cookie = parts[i] + '; path=/; domain=.swiggy.com; secure; SameSite=None';
      }
    } catch (e) {}
  };

  // Login watcher. __goPrevLogin is seeded by the app when the fullscreen
  // browser opens, so a fresh logout->login transition fires exactly once;
  // opening while ALREADY logged in never auto-closes over address setup.
  if (!window.__goLoginWatchInstalled) {
    window.__goLoginWatchInstalled = true;
    window.__goPrevLogin = '__unset';
    setInterval(function() {
      try {
        var c = document.cookie || '';
        var isIn = c.indexOf('_is_logged_in=1') !== -1;
        var prev = window.__goPrevLogin;
        if (prev !== '__unset' && isIn && !prev) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'GO_SWIGGY_LOGIN', cookies: c
          }));
        }
        if (!isIn || prev === '__unset') window.__goPrevLogin = isIn;
      } catch (e) {}
    }, 1500);
  }

  window.__goHandleRequest = function(id, url, method, body) {
    var opts = {
      method: method || 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = body;
    }
    fetch(url, opts).then(function(res) {
      return res.text().then(function(t) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'GO_API_RESPONSE', id: id, status: res.status, text: String(t).slice(0, 1500000)
        }));
      });
    }).catch(function(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'GO_API_RESPONSE', id: id, status: 0, text: String((e && e.message) || e)
      }));
    });
  };
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'GO_BRIDGE_READY' }));
})();
`;

const COPY = {
  login: {
    title: 'Link Swiggy',
    subtitle: 'Login to sync account',
    footer: 'Enter phone & OTP if asked. Closes automatically — fresh login or already logged in.',
  },
  address: {
    title: 'Swiggy address',
    subtitle: 'Stays open until you close it',
    footer: 'Add any item to the cart on the site, open its cart page, tap "Add address", fill house/flat details and Save. Then tap ✕.',
  },
};

export default function SwiggyBridgeWebView() {
  const webViewRef = useRef<WebView>(null);
  const mode = useSyncExternalStore(subscribeSwiggySetupMode, getSwiggySetupMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const injector = (id: number, url: string, method: string, body: string) => {
      webViewRef.current?.injectJavaScript(
        `window.__goHandleRequest(${id}, ${JSON.stringify(url)}, ${JSON.stringify(method)}, ${JSON.stringify(body)}); true;`
      );
    };
    registerSwiggyInjector(injector);
    return () => unregisterSwiggyInjector(injector);
  }, []);

  // Seed the login baseline each time the fullscreen browser opens, so the
  // watcher only fires on a transition observed DURING this session. Also
  // reports the current state: in 'login' mode an already-active session
  // closes right away, while 'address' mode always waits for the user.
  useEffect(() => {
    if (mode !== 'login' && mode !== 'address') return;
    webViewRef.current?.injectJavaScript(
      'window.__goPrevLogin = (document.cookie.indexOf("_is_logged_in=1") !== -1);' +
      'window.ReactNativeWebView.postMessage(JSON.stringify({ type: "GO_LOGIN_SNAPSHOT", v: window.__goPrevLogin, cookies: document.cookie })); true;'
    );
  }, [mode]);

  const handleMessage = async (event: any) => {
    let msg: any = null;
    try {
      msg = JSON.parse(String(event.nativeEvent.data || ''));
    } catch {
      handleSwiggyBridgeMessage(String(event.nativeEvent.data || ''));
      return;
    }
    if (msg?.type === 'GO_LOGIN_SNAPSHOT' && msg.v === true) {
      // Already logged in when the browser opened — capture the session
      // token, then (in login mode) close right away.
      if (typeof msg.cookies === 'string' && msg.cookies.includes('_is_logged_in=1')) {
        await storage.saveToken('swiggy', msg.cookies).catch(() => {});
      }
      if (modeRef.current === 'login') {
        setTimeout(() => setSwiggySetupMode('hidden'), 2000);
      }
      return;
    }
    if (msg?.type === 'GO_SWIGGY_LOGIN' && typeof msg.cookies === 'string') {
      await storage.saveToken('swiggy', msg.cookies).catch(() => {});
      if (modeRef.current === 'login') {
        setTimeout(() => setSwiggySetupMode('hidden'), 2500);
      }
      return;
    }
    handleSwiggyBridgeMessage(String(event.nativeEvent.data || ''));
  };

  const setup = mode !== 'hidden';
  const copy = setup ? COPY[mode as 'login' | 'address'] : null;

  return (
    <View style={setup ? styles.full : styles.hidden} pointerEvents={setup ? 'auto' : 'none'}>
      {setup && copy && (
        <SafeAreaView style={styles.safe}>
          <View style={styles.header}>
            <TouchableOpacity style={styles.closeButton} onPress={() => setSwiggySetupMode('hidden')}>
              <X size={22} color="#FFF" />
            </TouchableOpacity>
            <View style={styles.titleWrap}>
              <Text style={styles.title}>{copy.title}</Text>
              <Text style={styles.subtitle}>{copy.subtitle}</Text>
            </View>
          </View>
        </SafeAreaView>
      )}

      <WebView
        ref={webViewRef}
        source={{ uri: 'https://www.swiggy.com/instamart' }}
        injectedJavaScript={BRIDGE_SCRIPT}
        injectedJavaScriptBeforeContentLoaded={BRIDGE_SCRIPT}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        startInLoadingState={false}
        style={styles.web}
      />

      {setup && copy && (
        <SafeAreaView style={styles.footer}>
          <Text style={styles.footerText}>{copy.footer}</Text>
        </SafeAreaView>
      )}
    </View>
  );
}

// Off-screen rather than zero-size: Android can skip rendering (and JS) in a
// truly 0x0 WebView, which would leave the bridge permanently unready. The
// SAME instance expands fullscreen for login/address work, so the session
// that logs in is the session that prices carts — HttpOnly cookies included.
const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    top: -9999,
    left: -9999,
    opacity: 0.01,
    overflow: 'hidden',
  },
  full: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0F0F12',
    zIndex: 9999,
    elevation: 9999,
  },
  safe: {
    backgroundColor: '#0F0F12',
  },
  web: {
    flex: 1,
    backgroundColor: '#FFF',
  },
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1F1F24',
  },
  closeButton: {
    padding: 6,
    marginRight: 12,
  },
  titleWrap: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
  },
  subtitle: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  footer: {
    backgroundColor: '#16161D',
    borderTopWidth: 1,
    borderTopColor: '#272730',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  footerText: {
    fontSize: 11,
    color: '#A0AEC0',
    lineHeight: 16,
  },
});
