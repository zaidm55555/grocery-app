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
  registerBlinkitBridgeClearLocalStorage,
  unregisterBlinkitBridgeClearLocalStorage,
} from '../services/blinkitBridge';

const BRIDGE_SCRIPT = `
(function() {
  try {
  if (window.__blBridgeInstalled) return;
  window.__blBridgeInstalled = true;
  window.__blScriptRan = true;
  window.__blScriptError = null;

  // Stored delivery address -- set by React Native after reading AsyncStorage.
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

  // Extract access_token from localStorage('auth') or gr_1_accessToken cookie.
  // In APK builds, sharedCookiesEnabled shares cookies between WebViews but NOT
  // localStorage, so the cookie fallback is essential for fresh installs.
  window.__blGetAccessToken = function() {
    try {
      var authRaw = localStorage.getItem('auth');
      if (authRaw) { var ao = JSON.parse(authRaw); if (ao.accessToken) return ao.accessToken; }
    } catch (e) {}
    try {
      var cookies = document.cookie.split(';');
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.indexOf('gr_1_accessToken=') === 0) {
          return decodeURIComponent(c.substring('gr_1_accessToken='.length));
        }
      }
    } catch (e2) {}
    return '';
  };

  window.__blSetDeliveryContext = function(addrId, lat, lng) {
    try {
      // Fall back to Blinkit's own localStorage if React Native didn't provide lat/lng
      if (!lat || !lng) {
        try {
          var lsLat = localStorage.getItem('selected_lat');
          var lsLng = localStorage.getItem('selected_lng');
          if (lsLat && lsLng) { lat = lat || lsLat; lng = lng || lsLng; }
        } catch (e) {}
      }
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
      // The auto-fetch IIFE handles this with retries. Here we only call
      // SELECT APIs as a best-effort backup — they often 404 but don't hurt.
      if (addrId) {
        var bLat = localStorage.getItem('selected_lat') || lat || '12.9716';
        var bLng = localStorage.getItem('selected_lng') || lng || '77.5946';
        var accessToken = window.__blGetAccessToken();
        var deviceId = localStorage.getItem('deviceId') || '';
        var authKey = localStorage.getItem('authKey') || '';
        var selectHeaders = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'access_token': accessToken,
          'auth_key': authKey,
          'app_client': 'consumer_web',
          'lat': bLat,
          'lon': bLng,
          'device_id': deviceId,
          'platform': 'mobile_web'
        };
        // Address select variants for server-side session
        fetch('https://blinkit.com/v2/address/select', {
          method: 'POST',
          credentials: 'include',
          headers: selectHeaders,
          body: JSON.stringify({ address_id: Number(addrId) })
        }).then(function(r) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v2/select', status: r.status }));
        }).catch(function() {});
        fetch('https://blinkit.com/v1/address/select', {
          method: 'POST',
          credentials: 'include',
          headers: selectHeaders,
          body: JSON.stringify({ id: Number(addrId) })
        }).then(function(r) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v1/select', status: r.status }));
        }).catch(function() {});
        fetch('https://blinkit.com/v1/addresses/select', {
          method: 'POST',
          credentials: 'include',
          headers: selectHeaders,
          body: JSON.stringify({ address_id: Number(addrId) })
        }).then(function(r) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v1s/select', status: r.status }));
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
    // Ensure access_token is always present — in APK builds, localStorage
    // may not have it, so fall back to the gr_1_accessToken cookie.
    try {
      if (!opts.headers['access_token']) {
        var at = window.__blGetAccessToken ? window.__blGetAccessToken() : '';
        if (at) opts.headers['access_token'] = at;
      }
    } catch (e12) {}
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
      if (/\/v5\/carts/.test(url) && method === 'POST') {
        try {
          var b = JSON.parse(body);
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_CART_REQ', url: url, addressId: b.address_id || null, storedAddrId: window.__blStoredAddrId || null, items: (b.items || []).length }));
          if (!b.address_id && window.__blStoredAddrId) {
            b.address_id = Number(window.__blStoredAddrId);
            body = JSON.stringify(b);
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_CART_REQ', injected: true, addressId: b.address_id }));
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
  // Auto-fetch addresses via /v4/address on every bridge load.
  // In APK builds, localStorage isn't shared between WebViews, so the
  // access_token cookie (gr_1_accessToken) is used as fallback.
  // Retries up to 10 times (1s apart) until the cookie is available.
  (function() {
    try {
      if (window.__blAddrApiFetched) return;
      var _blFetchAttempts = 0;
      var _blMaxAttempts = 10;
      function _blAutoFetch() {
        try {
          if (window.__blAddrApiFetched) return;
          _blFetchAttempts++;
          var accessToken = window.__blGetAccessToken();
          if (!accessToken) {
            if (_blFetchAttempts < _blMaxAttempts) setTimeout(_blAutoFetch, 1000);
            return;
          }
          var locRaw = localStorage.getItem('location');
          var lat = '12.9716', lng = '77.5946';
          if (locRaw) { try { var loc = JSON.parse(locRaw); lat = loc.coords.lat || lat; lng = loc.coords.lon || lng; } catch (e) {} }
          var deviceId = localStorage.getItem('deviceId') || '';
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
            window.__blAddrApiFetched = true;
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
                var authKey2 = localStorage.getItem('authKey') || '';
                var selH = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'access_token': accessToken, 'auth_key': authKey2, 'app_client': 'consumer_web', 'lat': aLat, 'lon': aLng, 'device_id': deviceId, 'platform': 'mobile_web' };
                fetch('https://blinkit.com/v2/address/select', {
                  method: 'POST', credentials: 'include',
                  headers: selH,
                  body: JSON.stringify({ address_id: Number(aId) })
                }).then(function(r) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v2/select/auto', status: r.status }));
                }).catch(function() {});
                fetch('https://blinkit.com/v1/address/select', {
                  method: 'POST', credentials: 'include',
                  headers: selH,
                  body: JSON.stringify({ id: Number(aId) })
                }).then(function(r) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v1/select/auto', status: r.status }));
                }).catch(function() {});
                fetch('https://blinkit.com/v1/addresses/select', {
                  method: 'POST', credentials: 'include',
                  headers: selH,
                  body: JSON.stringify({ address_id: Number(aId) })
                }).then(function(r) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_ADDR_DEBUG', source: 'v1s/select/auto', status: r.status }));
                }).catch(function() {});
              }
            } catch (e) {}
          }).catch(function() { window.__blAddrApiFetched = true; });
        } catch (e) {}
      }
      _blAutoFetch();
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
  } catch (eMain) {
    window.__blScriptError = String(eMain && eMain.message || eMain);
    window.__blScriptStack = String(eMain && eMain.stack || '').slice(0, 500);
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_BRIDGE_ERROR', error: window.__blScriptError, stack: window.__blScriptStack })); } catch (e2) {}
  }
})();
`;

const BRIDGE_SCRIPT_B64 = 'CihmdW5jdGlvbigpIHsKICB0cnkgewogIGlmICh3aW5kb3cuX19ibEJyaWRnZUluc3RhbGxlZCkgcmV0dXJuOwogIHdpbmRvdy5fX2JsQnJpZGdlSW5zdGFsbGVkID0gdHJ1ZTsKICB3aW5kb3cuX19ibFNjcmlwdFJhbiA9IHRydWU7CiAgd2luZG93Ll9fYmxTY3JpcHRFcnJvciA9IG51bGw7CgogIC8vIFN0b3JlZCBkZWxpdmVyeSBhZGRyZXNzIC0tIHNldCBieSBSZWFjdCBOYXRpdmUgYWZ0ZXIgcmVhZGluZyBBc3luY1N0b3JhZ2UuCiAgLy8gX19ibEhhbmRsZVJlcXVlc3QgdXNlcyB0aGlzIHRvIGZvcmNlLWluamVjdCBhZGRyZXNzX2lkIGludG8gL3Y1L2NhcnRzCiAgLy8gcmVxdWVzdCBib2RpZXMgc28gdGhlIHNlcnZlciBhbHdheXMgc2VlcyB0aGUgdXNlcidzIGFkZHJlc3MgcmVnYXJkbGVzcwogIC8vIG9mIHRoZSBTUEEncyBpbnRlcm5hbCBzdGF0ZS4KICB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCA9IG51bGw7CiAgd2luZG93Ll9fYmxTdG9yZWRMYXQgPSBudWxsOwogIHdpbmRvdy5fX2JsU3RvcmVkTG5nID0gbnVsbDsKICB3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkID0gZmFsc2U7CgogIHdpbmRvdy5fX2JsQXBwbHlDb29raWVzID0gZnVuY3Rpb24oY29va2llU3RyKSB7CiAgICB0cnkgewogICAgICB2YXIgcGFydHMgPSBTdHJpbmcoY29va2llU3RyIHx8ICcnKS5zcGxpdCgvO1xccyovKTsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7IGkrKykgewogICAgICAgIGlmICghcGFydHNbaV0pIGNvbnRpbnVlOwogICAgICAgIHZhciBlcSA9IHBhcnRzW2ldLmluZGV4T2YoJz0nKTsKICAgICAgICBpZiAoZXEgPD0gMCkgY29udGludWU7CiAgICAgICAgZG9jdW1lbnQuY29va2llID0gcGFydHNbaV0gKyAnOyBwYXRoPS87IGRvbWFpbj0uYmxpbmtpdC5jb207IHNlY3VyZTsgU2FtZVNpdGU9Tm9uZSc7CiAgICAgIH0KICAgIH0gY2F0Y2ggKGUpIHt9CiAgfTsKCiAgLy8gRXh0cmFjdCBhY2Nlc3NfdG9rZW4gZnJvbSBsb2NhbFN0b3JhZ2UoJ2F1dGgnKSBvciBncl8xX2FjY2Vzc1Rva2VuIGNvb2tpZS4KICAvLyBJbiBBUEsgYnVpbGRzLCBzaGFyZWRDb29raWVzRW5hYmxlZCBzaGFyZXMgY29va2llcyBiZXR3ZWVuIFdlYlZpZXdzIGJ1dCBOT1QKICAvLyBsb2NhbFN0b3JhZ2UsIHNvIHRoZSBjb29raWUgZmFsbGJhY2sgaXMgZXNzZW50aWFsIGZvciBmcmVzaCBpbnN0YWxscy4KICB3aW5kb3cuX19ibEdldEFjY2Vzc1Rva2VuID0gZnVuY3Rpb24oKSB7CiAgICB0cnkgewogICAgICB2YXIgYXV0aFJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoJyk7CiAgICAgIGlmIChhdXRoUmF3KSB7IHZhciBhbyA9IEpTT04ucGFyc2UoYXV0aFJhdyk7IGlmIChhby5hY2Nlc3NUb2tlbikgcmV0dXJuIGFvLmFjY2Vzc1Rva2VuOyB9CiAgICB9IGNhdGNoIChlKSB7fQogICAgdHJ5IHsKICAgICAgdmFyIGNvb2tpZXMgPSBkb2N1bWVudC5jb29raWUuc3BsaXQoJzsnKTsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb29raWVzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgdmFyIGMgPSBjb29raWVzW2ldLnRyaW0oKTsKICAgICAgICBpZiAoYy5pbmRleE9mKCdncl8xX2FjY2Vzc1Rva2VuPScpID09PSAwKSB7CiAgICAgICAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KGMuc3Vic3RyaW5nKCdncl8xX2FjY2Vzc1Rva2VuPScubGVuZ3RoKSk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGNhdGNoIChlMikge30KICAgIHJldHVybiAnJzsKICB9OwoKICB3aW5kb3cuX19ibFNldERlbGl2ZXJ5Q29udGV4dCA9IGZ1bmN0aW9uKGFkZHJJZCwgbGF0LCBsbmcpIHsKICAgIHRyeSB7CiAgICAgIC8vIEZhbGwgYmFjayB0byBCbGlua2l0J3Mgb3duIGxvY2FsU3RvcmFnZSBpZiBSZWFjdCBOYXRpdmUgZGlkbid0IHByb3ZpZGUgbGF0L2xuZwogICAgICBpZiAoIWxhdCB8fCAhbG5nKSB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHZhciBsc0xhdCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzZWxlY3RlZF9sYXQnKTsKICAgICAgICAgIHZhciBsc0xuZyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzZWxlY3RlZF9sbmcnKTsKICAgICAgICAgIGlmIChsc0xhdCAmJiBsc0xuZykgeyBsYXQgPSBsYXQgfHwgbHNMYXQ7IGxuZyA9IGxuZyB8fCBsc0xuZzsgfQogICAgICAgIH0gY2F0Y2ggKGUpIHt9CiAgICAgIH0KICAgICAgd2luZG93Ll9fYmxTdG9yZWRBZGRySWQgPSBhZGRySWQgfHwgbnVsbDsKICAgICAgd2luZG93Ll9fYmxTdG9yZWRMYXQgPSBsYXQgfHwgbnVsbDsKICAgICAgd2luZG93Ll9fYmxTdG9yZWRMbmcgPSBsbmcgfHwgbnVsbDsKICAgICAgaWYgKGFkZHJJZCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2FkZHJlc3NfaWQnLCBTdHJpbmcoYWRkcklkKSk7CiAgICAgIGlmIChsYXQpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sYXQnLCBTdHJpbmcobGF0KSk7CiAgICAgIGlmIChsbmcpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sbmcnLCBTdHJpbmcobG5nKSk7CiAgICAgIC8vIEFsc28gdHJ5IHRvIHNldCBCbGlua2l0IFNQQSdzIG93biBhZGRyZXNzIHN0b3JhZ2Uga2V5cwogICAgICB0cnkgewogICAgICAgIHZhciBhZGRyS2V5ID0gJ2FkZHJlc3Nlc19kYXRhJzsKICAgICAgICB2YXIgZXhpc3RpbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShhZGRyS2V5KTsKICAgICAgICBpZiAoZXhpc3RpbmcgJiYgYWRkcklkKSB7CiAgICAgICAgICB2YXIgcGFyc2VkID0gSlNPTi5wYXJzZShleGlzdGluZyk7CiAgICAgICAgICBpZiAocGFyc2VkICYmIHBhcnNlZC5hZGRyZXNzZXMgJiYgQXJyYXkuaXNBcnJheShwYXJzZWQuYWRkcmVzc2VzLmFkZHJlc3Nlc19kYXRhKSkgewogICAgICAgICAgICB2YXIgbWF0Y2ggPSBwYXJzZWQuYWRkcmVzc2VzLmFkZHJlc3Nlc19kYXRhLmZpbmQoZnVuY3Rpb24oYSkgeyByZXR1cm4gU3RyaW5nKGEuaWQpID09PSBTdHJpbmcoYWRkcklkKTsgfSk7CiAgICAgICAgICAgIGlmIChtYXRjaCkgewogICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9hZGRyZXNzX2lkJywgU3RyaW5nKGFkZHJJZCkpOwogICAgICAgICAgICB9CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9IGNhdGNoIChlMikge30KICAgICAgLy8gQ2FsbCBCbGlua2l0J3MgL3Y0L2FkZHJlc3MgQVBJIHRvIHNldCBzZXJ2ZXItc2lkZSBzZXNzaW9uIGFkZHJlc3MuCiAgICAgIC8vIFRoZSBhdXRvLWZldGNoIElJRkUgaGFuZGxlcyB0aGlzIHdpdGggcmV0cmllcy4gSGVyZSB3ZSBvbmx5IGNhbGwKICAgICAgLy8gU0VMRUNUIEFQSXMgYXMgYSBiZXN0LWVmZm9ydCBiYWNrdXAg4oCUIHRoZXkgb2Z0ZW4gNDA0IGJ1dCBkb24ndCBodXJ0LgogICAgICBpZiAoYWRkcklkKSB7CiAgICAgICAgdmFyIGJMYXQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc2VsZWN0ZWRfbGF0JykgfHwgbGF0IHx8ICcxMi45NzE2JzsKICAgICAgICB2YXIgYkxuZyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzZWxlY3RlZF9sbmcnKSB8fCBsbmcgfHwgJzc3LjU5NDYnOwogICAgICAgIHZhciBhY2Nlc3NUb2tlbiA9IHdpbmRvdy5fX2JsR2V0QWNjZXNzVG9rZW4oKTsKICAgICAgICB2YXIgZGV2aWNlSWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKSB8fCAnJzsKICAgICAgICB2YXIgYXV0aEtleSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoS2V5JykgfHwgJyc7CiAgICAgICAgdmFyIHNlbGVjdEhlYWRlcnMgPSB7CiAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLAogICAgICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi9qc29uJywKICAgICAgICAgICdhY2Nlc3NfdG9rZW4nOiBhY2Nlc3NUb2tlbiwKICAgICAgICAgICdhdXRoX2tleSc6IGF1dGhLZXksCiAgICAgICAgICAnYXBwX2NsaWVudCc6ICdjb25zdW1lcl93ZWInLAogICAgICAgICAgJ2xhdCc6IGJMYXQsCiAgICAgICAgICAnbG9uJzogYkxuZywKICAgICAgICAgICdkZXZpY2VfaWQnOiBkZXZpY2VJZCwKICAgICAgICAgICdwbGF0Zm9ybSc6ICdtb2JpbGVfd2ViJwogICAgICAgIH07CiAgICAgICAgLy8gQWRkcmVzcyBzZWxlY3QgdmFyaWFudHMgZm9yIHNlcnZlci1zaWRlIHNlc3Npb24KICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92Mi9hZGRyZXNzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFkZHJlc3NfaWQ6IE51bWJlcihhZGRySWQpIH0pCiAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2Mi9zZWxlY3QnLCBzdGF0dXM6IHIuc3RhdHVzIH0pKTsKICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92MS9hZGRyZXNzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGlkOiBOdW1iZXIoYWRkcklkKSB9KQogICAgICAgIH0pLnRoZW4oZnVuY3Rpb24ocikgewogICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX0RFQlVHJywgc291cmNlOiAndjEvc2VsZWN0Jywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oKSB7fSk7CiAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjEvYWRkcmVzc2VzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFkZHJlc3NfaWQ6IE51bWJlcihhZGRySWQpIH0pCiAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2MXMvc2VsZWN0Jywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oKSB7fSk7CiAgICAgIH0KICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgdHlwZTogJ0JMX0FERFJfU0VUJywgYWRkcklkOiBhZGRySWQsIGxhdDogbGF0LCBsbmc6IGxuZwogICAgICB9KSk7CiAgICB9IGNhdGNoIChlKSB7fQogIH07CgogIHdpbmRvdy5fX2JsSGFuZGxlUmVxdWVzdCA9IGZ1bmN0aW9uKGlkLCB1cmwsIG1ldGhvZCwgYm9keSwgZXh0cmFIZWFkZXJzSnNvbikgewogICAgdmFyIG9wdHMgPSB7CiAgICAgIG1ldGhvZDogbWV0aG9kIHx8ICdHRVQnLAogICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICBoZWFkZXJzOiB7ICdBY2NlcHQnOiAnYXBwbGljYXRpb24vanNvbiwgdGV4dC9wbGFpbiwgKi8qJyB9CiAgICB9OwogICAgdHJ5IHsKICAgICAgdmFyIGV4dHJhID0gSlNPTi5wYXJzZShleHRyYUhlYWRlcnNKc29uIHx8ICd7fScpOwogICAgICBmb3IgKHZhciBrIGluIGV4dHJhKSB7IGlmIChleHRyYVtrXSkgb3B0cy5oZWFkZXJzW2tdID0gZXh0cmFba107IH0KICAgIH0gY2F0Y2ggKGUyKSB7fQogICAgdHJ5IHsKICAgICAgdmFyIGFrID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2F1dGhLZXknKTsKICAgICAgaWYgKGFrICYmICFvcHRzLmhlYWRlcnNbJ2F1dGhfa2V5J10pIG9wdHMuaGVhZGVyc1snYXV0aF9rZXknXSA9IGFrOwogICAgfSBjYXRjaCAoZTMpIHt9CiAgICAvLyBFbnN1cmUgYWNjZXNzX3Rva2VuIGlzIGFsd2F5cyBwcmVzZW50IOKAlCBpbiBBUEsgYnVpbGRzLCBsb2NhbFN0b3JhZ2UKICAgIC8vIG1heSBub3QgaGF2ZSBpdCwgc28gZmFsbCBiYWNrIHRvIHRoZSBncl8xX2FjY2Vzc1Rva2VuIGNvb2tpZS4KICAgIHRyeSB7CiAgICAgIGlmICghb3B0cy5oZWFkZXJzWydhY2Nlc3NfdG9rZW4nXSkgewogICAgICAgIHZhciBhdCA9IHdpbmRvdy5fX2JsR2V0QWNjZXNzVG9rZW4gPyB3aW5kb3cuX19ibEdldEFjY2Vzc1Rva2VuKCkgOiAnJzsKICAgICAgICBpZiAoYXQpIG9wdHMuaGVhZGVyc1snYWNjZXNzX3Rva2VuJ10gPSBhdDsKICAgICAgfQogICAgfSBjYXRjaCAoZTEyKSB7fQogICAgdHJ5IHsKICAgICAgdmFyIGR2ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2RldmljZUlkJyk7CiAgICAgIGlmIChkdikgewogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydEZXZpY2VJRCddKSBvcHRzLmhlYWRlcnNbJ0RldmljZUlEJ10gPSBkdjsKICAgICAgICBpZiAoIW9wdHMuaGVhZGVyc1snZGV2aWNlX2lkJ10pIG9wdHMuaGVhZGVyc1snZGV2aWNlX2lkJ10gPSBkdjsKICAgICAgICBpZiAoIW9wdHMuaGVhZGVyc1snZGV2aWNlaWQnXSkgb3B0cy5oZWFkZXJzWydkZXZpY2VpZCddID0gZHY7CiAgICAgICAgaWYgKCFvcHRzLmhlYWRlcnNbJ3gtZGV2aWNlLWlkJ10pIG9wdHMuaGVhZGVyc1sneC1kZXZpY2UtaWQnXSA9IGR2OwogICAgICB9CiAgICB9IGNhdGNoIChlMTEpIHt9CiAgICBpZiAoYm9keSkgewogICAgICBvcHRzLmhlYWRlcnNbJ0NvbnRlbnQtVHlwZSddID0gJ2FwcGxpY2F0aW9uL2pzb24nOwogICAgICAvLyBGb3JjZS1pbmplY3QgYWRkcmVzc19pZCBpbnRvIC92NS9jYXJ0cyBQT1NUIGJvZGllcy4gVGhlIFNQQSBtYXkKICAgICAgLy8gbm90IGhhdmUgYW4gYWRkcmVzcyBzZWxlY3RlZCBpbiBpdHMgaW50ZXJuYWwgc3RhdGUsIGJ1dCBvdXIgc3RvcmVkCiAgICAgIC8vIGFkZHJlc3MgZW5zdXJlcyB0aGUgc2VydmVyIGFsd2F5cyBwcmljZXMgdW5kZXIgdGhlIGNvcnJlY3Qgem9uZS4KICAgICAgaWYgKC9cL3Y1XC9jYXJ0cy8udGVzdCh1cmwpICYmIG1ldGhvZCA9PT0gJ1BPU1QnKSB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHZhciBiID0gSlNPTi5wYXJzZShib2R5KTsKICAgICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiAnQkxfQ0FSVF9SRVEnLCB1cmw6IHVybCwgYWRkcmVzc0lkOiBiLmFkZHJlc3NfaWQgfHwgbnVsbCwgc3RvcmVkQWRkcklkOiB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCB8fCBudWxsLCBpdGVtczogKGIuaXRlbXMgfHwgW10pLmxlbmd0aCB9KSk7CiAgICAgICAgICBpZiAoIWIuYWRkcmVzc19pZCAmJiB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCkgewogICAgICAgICAgICBiLmFkZHJlc3NfaWQgPSBOdW1iZXIod2luZG93Ll9fYmxTdG9yZWRBZGRySWQpOwogICAgICAgICAgICBib2R5ID0gSlNPTi5zdHJpbmdpZnkoYik7CiAgICAgICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiAnQkxfQ0FSVF9SRVEnLCBpbmplY3RlZDogdHJ1ZSwgYWRkcmVzc0lkOiBiLmFkZHJlc3NfaWQgfSkpOwogICAgICAgICAgfQogICAgICAgIH0gY2F0Y2ggKGU0KSB7fQogICAgICB9CiAgICAgIG9wdHMuYm9keSA9IGJvZHk7CiAgICB9CiAgICBmZXRjaCh1cmwsIG9wdHMpLnRoZW4oZnVuY3Rpb24ocmVzKSB7CiAgICAgIHJldHVybiByZXMudGV4dCgpLnRoZW4oZnVuY3Rpb24odCkgewogICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoewogICAgICAgICAgdHlwZTogJ0JMX0FQSV9SRVNQT05TRScsIGlkOiBpZCwgc3RhdHVzOiByZXMuc3RhdHVzLCB0ZXh0OiBTdHJpbmcodCkuc2xpY2UoMCwgMTUwMDAwMCkKICAgICAgICB9KSk7CiAgICAgIH0pOwogICAgfSkuY2F0Y2goZnVuY3Rpb24oZSkgewogICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsKICAgICAgICB0eXBlOiAnQkxfQVBJX1JFU1BPTlNFJywgaWQ6IGlkLCBzdGF0dXM6IDAsIHRleHQ6IFN0cmluZygoZSAmJiBlLm1lc3NhZ2UpIHx8IGUpCiAgICAgIH0pKTsKICAgIH0pOwogIH07CiAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9CUklER0VfUkVBRFknIH0pKTsKICAvLyBBdXRvLWZldGNoIGFkZHJlc3NlcyB2aWEgL3Y0L2FkZHJlc3Mgb24gZXZlcnkgYnJpZGdlIGxvYWQuCiAgLy8gSW4gQVBLIGJ1aWxkcywgbG9jYWxTdG9yYWdlIGlzbid0IHNoYXJlZCBiZXR3ZWVuIFdlYlZpZXdzLCBzbyB0aGUKICAvLyBhY2Nlc3NfdG9rZW4gY29va2llIChncl8xX2FjY2Vzc1Rva2VuKSBpcyB1c2VkIGFzIGZhbGxiYWNrLgogIC8vIFJldHJpZXMgdXAgdG8gMTAgdGltZXMgKDFzIGFwYXJ0KSB1bnRpbCB0aGUgY29va2llIGlzIGF2YWlsYWJsZS4KICAoZnVuY3Rpb24oKSB7CiAgICB0cnkgewogICAgICBpZiAod2luZG93Ll9fYmxBZGRyQXBpRmV0Y2hlZCkgcmV0dXJuOwogICAgICB2YXIgX2JsRmV0Y2hBdHRlbXB0cyA9IDA7CiAgICAgIHZhciBfYmxNYXhBdHRlbXB0cyA9IDEwOwogICAgICBmdW5jdGlvbiBfYmxBdXRvRmV0Y2goKSB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIGlmICh3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkKSByZXR1cm47CiAgICAgICAgICBfYmxGZXRjaEF0dGVtcHRzKys7CiAgICAgICAgICB2YXIgYWNjZXNzVG9rZW4gPSB3aW5kb3cuX19ibEdldEFjY2Vzc1Rva2VuKCk7CiAgICAgICAgICBpZiAoIWFjY2Vzc1Rva2VuKSB7CiAgICAgICAgICAgIGlmIChfYmxGZXRjaEF0dGVtcHRzIDwgX2JsTWF4QXR0ZW1wdHMpIHNldFRpbWVvdXQoX2JsQXV0b0ZldGNoLCAxMDAwKTsKICAgICAgICAgICAgcmV0dXJuOwogICAgICAgICAgfQogICAgICAgICAgdmFyIGxvY1JhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdsb2NhdGlvbicpOwogICAgICAgICAgdmFyIGxhdCA9ICcxMi45NzE2JywgbG5nID0gJzc3LjU5NDYnOwogICAgICAgICAgaWYgKGxvY1JhdykgeyB0cnkgeyB2YXIgbG9jID0gSlNPTi5wYXJzZShsb2NSYXcpOyBsYXQgPSBsb2MuY29vcmRzLmxhdCB8fCBsYXQ7IGxuZyA9IGxvYy5jb29yZHMubG9uIHx8IGxuZzsgfSBjYXRjaCAoZSkge30gfQogICAgICAgICAgdmFyIGRldmljZUlkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2RldmljZUlkJykgfHwgJyc7CiAgICAgICAgICB2YXIgdXJsID0gJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjQvYWRkcmVzcz9jdXJfbGF0PScgKyBsYXQgKyAnJmN1cl9sb249JyArIGxuZzsKICAgICAgICAgIGZldGNoKHVybCwgewogICAgICAgICAgICBtZXRob2Q6ICdHRVQnLAogICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICAgICAgICBoZWFkZXJzOiB7CiAgICAgICAgICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi9qc29uJywKICAgICAgICAgICAgICAnYWNjZXNzX3Rva2VuJzogYWNjZXNzVG9rZW4sCiAgICAgICAgICAgICAgJ2F1dGhfa2V5JzogJ2M3NjFlYzM2MzNjMjJhZmFkOTM0ZmIxN2E2NjM4NWMxYzA2YzU0NzJiNDg5OGI4NjZiNzMwNjE4NmQwYmI0NzcnLAogICAgICAgICAgICAgICdhcHBfY2xpZW50JzogJ2NvbnN1bWVyX3dlYicsCiAgICAgICAgICAgICAgJ2xhdCc6IGxhdCwKICAgICAgICAgICAgICAnbG9uJzogbG5nLAogICAgICAgICAgICAgICdkZXZpY2VfaWQnOiBkZXZpY2VJZCwKICAgICAgICAgICAgICAncGxhdGZvcm0nOiAnbW9iaWxlX3dlYicKICAgICAgICAgICAgfQogICAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICAgIHdpbmRvdy5fX2JsQWRkckFwaUZldGNoZWQgPSB0cnVlOwogICAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2NC9hdXRvJywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgICAgIGlmICghci5vaykgcmV0dXJuIG51bGw7CiAgICAgICAgICAgIHJldHVybiByLnRleHQoKTsKICAgICAgICAgIH0pLnRoZW4oZnVuY3Rpb24odCkgewogICAgICAgICAgICBpZiAoIXQpIHJldHVybjsKICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX0RFQlVHJywgc291cmNlOiAndjQvYXV0bycsIGJvZHk6IHQuc2xpY2UoMCwgMjAwMCkgfSkpOwogICAgICAgICAgICB0cnkgewogICAgICAgICAgICAgIHZhciBhaiA9IEpTT04ucGFyc2UodCk7CiAgICAgICAgICAgICAgdmFyIGxpc3QgPSBhai5hZGRyZXNzZXMgfHwgYWouZGF0YSB8fCBhai5hZGRyZXNzZXNfZGF0YSB8fCAoQXJyYXkuaXNBcnJheShhaikgPyBhaiA6IG51bGwpOwogICAgICAgICAgICAgIGlmIChsaXN0ICYmICFBcnJheS5pc0FycmF5KGxpc3QpICYmIGxpc3QuYWRkcmVzc2VzX2RhdGEpIGxpc3QgPSBsaXN0LmFkZHJlc3Nlc19kYXRhOwogICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxpc3QpICYmIGxpc3QubGVuZ3RoKSB7CiAgICAgICAgICAgICAgICB2YXIgYSA9IGxpc3RbMF07CiAgICAgICAgICAgICAgICB2YXIgYUlkID0gYS5pZCB8fCBhLmFkZHJlc3NfaWQgfHwgJyc7CiAgICAgICAgICAgICAgICB2YXIgYUxhdCA9IGEubGF0aXR1ZGUgfHwgYS5sYXQgfHwgJyc7CiAgICAgICAgICAgICAgICB2YXIgYUxuZyA9IGEubG9uZ2l0dWRlIHx8IGEubG5nIHx8IGEubG9uIHx8ICcnOwogICAgICAgICAgICAgICAgaWYgKGFJZCkgeyB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCA9IFN0cmluZyhhSWQpOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfYWRkcmVzc19pZCcsIFN0cmluZyhhSWQpKTsgfQogICAgICAgICAgICAgICAgaWYgKGFMYXQgJiYgYUxuZykgeyB3aW5kb3cuX19ibFN0b3JlZExhdCA9IFN0cmluZyhhTGF0KTsgd2luZG93Ll9fYmxTdG9yZWRMbmcgPSBTdHJpbmcoYUxuZyk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sYXQnLCBTdHJpbmcoYUxhdCkpOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfbG5nJywgU3RyaW5nKGFMbmcpKTsgfQogICAgICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX1JFU09MVkVEJywgYWRkcmVzc0lkOiBTdHJpbmcoYUlkKSwgbGF0OiBTdHJpbmcoYUxhdCksIGxuZzogU3RyaW5nKGFMbmcpIH0pKTsKICAgICAgICAgICAgICAgIHZhciBhdXRoS2V5MiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoS2V5JykgfHwgJyc7CiAgICAgICAgICAgICAgICB2YXIgc2VsSCA9IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJywgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi9qc29uJywgJ2FjY2Vzc190b2tlbic6IGFjY2Vzc1Rva2VuLCAnYXV0aF9rZXknOiBhdXRoS2V5MiwgJ2FwcF9jbGllbnQnOiAnY29uc3VtZXJfd2ViJywgJ2xhdCc6IGFMYXQsICdsb24nOiBhTG5nLCAnZGV2aWNlX2lkJzogZGV2aWNlSWQsICdwbGF0Zm9ybSc6ICdtb2JpbGVfd2ViJyB9OwogICAgICAgICAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjIvYWRkcmVzcy9zZWxlY3QnLCB7CiAgICAgICAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICAgICAgICAgICAgICBoZWFkZXJzOiBzZWxILAogICAgICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFkZHJlc3NfaWQ6IE51bWJlcihhSWQpIH0pCiAgICAgICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKHIpIHsKICAgICAgICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX0RFQlVHJywgc291cmNlOiAndjIvc2VsZWN0L2F1dG8nLCBzdGF0dXM6IHIuc3RhdHVzIH0pKTsKICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKCkge30pOwogICAgICAgICAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjEvYWRkcmVzcy9zZWxlY3QnLCB7CiAgICAgICAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICAgICAgICAgICAgICBoZWFkZXJzOiBzZWxILAogICAgICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGlkOiBOdW1iZXIoYUlkKSB9KQogICAgICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICAgICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiAnQkxfQUREUl9ERUJVRycsIHNvdXJjZTogJ3YxL3NlbGVjdC9hdXRvJywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgICAgICAgICAgIGZldGNoKCdodHRwczovL2JsaW5raXQuY29tL3YxL2FkZHJlc3Nlcy9zZWxlY3QnLCB7CiAgICAgICAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICAgICAgICAgICAgICBoZWFkZXJzOiBzZWxILAogICAgICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFkZHJlc3NfaWQ6IE51bWJlcihhSWQpIH0pCiAgICAgICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKHIpIHsKICAgICAgICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX0RFQlVHJywgc291cmNlOiAndjFzL3NlbGVjdC9hdXRvJywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgICAgICAgICB9CiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHt9CiAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHsgd2luZG93Ll9fYmxBZGRyQXBpRmV0Y2hlZCA9IHRydWU7IH0pOwogICAgICAgIH0gY2F0Y2ggKGUpIHt9CiAgICAgIH0KICAgICAgX2JsQXV0b0ZldGNoKCk7CiAgICB9IGNhdGNoIChlKSB7fQogIH0pKCk7CiAgdHJ5IHsKICAgIHZhciBzdG9yYWdlS2V5cyA9IFsnY2FydCcsICdjaGVja291dCddOwogICAgZm9yICh2YXIgc2kgPSAwOyBzaSA8IHN0b3JhZ2VLZXlzLmxlbmd0aDsgc2krKykgewogICAgICB2YXIgc3YgPSBTdHJpbmcobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleXNbc2ldKSB8fCAnJyk7CiAgICAgIGlmIChzdikgewogICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoewogICAgICAgICAgdHlwZTogJ0JMX0xPQ0FMU1RPUkFHRScsIGtleTogc3RvcmFnZUtleXNbc2ldLCB2YWx1ZTogc3Yuc2xpY2UoMCwgNjAwMDApCiAgICAgICAgfSkpOwogICAgICB9CiAgICB9CiAgfSBjYXRjaCAoZTEwKSB7fQogIHRyeSB7CiAgICB2YXIgZGlhZyA9IFtdOwogICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsb2NhbFN0b3JhZ2UubGVuZ3RoICYmIGRpYWcubGVuZ3RoIDwgNjA7IGkrKykgewogICAgICB2YXIgayA9IFN0cmluZyhsb2NhbFN0b3JhZ2Uua2V5KGkpKTsKICAgICAgZGlhZy5wdXNoKHsgazogay5zbGljZSgwLCA2MCksIHY6IFN0cmluZyhsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrKSkuc2xpY2UoMCwgMTYwKSB9KTsKICAgIH0KICAgIHZhciBkYyA9ICcnOwogICAgdHJ5IHsgZGMgPSBTdHJpbmcoZG9jdW1lbnQuY29va2llKS5zbGljZSgwLCAxMjAwKTsgfSBjYXRjaCAoZTkpIHt9CiAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0RJQUcnLCBlbnRyaWVzOiBkaWFnLCBjb29raWU6IGRjIH0pKTsKICB9IGNhdGNoIChlOCkge30KICB9IGNhdGNoIChlTWFpbikgewogICAgd2luZG93Ll9fYmxTY3JpcHRFcnJvciA9IFN0cmluZyhlTWFpbiAmJiBlTWFpbi5tZXNzYWdlIHx8IGVNYWluKTsKICAgIHdpbmRvdy5fX2JsU2NyaXB0U3RhY2sgPSBTdHJpbmcoZU1haW4gJiYgZU1haW4uc3RhY2sgfHwgJycpLnNsaWNlKDAsIDUwMCk7CiAgICB0cnkgeyB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0JSSURHRV9FUlJPUicsIGVycm9yOiB3aW5kb3cuX19ibFNjcmlwdEVycm9yLCBzdGFjazogd2luZG93Ll9fYmxTY3JpcHRTdGFjayB9KSk7IH0gY2F0Y2ggKGUyKSB7fQogIH0KfSkoKTsK';

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
    registerBlinkitBridgeClearLocalStorage(() => {
      webViewRef.current?.injectJavaScript(
        `localStorage.removeItem('selected_address_id');
         localStorage.removeItem('selected_lat');
         localStorage.removeItem('selected_lng');
         localStorage.removeItem('addressesV2');
         localStorage.removeItem('addresses');
         localStorage.removeItem('auth');
         localStorage.removeItem('authKey');
         localStorage.removeItem('deviceId');
         window.__blStoredAddrId = null;
         window.__blStoredLat = null;
         window.__blStoredLng = null;
         window.__blAddrApiFetched = false;
         'cleared';`
      );
    });
    return () => {
      unregisterBlinkitInjector(injector);
      unregisterBlinkitBridgeReload();
      unregisterBlinkitBridgeClearLocalStorage();
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
      if (msg?.type === 'BL_CART_REQ') {
        console.log(`[BlinkitBridge] cart request: address_id=${msg.addressId}, stored=${msg.storedAddrId}, injected=${msg.injected || false}, items=${msg.items}`);
      }
      if (msg?.type === 'BL_BRIDGE_ERROR') {
        console.error(`[BlinkitBridge] SCRIPT ERROR: ${msg.error}\n${msg.stack}`);
      }
      if (msg?.type === 'BL_BRIDGE_PROBE') {
        console.log(`[BlinkitBridge] probe: ran=${msg.scriptRan}, installed=${msg.installed}, error=${msg.scriptError || 'none'}`);
      }
    } catch {}
    handleBlinkitBridgeMessage(payload);
  };

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ uri: 'https://blinkit.com/' }}
        onMessage={handleMessage}
        onLoadEnd={() => {
          webViewRef.current?.injectJavaScript(`
            (function(){
              var b64='${BRIDGE_SCRIPT_B64}';
              var js=atob(b64);
              var el=document.createElement('script');
              el.textContent=js;
              document.head.appendChild(el);
            })(); true;
          `);
          setTimeout(() => {
            webViewRef.current?.injectJavaScript(`
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'BL_BRIDGE_PROBE',scriptRan:!!window.__blScriptRan,installed:!!window.__blBridgeInstalled,scriptError:window.__blScriptError||null})); true;
            `);
          }, 2000);
        }}
        onError={(e) => console.warn('[BlinkitBridge] onError:', e.nativeEvent)}
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
