import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  registerBlinkitInjector,
  unregisterBlinkitInjector,
  handleBlinkitBridgeMessage,
  takeBlinkitBridgeCookies,
  registerBlinkitBridgeReload,
  unregisterBlinkitBridgeReload,
} from '../services/blinkitBridge';

const BRIDGE_SCRIPT = `
(function() {
  if (window.__blBridgeInstalled) return;
  window.__blBridgeInstalled = true;

  // Stored delivery address — set by React Native after reading AsyncStorage.
  // __blHandleRequest uses this to force-inject address_id into /v5/carts
  // request bodies so the server always sees the user's address regardless
  // of the SPA's internal state.
  window.__blStoredAddrId = null;
  window.__blStoredLat = null;
  window.__blStoredLng = null;
  window.__blAddrApiFetched = false;

  window.__blApplyCookies = function(cookieStr) {
    try {
      var parts = String(cookieStr || '').split(/;\\s*/);
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var eq = parts[i].indexOf('=');
        if (eq <= 0) continue;
        document.cookie = parts[i] + '; path=/; domain=.blinkit.com; secure; SameSite=None';
      }
    } catch (e) {}
  };

  window.__blSetDeliveryContext = function(addrId, lat, lng) {
    try {
      window.__blStoredAddrId = addrId || null;
      window.__blStoredLat = lat || null;
      window.__blStoredLng = lng || null;
      if (addrId) localStorage.setItem('selected_address_id', String(addrId));
      if (lat) localStorage.setItem('selected_lat', String(lat));
      if (lng) localStorage.setItem('selected_lng', String(lng));
      // Also try to set Blinkit SPA's own address storage keys
      try {
        var addrKey = 'addresses_data';
        var existing = localStorage.getItem(addrKey);
        if (existing && addrId) {
          var parsed = JSON.parse(existing);
          if (parsed && parsed.addresses && Array.isArray(parsed.addresses.addresses_data)) {
            var match = parsed.addresses.addresses_data.find(function(a) { return String(a.id) === String(addrId); });
            if (match) {
              localStorage.setItem('selected_address_id', String(addrId));
            }
          }
        }
      } catch (e2) {}
      // Call Blinkit's /v4/address API to set server-side session address.
      // Only fetch once — no need to spam the API.
      if (addrId && !window.__blAddrApiFetched) {
        window.__blAddrApiFetched = true;
        var bLat = localStorage.getItem('selected_lat') || lat || '12.9716';
        var bLng = localStorage.getItem('selected_lng') || lng || '77.5946';
        var accessToken = '';
        try { var authObj = JSON.parse(localStorage.getItem('auth') || '{}'); accessToken = authObj.accessToken || ''; } catch (e) {}
        var deviceId = localStorage.getItem('deviceId') || '';
        fetch('https://blinkit.com/v4/address?cur_lat=' + bLat + '&cur_lon=' + bLng, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'access_token': accessToken,
            'auth_key': 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
            'app_client': 'consumer_web',
            'lat': bLat,
            'lon': bLng,
            'device_id': deviceId,
            'platform': 'mobile_web'
          }
        }).then(function(r) { return r.text(); }).then(function(t) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v4/address', body: t.slice(0, 2000) }));
          try {
            var aj = JSON.parse(t);
            var list = aj.addresses || aj.data || aj.addresses_data || (Array.isArray(aj) ? aj : null);
            if (list && !Array.isArray(list) && list.addresses_data) list = list.addresses_data;
            if (Array.isArray(list) && list.length) {
              var a = list[0];
              var aId = a.id || a.address_id || '';
              var aLat = a.latitude || a.lat || '';
              var aLng = a.longitude || a.lng || a.lon || '';
              if (aId) { window.__blStoredAddrId = String(aId); localStorage.setItem('selected_address_id', String(aId)); }
              if (aLat && aLng) { window.__blStoredLat = String(aLat); window.__blStoredLng = String(aLng); }
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_RESOLVED', addressId: String(aId), lat: String(aLat), lng: String(aLng) }));
            }
          } catch (e) {}
        }).catch(function() {});
        // Also try address select variants for server-side session
        fetch('https://blinkit.com/v2/address/select', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ address_id: Number(addrId) })
        }).catch(function() {});
        fetch('https://blinkit.com/v1/address/select', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ id: Number(addrId) })
        }).catch(function() {});
        fetch('https://blinkit.com/v1/addresses/select', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ address_id: Number(addrId) })
        }).catch(function() {});
      }
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'BL_ADDR_SET', addrId: addrId, lat: lat, lng: lng
      }));
    } catch (e) {}
  };

  window.__blHandleRequest = function(id, url, method, body, extraHeadersJson) {
    var opts = {
      method: method || 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    };
    try {
      var extra = JSON.parse(extraHeadersJson || '{}');
      for (var k in extra) { if (extra[k]) opts.headers[k] = extra[k]; }
    } catch (e2) {}
    try {
      var ak = localStorage.getItem('authKey');
      if (ak && !opts.headers['auth_key']) opts.headers['auth_key'] = ak;
    } catch (e3) {}
    try {
      var dv = localStorage.getItem('deviceId');
      if (dv) {
        if (!opts.headers['DeviceID']) opts.headers['DeviceID'] = dv;
        if (!opts.headers['device_id']) opts.headers['device_id'] = dv;
        if (!opts.headers['deviceid']) opts.headers['deviceid'] = dv;
        if (!opts.headers['x-device-id']) opts.headers['x-device-id'] = dv;
      }
    } catch (e11) {}
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      // Force-inject address_id into /v5/carts POST bodies. The SPA may
      // not have an address selected in its internal state, but our stored
      // address ensures the server always prices under the correct zone.
      if (window.__blStoredAddrId && /\\/v5\\/carts/.test(url) && method === 'POST') {
        try {
          var b = JSON.parse(body);
          if (!b.address_id) {
            b.address_id = Number(window.__blStoredAddrId);
            body = JSON.stringify(b);
          }
        } catch (e4) {}
      }
      opts.body = body;
    }
    fetch(url, opts).then(function(res) {
      return res.text().then(function(t) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'BL_API_RESPONSE', id: id, status: res.status, text: String(t).slice(0, 1500000)
        }));
      });
    }).catch(function(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'BL_API_RESPONSE', id: id, status: 0, text: String((e && e.message) || e)
      }));
    });
  };
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_BRIDGE_READY' }));
  // Auto-fetch addresses via /v4/address if logged in but no address stored.
  // This handles the first-login case where localStorage has no address yet.
  // Only runs once.
  (function() {
    try {
      if (window.__blAddrApiFetched) return;
      var authRaw = localStorage.getItem('auth');
      if (!authRaw) return;
      var authObj = JSON.parse(authRaw);
      var accessToken = authObj.accessToken || '';
      if (!accessToken) return;
      var existingAddr = localStorage.getItem('selected_address_id') || window.__blStoredAddrId;
      if (existingAddr) return;
      var locRaw = localStorage.getItem('location');
      var lat = '12.9716', lng = '77.5946';
      if (locRaw) { try { var loc = JSON.parse(locRaw); lat = loc.coords.lat || lat; lng = loc.coords.lon || lng; } catch (e) {} }
      var deviceId = localStorage.getItem('deviceId') || '';
      window.__blAddrApiFetched = true;
      var url = 'https://blinkit.com/v4/address?cur_lat=' + lat + '&cur_lon=' + lng;
      fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'access_token': accessToken,
          'auth_key': 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
          'app_client': 'consumer_web',
          'lat': lat,
          'lon': lng,
          'device_id': deviceId,
          'platform': 'mobile_web'
        }
      }).then(function(r) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v4/auto', status: r.status }));
        if (!r.ok) return null;
        return r.text();
      }).then(function(t) {
        if (!t) return;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v4/auto', body: t.slice(0, 2000) }));
        try {
          var aj = JSON.parse(t);
          var list = aj.addresses || aj.data || aj.addresses_data || (Array.isArray(aj) ? aj : null);
          if (list && !Array.isArray(list) && list.addresses_data) list = list.addresses_data;
          if (Array.isArray(list) && list.length) {
            var a = list[0];
            var aId = a.id || a.address_id || '';
            var aLat = a.latitude || a.lat || '';
            var aLng = a.longitude || a.lng || a.lon || '';
            if (aId) { window.__blStoredAddrId = String(aId); localStorage.setItem('selected_address_id', String(aId)); }
            if (aLat && aLng) { window.__blStoredLat = String(aLat); window.__blStoredLng = String(aLng); localStorage.setItem('selected_lat', String(aLat)); localStorage.setItem('selected_lng', String(aLng)); }
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_RESOLVED', addressId: String(aId), lat: String(aLat), lng: String(aLng) }));
          }
        } catch (e) {}
      }).catch(function() {});
    } catch (e) {}
  })();
  try {
    var storageKeys = ['cart', 'checkout'];
    for (var si = 0; si < storageKeys.length; si++) {
      var sv = String(localStorage.getItem(storageKeys[si]) || '');
      if (sv) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'BL_LOCALSTORAGE', key: storageKeys[si], value: sv.slice(0, 60000)
        }));
      }
    }
  } catch (e10) {}
  try {
    var diag = [];
    for (var i = 0; i < localStorage.length && diag.length < 60; i++) {
      var k = String(localStorage.key(i));
      diag.push({ k: k.slice(0, 60), v: String(localStorage.getItem(k)).slice(0, 160) });
    }
    var dc = '';
    try { dc = String(document.cookie).slice(0, 1200); } catch (e9) {}
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_DIAG', entries: diag, cookie: dc }));
  } catch (e8) {}
})();
`;

export interface BlinkitBridgeHandle {
  reload: () => void;
  injectJS: (js: string) => void;
}

const BlinkitBridgeWebView = forwardRef<BlinkitBridgeHandle>((_, ref) => {
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
        `window.__blHandleRequest(${id}, ${JSON.stringify(url)}, ${JSON.stringify(method)}, ${JSON.stringify(body)}, ${JSON.stringify(extraHeaders)}); true;`
      );
    };
    registerBlinkitInjector(injector);
    registerBlinkitBridgeReload(() => {
      webViewRef.current?.reload();
    });
    return () => {
      unregisterBlinkitInjector(injector);
      unregisterBlinkitBridgeReload();
    };
  }, []);

  // Inject stored delivery address into the bridge page on mount AND
  // whenever the tab is focused (useFocusEffect won't work here since
  // this component is outside the tab navigator). Polling covers the
  // case where the user sets an address in Profile AFTER the bridge
  // was already loaded.
  useEffect(() => {
    let mounted = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const injectAddress = async () => {
      try {
        const [addrId, bLat, bLng] = await Promise.all([
          AsyncStorage.getItem('@blinkit_address_id'),
          AsyncStorage.getItem('@blinkit_lat'),
          AsyncStorage.getItem('@blinkit_lng'),
        ]);
        if (!mounted) return;
        if (addrId || (bLat && bLng)) {
          webViewRef.current?.injectJavaScript(
            `window.__blSetDeliveryContext(${JSON.stringify(addrId || '')}, ${JSON.stringify(bLat || '')}, ${JSON.stringify(bLng || '')}); true;`
          );
          console.log(`[BlinkitBridge] injected address context: addr=${addrId}, lat=${bLat}, lng=${bLng}`);
        }
      } catch (e) {
        console.warn('[BlinkitBridge] failed to inject address context:', e);
      }
    };

    // Initial injection with delay for page load
    const initTimer = setTimeout(injectAddress, 2000);

    // Re-inject every 2s so any address change in Profile tab gets picked up
    // quickly after login.
    pollTimer = setInterval(injectAddress, 2000);

    return () => {
      mounted = false;
      clearTimeout(initTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  const handleMessage = (event: any) => {
    const payload = String(event.nativeEvent.data || '');
    const cookieStr = takeBlinkitBridgeCookies();
    if (cookieStr) {
      webViewRef.current?.injectJavaScript(
        `window.__blApplyCookies(${JSON.stringify(cookieStr)}); true;`
      );
    }
    try {
      const msg = JSON.parse(payload);
      if (msg?.type === 'BL_DIAG') {
        console.log(`[BlinkitBridge] page identity: ${JSON.stringify(msg.entries)} cookie: ${msg.cookie}`);
      }
      if (msg?.type === 'BL_ADDR_SET') {
        console.log(`[BlinkitBridge] address context confirmed in page: addr=${msg.addrId}, lat=${msg.lat}, lng=${msg.lng}`);
      }
      if (msg?.type === 'BL_ADDR_DEBUG') {
        console.log(`[BlinkitBridge] addr API ${msg.source || ''}: status=${msg.status || ''} body=${(msg.body || '').slice(0, 500)}`);
      }
      if (msg?.type === 'BL_ADDR_RESOLVED') {
        console.log(`[BlinkitBridge] address resolved from API: addr=${msg.addressId}, lat=${msg.lat}, lng=${msg.lng}`);
        if (msg.addressId) AsyncStorage.setItem('@blinkit_address_id', msg.addressId);
        if (msg.lat && msg.lng) { AsyncStorage.setItem('@blinkit_lat', msg.lat); AsyncStorage.setItem('@blinkit_lng', msg.lng); }
      }
    } catch {}
    handleBlinkitBridgeMessage(payload);
  };

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://blinkit.com/' }}
        injectedJavaScript={BRIDGE_SCRIPT}
        injectedJavaScriptBeforeContentLoaded={BRIDGE_SCRIPT}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        startInLoadingState={false}
        style={styles.web}
      />
    </View>
  );
});

BlinkitBridgeWebView.displayName = 'BlinkitBridgeWebView';
export default BlinkitBridgeWebView;

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
