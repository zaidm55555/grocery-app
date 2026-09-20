import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  registerBigBasketInjector,
  unregisterBigBasketInjector,
  handleBigBasketBridgeMessage,
  takeBigBasketBridgeCookies,
  registerBigBasketBridgeReload,
  unregisterBigBasketBridgeReload,
} from '../services/bigbasketBridge';

const BRIDGE_SCRIPT = `
(function() {
  try {
    if (window.__bbBridgeInstalled) return;
    window.__bbBridgeInstalled = true;

    window.__bbStoredAddrId = null;
    window.__bbStoredLat = null;
    window.__bbStoredLng = null;

    window.__bbApplyCookies = function(cookieStr) {
      try {
        var parts = String(cookieStr || '').split(/;\\s*/);
        for (var i = 0; i < parts.length; i++) {
          if (!parts[i]) continue;
          var eq = parts[i].indexOf('=');
          if (eq <= 0) continue;
          document.cookie = parts[i] + '; path=/; domain=.bigbasket.com; secure; SameSite=None';
        }
      } catch (e) {}
    };

    window.__bbSetDeliveryContext = function(addrId, lat, lng, cityId) {
      try {
        window.__bbStoredAddrId = addrId || null;
        window.__bbStoredLat = lat || null;
        window.__bbStoredLng = lng || null;
        if (lat) document.cookie = '_bb_lat=' + encodeURIComponent(lat) + '; path=/; domain=.bigbasket.com; max-age=31536000';
        if (lng) document.cookie = '_bb_long=' + encodeURIComponent(lng) + '; path=/; domain=.bigbasket.com; max-age=31536000';
        if (cityId) document.cookie = '_bb_cid=' + encodeURIComponent(cityId) + '; path=/; domain=.bigbasket.com; max-age=31536000';
        if (addrId) document.cookie = '_bb_aid=' + encodeURIComponent(addrId) + '; path=/; domain=.bigbasket.com; max-age=31536000';
      } catch (e) {}
    };

    window.__bbHandleRequest = function(id, url, method, body, extraHeadersJson) {
      if (method === '__EVAL__') {
        try {
          var evalRes = (function() { return eval(url); })();
          var outText = typeof evalRes === 'object' ? JSON.stringify(evalRes) : String(evalRes ?? '');
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'BB_EVAL_RESPONSE',
            id: id,
            status: 200,
            text: outText
          }));
        } catch(e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'BB_EVAL_RESPONSE',
            id: id,
            status: 500,
            text: String(e && e.message || e)
          }));
        }
        return;
      }

      function uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0;
          var v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }
      function getCookie(name) {
        try {
          var cookies = document.cookie.split(';');
          for (var i = 0; i < cookies.length; i++) {
            var c = cookies[i].trim();
            if (c.indexOf(name + '=') === 0) {
              return decodeURIComponent(c.substring((name + '=').length));
            }
          }
        } catch (_) {}
        return null;
      }

      var opts = {
        method: method || 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'X-Caller': 'UIKIRK',
          'x-channel': 'BB-WEB',
          'common-client-static-version': '101',
          'osmos-enabled': 'true',
          'x-tracker': uuid()
        }
      };

      var csurf = getCookie('csurftoken');
      if (csurf) opts.headers['X-csurftoken'] = csurf;
      var ecid = getCookie('xentrycontextid') || '100';
      var ec = getCookie('xentrycontext') || 'bbnow';
      if (ecid) opts.headers['x-entry-context-id'] = ecid;
      if (ec) opts.headers['x-entry-context'] = ec;

      try {
        var extra = JSON.parse(extraHeadersJson || '{}');
        for (var k in extra) {
          if (extra[k]) opts.headers[k] = extra[k];
        }
      } catch (e2) {}

      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = body;
      }

      fetch(url, opts)
        .then(function(res) {
          return res.text().then(function(t) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'BB_API_RESPONSE',
              id: id,
              status: res.status,
              text: String(t).slice(0, 1500000)
            }));
          });
        })
        .catch(function(e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'BB_API_RESPONSE',
            id: id,
            status: 0,
            text: String((e && e.message) || e)
          }));
        });
    };

    // Monitor addresses if available
    try {
      var cookieMid = '';
      var cookies = document.cookie.split(';');
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.indexOf('_bb_mid=') === 0) cookieMid = c.substring('_bb_mid='.length);
      }
      if (cookieMid) {
        fetch('https://www.bigbasket.com/order/v2/checkout', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'X-Caller': 'UIKIRK',
            'x-channel': 'BB-WEB'
          },
          body: JSON.stringify({ is_split_order_supported: true, offer_communication: true, action: 'default' })
        }).then(function(r) {
          if (r.ok) return r.json();
          return null;
        }).then(function(data) {
          var list = data?.addresses || data?.member_addresses || data?.delivery_addresses || [];
          if (Array.isArray(list) && list.length > 0) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'BB_ADDR_RESOLVED',
              addresses: list
            }));
          }
        }).catch(function() {});
      }
    } catch(eAddr) {}

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BB_BRIDGE_READY' }));
  } catch (eMain) {}
})();
`;

interface BigBasketBridgeHandle {
  reload: () => void;
  injectJS: (js: string) => void;
}

const BigBasketBridgeWebView = forwardRef<BigBasketBridgeHandle>((_, ref) => {
  const webViewRef = useRef<WebView>(null);

  useImperativeHandle(ref, () => ({
    reload: () => {
      webViewRef.current?.reload();
    },
    injectJS: (js: string) => {
      webViewRef.current?.injectJavaScript(js);
    },
  }));

  useEffect(() => {
    const injector = (id: number, url: string, method: string, body: string, extraHeaders: string) => {
      webViewRef.current?.injectJavaScript(
        `window.__bbHandleRequest(${id}, ${JSON.stringify(url)}, ${JSON.stringify(method)}, ${JSON.stringify(body)}, ${JSON.stringify(extraHeaders)}); true;`
      );
    };
    registerBigBasketInjector(injector);
    registerBigBasketBridgeReload(() => {
      webViewRef.current?.reload();
    });
    return () => {
      unregisterBigBasketInjector(injector);
      unregisterBigBasketBridgeReload();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const injectAddress = async () => {
      try {
        const [addrId, bbLat, bbLng, bbCid] = await Promise.all([
          AsyncStorage.getItem('@bigbasket_address_id'),
          AsyncStorage.getItem('@bigbasket_lat'),
          AsyncStorage.getItem('@bigbasket_lng'),
          AsyncStorage.getItem('@bigbasket_city_id'),
        ]);
        if (!mounted) return;
        if (addrId || (bbLat && bbLng)) {
          webViewRef.current?.injectJavaScript(
            `window.__bbSetDeliveryContext(${JSON.stringify(addrId || '')}, ${JSON.stringify(bbLat || '')}, ${JSON.stringify(bbLng || '')}, ${JSON.stringify(bbCid || '')}); true;`
          );
        }
      } catch {}
    };

    const initTimer = setTimeout(injectAddress, 2000);
    pollTimer = setInterval(injectAddress, 2000);

    return () => {
      mounted = false;
      clearTimeout(initTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  const handleMessage = (event: any) => {
    const payload = String(event.nativeEvent.data || '');
    const cookieStr = takeBigBasketBridgeCookies();
    if (cookieStr) {
      webViewRef.current?.injectJavaScript(
        `window.__bbApplyCookies(${JSON.stringify(cookieStr)}); true;`
      );
    }
    try {
      const msg = JSON.parse(payload);
      if (msg?.type === 'BB_ADDR_RESOLVED' && Array.isArray(msg.addresses) && msg.addresses.length > 0) {
        const primary = msg.addresses.find((a: any) => a.is_default) || msg.addresses[0];
        if (primary) {
          if (primary.id) AsyncStorage.setItem('@bigbasket_address_id', String(primary.id));
          if (primary.lat && primary.lng) {
            AsyncStorage.setItem('@bigbasket_lat', String(primary.lat));
            AsyncStorage.setItem('@bigbasket_lng', String(primary.lng));
          }
          if (primary.city_id) {
            AsyncStorage.setItem('@bigbasket_city_id', String(primary.city_id));
          }
        }
      }
    } catch {}
    handleBigBasketBridgeMessage(payload);
  };

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://www.bigbasket.com/' }}
        injectedJavaScriptBeforeContentLoaded={BRIDGE_SCRIPT}
        injectedJavaScript={BRIDGE_SCRIPT}
        onMessage={handleMessage}
        onLoadEnd={() => {
          webViewRef.current?.injectJavaScript(`${BRIDGE_SCRIPT}; true;`);
        }}
        onError={(e) => console.warn('[BigBasketBridge] onError:', e.nativeEvent)}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        startInLoadingState={false}
        style={styles.web}
      />
    </View>
  );
});

BigBasketBridgeWebView.displayName = 'BigBasketBridgeWebView';
export default BigBasketBridgeWebView;

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
  web: {
    flex: 1,
    backgroundColor: '#FFF',
  },
});
