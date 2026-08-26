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

const BRIDGE_SCRIPT_B64 = 'CihmdW5jdGlvbigpIHsKICB0cnkgewogIGlmICh3aW5kb3cuX19ibEJyaWRnZUluc3RhbGxlZCkgcmV0dXJuOwogIHdpbmRvdy5fX2JsQnJpZGdlSW5zdGFsbGVkID0gdHJ1ZTsKICB3aW5kb3cuX19ibFNjcmlwdFJhbiA9IHRydWU7CiAgd2luZG93Ll9fYmxTY3JpcHRFcnJvciA9IG51bGw7CgogIC8vIFN0b3JlZCBkZWxpdmVyeSBhZGRyZXNzIC0tIHNldCBieSBSZWFjdCBOYXRpdmUgYWZ0ZXIgcmVhZGluZyBBc3luY1N0b3JhZ2UuCiAgLy8gX19ibEhhbmRsZVJlcXVlc3QgdXNlcyB0aGlzIHRvIGZvcmNlLWluamVjdCBhZGRyZXNzX2lkIGludG8gL3Y1L2NhcnRzCiAgLy8gcmVxdWVzdCBib2RpZXMgc28gdGhlIHNlcnZlciBhbHdheXMgc2VlcyB0aGUgdXNlcidzIGFkZHJlc3MgcmVnYXJkbGVzcwogIC8vIG9mIHRoZSBTUEEncyBpbnRlcm5hbCBzdGF0ZS4KICB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCA9IG51bGw7CiAgd2luZG93Ll9fYmxTdG9yZWRMYXQgPSBudWxsOwogIHdpbmRvdy5fX2JsU3RvcmVkTG5nID0gbnVsbDsKICB3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkID0gZmFsc2U7CgogIHdpbmRvdy5fX2JsQXBwbHlDb29raWVzID0gZnVuY3Rpb24oY29va2llU3RyKSB7CiAgICB0cnkgewogICAgICB2YXIgcGFydHMgPSBTdHJpbmcoY29va2llU3RyIHx8ICcnKS5zcGxpdCgvO1xccyovKTsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7IGkrKykgewogICAgICAgIGlmICghcGFydHNbaV0pIGNvbnRpbnVlOwogICAgICAgIHZhciBlcSA9IHBhcnRzW2ldLmluZGV4T2YoJz0nKTsKICAgICAgICBpZiAoZXEgPD0gMCkgY29udGludWU7CiAgICAgICAgZG9jdW1lbnQuY29va2llID0gcGFydHNbaV0gKyAnOyBwYXRoPS87IGRvbWFpbj0uYmxpbmtpdC5jb207IHNlY3VyZTsgU2FtZVNpdGU9Tm9uZSc7CiAgICAgIH0KICAgIH0gY2F0Y2ggKGUpIHt9CiAgfTsKCiAgLy8gRXh0cmFjdCBhY2Nlc3NfdG9rZW4gZnJvbSBsb2NhbFN0b3JhZ2UoJ2F1dGgnKSBvciBncl8xX2FjY2Vzc1Rva2VuIGNvb2tpZS4KICAvLyBJbiBBUEsgYnVpbGRzLCBzaGFyZWRDb29raWVzRW5hYmxlZCBzaGFyZXMgY29va2llcyBiZXR3ZWVuIFdlYlZpZXdzIGJ1dCBOT1QKICAvLyBsb2NhbFN0b3JhZ2UsIHNvIHRoZSBjb29raWUgZmFsbGJhY2sgaXMgZXNzZW50aWFsIGZvciBmcmVzaCBpbnN0YWxscy4KICB3aW5kb3cuX19ibEdldEFjY2Vzc1Rva2VuID0gZnVuY3Rpb24oKSB7CiAgICB0cnkgewogICAgICB2YXIgYXV0aFJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoJyk7CiAgICAgIGlmIChhdXRoUmF3KSB7IHZhciBhbyA9IEpTT04ucGFyc2UoYXV0aFJhdyk7IGlmIChhby5hY2Nlc3NUb2tlbikgcmV0dXJuIGFvLmFjY2Vzc1Rva2VuOyB9CiAgICB9IGNhdGNoIChlKSB7fQogICAgdHJ5IHsKICAgICAgdmFyIGNvb2tpZXMgPSBkb2N1bWVudC5jb29raWUuc3BsaXQoJzsnKTsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb29raWVzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgdmFyIGMgPSBjb29raWVzW2ldLnRyaW0oKTsKICAgICAgICBpZiAoYy5pbmRleE9mKCdncl8xX2FjY2Vzc1Rva2VuPScpID09PSAwKSB7CiAgICAgICAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KGMuc3Vic3RyaW5nKCdncl8xX2FjY2Vzc1Rva2VuPScubGVuZ3RoKSk7CiAgICAgICAgfQogICAgICB9CiAgICB9IGNhdGNoIChlMikge30KICAgIHJldHVybiAnJzsKICB9OwoKICB3aW5kb3cuX19ibFNldERlbGl2ZXJ5Q29udGV4dCA9IGZ1bmN0aW9uKGFkZHJJZCwgbGF0LCBsbmcpIHsKICAgIHRyeSB7CiAgICAgIC8vIEZhbGwgYmFjayB0byBCbGlua2l0J3Mgb3duIGxvY2FsU3RvcmFnZSBpZiBSZWFjdCBOYXRpdmUgZGlkbid0IHByb3ZpZGUgbGF0L2xuZwogICAgICBpZiAoIWxhdCB8fCAhbG5nKSB7CiAgICAgICAgdHJ5IHsKICAgICAgICAgIHZhciBsc0xhdCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzZWxlY3RlZF9sYXQnKTsKICAgICAgICAgIHZhciBsc0xuZyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzZWxlY3RlZF9sbmcnKTsKICAgICAgICAgIGlmIChsc0xhdCAmJiBsc0xuZykgeyBsYXQgPSBsYXQgfHwgbHNMYXQ7IGxuZyA9IGxuZyB8fCBsc0xuZzsgfQogICAgICAgIH0gY2F0Y2ggKGUpIHt9CiAgICAgIH0KICAgICAgd2luZG93Ll9fYmxTdG9yZWRBZGRySWQgPSBhZGRySWQgfHwgbnVsbDsKICAgICAgd2luZG93Ll9fYmxTdG9yZWRMYXQgPSBsYXQgfHwgbnVsbDsKICAgICAgd2luZG93Ll9fYmxTdG9yZWRMbmcgPSBsbmcgfHwgbnVsbDsKICAgICAgaWYgKGFkZHJJZCkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2FkZHJlc3NfaWQnLCBTdHJpbmcoYWRkcklkKSk7CiAgICAgIGlmIChsYXQpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sYXQnLCBTdHJpbmcobGF0KSk7CiAgICAgIGlmIChsbmcpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sbmcnLCBTdHJpbmcobG5nKSk7CiAgICAgIC8vIEFsc28gdHJ5IHRvIHNldCBCbGlua2l0IFNQQSdzIG93biBhZGRyZXNzIHN0b3JhZ2Uga2V5cwogICAgICB0cnkgewogICAgICAgIHZhciBhZGRyS2V5ID0gJ2FkZHJlc3Nlc19kYXRhJzsKICAgICAgICB2YXIgZXhpc3RpbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShhZGRyS2V5KTsKICAgICAgICBpZiAoZXhpc3RpbmcgJiYgYWRkcklkKSB7CiAgICAgICAgICB2YXIgcGFyc2VkID0gSlNPTi5wYXJzZShleGlzdGluZyk7CiAgICAgICAgICBpZiAocGFyc2VkICYmIHBhcnNlZC5hZGRyZXNzZXMgJiYgQXJyYXkuaXNBcnJheShwYXJzZWQuYWRkcmVzc2VzLmFkZHJlc3Nlc19kYXRhKSkgewogICAgICAgICAgICB2YXIgbWF0Y2ggPSBwYXJzZWQuYWRkcmVzc2VzLmFkZHJlc3Nlc19kYXRhLmZpbmQoZnVuY3Rpb24oYSkgeyByZXR1cm4gU3RyaW5nKGEuaWQpID09PSBTdHJpbmcoYWRkcklkKTsgfSk7CiAgICAgICAgICAgIGlmIChtYXRjaCkgewogICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9hZGRyZXNzX2lkJywgU3RyaW5nKGFkZHJJZCkpOwogICAgICAgICAgICB9CiAgICAgICAgICB9CiAgICAgICAgfQogICAgICB9IGNhdGNoIChlMikge30KICAgICAgLy8gQ2FsbCBCbGlua2l0J3MgL3Y0L2FkZHJlc3MgQVBJIHRvIHNldCBzZXJ2ZXItc2lkZSBzZXNzaW9uIGFkZHJlc3MuCiAgICAgIC8vIFRoZSBhdXRvLWZldGNoIElJRkUgaGFuZGxlcyB0aGlzIHdpdGggcmV0cmllcy4gSGVyZSB3ZSBvbmx5IGNhbGwKICAgICAgLy8gU0VMRUNUIEFQSXMgYXMgYSBiZXN0LWVmZm9ydCBiYWNrdXAg4oCUIHRoZXkgb2Z0ZW4gNDA0IGJ1dCBkb24ndCBodXJ0LgogICAgICBpZiAoYWRkcklkKSB7CiAgICAgICAgdmFyIGJMYXQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc2VsZWN0ZWRfbGF0JykgfHwgbGF0IHx8ICcxMi45NzE2JzsKICAgICAgICB2YXIgYkxuZyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzZWxlY3RlZF9sbmcnKSB8fCBsbmcgfHwgJzc3LjU5NDYnOwogICAgICAgIHZhciBhY2Nlc3NUb2tlbiA9IHdpbmRvdy5fX2JsR2V0QWNjZXNzVG9rZW4oKTsKICAgICAgICB2YXIgZGV2aWNlSWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKSB8fCAnJzsKICAgICAgICB2YXIgYXV0aEtleSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoS2V5JykgfHwgJyc7CiAgICAgICAgdmFyIHNlbGVjdEhlYWRlcnMgPSB7CiAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLAogICAgICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi9qc29uJywKICAgICAgICAgICdhY2Nlc3NfdG9rZW4nOiBhY2Nlc3NUb2tlbiwKICAgICAgICAgICdhdXRoX2tleSc6IGF1dGhLZXksCiAgICAgICAgICAnYXBwX2NsaWVudCc6ICdjb25zdW1lcl93ZWInLAogICAgICAgICAgJ2xhdCc6IGJMYXQsCiAgICAgICAgICAnbG9uJzogYkxuZywKICAgICAgICAgICdkZXZpY2VfaWQnOiBkZXZpY2VJZCwKICAgICAgICAgICdwbGF0Zm9ybSc6ICdtb2JpbGVfd2ViJwogICAgICAgIH07CiAgICAgICAgLy8gQWRkcmVzcyBzZWxlY3QgdmFyaWFudHMgZm9yIHNlcnZlci1zaWRlIHNlc3Npb24KICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92Mi9hZGRyZXNzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFkZHJlc3NfaWQ6IE51bWJlcihhZGRySWQpIH0pCiAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2Mi9zZWxlY3QnLCBzdGF0dXM6IHIuc3RhdHVzIH0pKTsKICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92MS9hZGRyZXNzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGlkOiBOdW1iZXIoYWRkcklkKSB9KQogICAgICAgIH0pLnRoZW4oZnVuY3Rpb24ocikgewogICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX0RFQlVHJywgc291cmNlOiAndjEvc2VsZWN0Jywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oKSB7fSk7CiAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjEvYWRkcmVzc2VzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFkZHJlc3NfaWQ6IE51bWJlcihhZGRySWQpIH0pCiAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2MXMvc2VsZWN0Jywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oKSB7fSk7CiAgICAgIH0KICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgdHlwZTogJ0JMX0FERFJfU0VUJywgYWRkcklkOiBhZGRySWQsIGxhdDogbGF0LCBsbmc6IGxuZwogICAgICB9KSk7CiAgICB9IGNhdGNoIChlKSB7fQogIH07CgogIHdpbmRvdy5fX2JsSGFuZGxlUmVxdWVzdCA9IGZ1bmN0aW9uKGlkLCB1cmwsIG1ldGhvZCwgYm9keSwgZXh0cmFIZWFkZXJzSnNvbikgewogICAgdmFyIG9wdHMgPSB7CiAgICAgIG1ldGhvZDogbWV0aG9kIHx8ICdHRVQnLAogICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICBoZWFkZXJzOiB7ICdBY2NlcHQnOiAnYXBwbGljYXRpb24vanNvbiwgdGV4dC9wbGFpbiwgKi8qJyB9CiAgICB9OwogICAgdHJ5IHsKICAgICAgdmFyIGV4dHJhID0gSlNPTi5wYXJzZShleHRyYUhlYWRlcnNKc29uIHx8ICd7fScpOwogICAgICBmb3IgKHZhciBrIGluIGV4dHJhKSB7IGlmIChleHRyYVtrXSkgb3B0cy5oZWFkZXJzW2tdID0gZXh0cmFba107IH0KICAgIH0gY2F0Y2ggKGUyKSB7fQogICAgdHJ5IHsKICAgICAgdmFyIGFrID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2F1dGhLZXknKTsKICAgICAgaWYgKGFrICYmICFvcHRzLmhlYWRlcnNbJ2F1dGhfa2V5J10pIG9wdHMuaGVhZGVyc1snYXV0aF9rZXknXSA9IGFrOwogICAgfSBjYXRjaCAoZTMpIHt9CiAgICB0cnkgewogICAgICB2YXIgZHYgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKTsKICAgICAgaWYgKGR2KSB7CiAgICAgICAgaWYgKCFvcHRzLmhlYWRlcnNbJ0RldmljZUlEJ10pIG9wdHMuaGVhZGVyc1snRGV2aWNlSUQnXSA9IGR2OwogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydkZXZpY2VfaWQnXSkgb3B0cy5oZWFkZXJzWydkZXZpY2VfaWQnXSA9IGR2OwogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydkZXZpY2VpZCddKSBvcHRzLmhlYWRlcnNbJ2RldmljZWlkJ10gPSBkdjsKICAgICAgICBpZiAoIW9wdHMuaGVhZGVyc1sneC1kZXZpY2UtaWQnXSkgb3B0cy5oZWFkZXJzWyd4LWRldmljZS1pZCddID0gZHY7CiAgICAgIH0KICAgIH0gY2F0Y2ggKGUxMSkge30KICAgIGlmIChib2R5KSB7CiAgICAgIG9wdHMuaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7CiAgICAgIC8vIEZvcmNlLWluamVjdCBhZGRyZXNzX2lkIGludG8gL3Y1L2NhcnRzIFBPU1QgYm9kaWVzLiBUaGUgU1BBIG1heQogICAgICAvLyBub3QgaGF2ZSBhbiBhZGRyZXNzIHNlbGVjdGVkIGluIGl0cyBpbnRlcm5hbCBzdGF0ZSwgYnV0IG91ciBzdG9yZWQKICAgICAgLy8gYWRkcmVzcyBlbnN1cmVzIHRoZSBzZXJ2ZXIgYWx3YXlzIHByaWNlcyB1bmRlciB0aGUgY29ycmVjdCB6b25lLgogICAgICBpZiAoL1wvdjVcL2NhcnRzLy50ZXN0KHVybCkgJiYgbWV0aG9kID09PSAnUE9TVCcpIHsKICAgICAgICB0cnkgewogICAgICAgICAgdmFyIGIgPSBKU09OLnBhcnNlKGJvZHkpOwogICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9DQVJUX1JFUScsIHVybDogdXJsLCBhZGRyZXNzSWQ6IGIuYWRkcmVzc19pZCB8fCBudWxsLCBzdG9yZWRBZGRySWQ6IHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkIHx8IG51bGwsIGl0ZW1zOiAoYi5pdGVtcyB8fCBbXSkubGVuZ3RoIH0pKTsKICAgICAgICAgIGlmICghYi5hZGRyZXNzX2lkICYmIHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkKSB7CiAgICAgICAgICAgIGIuYWRkcmVzc19pZCA9IE51bWJlcih3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCk7CiAgICAgICAgICAgIGJvZHkgPSBKU09OLnN0cmluZ2lmeShiKTsKICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9DQVJUX1JFUScsIGluamVjdGVkOiB0cnVlLCBhZGRyZXNzSWQ6IGIuYWRkcmVzc19pZCB9KSk7CiAgICAgICAgICB9CiAgICAgICAgfSBjYXRjaCAoZTQpIHt9CiAgICAgIH0KICAgICAgb3B0cy5ib2R5ID0gYm9keTsKICAgIH0KICAgIGZldGNoKHVybCwgb3B0cykudGhlbihmdW5jdGlvbihyZXMpIHsKICAgICAgcmV0dXJuIHJlcy50ZXh0KCkudGhlbihmdW5jdGlvbih0KSB7CiAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgICB0eXBlOiAnQkxfQVBJX1JFU1BPTlNFJywgaWQ6IGlkLCBzdGF0dXM6IHJlcy5zdGF0dXMsIHRleHQ6IFN0cmluZyh0KS5zbGljZSgwLCAxNTAwMDAwKQogICAgICAgIH0pKTsKICAgICAgfSk7CiAgICB9KS5jYXRjaChmdW5jdGlvbihlKSB7CiAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHR5cGU6ICdCTF9BUElfUkVTUE9OU0UnLCBpZDogaWQsIHN0YXR1czogMCwgdGV4dDogU3RyaW5nKChlICYmIGUubWVzc2FnZSkgfHwgZSkKICAgICAgfSkpOwogICAgfSk7CiAgfTsKICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0JSSURHRV9SRUFEWScgfSkpOwogIC8vIEF1dG8tZmV0Y2ggYWRkcmVzc2VzIHZpYSAvdjQvYWRkcmVzcyBvbiBldmVyeSBicmlkZ2UgbG9hZC4KICAvLyBJbiBBUEsgYnVpbGRzLCBsb2NhbFN0b3JhZ2UgaXNuJ3Qgc2hhcmVkIGJldHdlZW4gV2ViVmlld3MsIHNvIHRoZQogIC8vIGFjY2Vzc190b2tlbiBjb29raWUgKGdyXzFfYWNjZXNzVG9rZW4pIGlzIHVzZWQgYXMgZmFsbGJhY2suCiAgLy8gUmV0cmllcyB1cCB0byAxMCB0aW1lcyAoMXMgYXBhcnQpIHVudGlsIHRoZSBjb29raWUgaXMgYXZhaWxhYmxlLgogIChmdW5jdGlvbigpIHsKICAgIHRyeSB7CiAgICAgIGlmICh3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkKSByZXR1cm47CiAgICAgIHZhciBfYmxGZXRjaEF0dGVtcHRzID0gMDsKICAgICAgdmFyIF9ibE1heEF0dGVtcHRzID0gMTA7CiAgICAgIGZ1bmN0aW9uIF9ibEF1dG9GZXRjaCgpIHsKICAgICAgICB0cnkgewogICAgICAgICAgaWYgKHdpbmRvdy5fX2JsQWRkckFwaUZldGNoZWQpIHJldHVybjsKICAgICAgICAgIF9ibEZldGNoQXR0ZW1wdHMrKzsKICAgICAgICAgIHZhciBhY2Nlc3NUb2tlbiA9IHdpbmRvdy5fX2JsR2V0QWNjZXNzVG9rZW4oKTsKICAgICAgICAgIGlmICghYWNjZXNzVG9rZW4pIHsKICAgICAgICAgICAgaWYgKF9ibEZldGNoQXR0ZW1wdHMgPCBfYmxNYXhBdHRlbXB0cykgc2V0VGltZW91dChfYmxBdXRvRmV0Y2gsIDEwMDApOwogICAgICAgICAgICByZXR1cm47CiAgICAgICAgICB9CiAgICAgICAgICB2YXIgbG9jUmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2xvY2F0aW9uJyk7CiAgICAgICAgICB2YXIgbGF0ID0gJzEyLjk3MTYnLCBsbmcgPSAnNzcuNTk0Nic7CiAgICAgICAgICBpZiAobG9jUmF3KSB7IHRyeSB7IHZhciBsb2MgPSBKU09OLnBhcnNlKGxvY1Jhdyk7IGxhdCA9IGxvYy5jb29yZHMubGF0IHx8IGxhdDsgbG5nID0gbG9jLmNvb3Jkcy5sb24gfHwgbG5nOyB9IGNhdGNoIChlKSB7fSB9CiAgICAgICAgICB2YXIgZGV2aWNlSWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKSB8fCAnJzsKICAgICAgICAgIHZhciB1cmwgPSAnaHR0cHM6Ly9ibGlua2l0LmNvbS92NC9hZGRyZXNzP2N1cl9sYXQ9JyArIGxhdCArICcmY3VyX2xvbj0nICsgbG5nOwogICAgICAgICAgZmV0Y2godXJsLCB7CiAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsCiAgICAgICAgICAgIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsCiAgICAgICAgICAgIGhlYWRlcnM6IHsKICAgICAgICAgICAgICAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLAogICAgICAgICAgICAgICdhY2Nlc3NfdG9rZW4nOiBhY2Nlc3NUb2tlbiwKICAgICAgICAgICAgICAnYXV0aF9rZXknOiAnYzc2MWVjMzYzM2MyMmFmYWQ5MzRmYjE3YTY2Mzg1YzFjMDZjNTQ3MmI0ODk4Yjg2NmI3MzA2MTg2ZDBiYjQ3NycsCiAgICAgICAgICAgICAgJ2FwcF9jbGllbnQnOiAnY29uc3VtZXJfd2ViJywKICAgICAgICAgICAgICAnbGF0JzogbGF0LAogICAgICAgICAgICAgICdsb24nOiBsbmcsCiAgICAgICAgICAgICAgJ2RldmljZV9pZCc6IGRldmljZUlkLAogICAgICAgICAgICAgICdwbGF0Zm9ybSc6ICdtb2JpbGVfd2ViJwogICAgICAgICAgICB9CiAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKHIpIHsKICAgICAgICAgICAgd2luZG93Ll9fYmxBZGRyQXBpRmV0Y2hlZCA9IHRydWU7CiAgICAgICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiAnQkxfQUREUl9ERUJVRycsIHNvdXJjZTogJ3Y0L2F1dG8nLCBzdGF0dXM6IHIuc3RhdHVzIH0pKTsKICAgICAgICAgICAgaWYgKCFyLm9rKSByZXR1cm4gbnVsbDsKICAgICAgICAgICAgcmV0dXJuIHIudGV4dCgpOwogICAgICAgICAgfSkudGhlbihmdW5jdGlvbih0KSB7CiAgICAgICAgICAgIGlmICghdCkgcmV0dXJuOwogICAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2NC9hdXRvJywgYm9keTogdC5zbGljZSgwLCAyMDAwKSB9KSk7CiAgICAgICAgICAgIHRyeSB7CiAgICAgICAgICAgICAgdmFyIGFqID0gSlNPTi5wYXJzZSh0KTsKICAgICAgICAgICAgICB2YXIgbGlzdCA9IGFqLmFkZHJlc3NlcyB8fCBhai5kYXRhIHx8IGFqLmFkZHJlc3Nlc19kYXRhIHx8IChBcnJheS5pc0FycmF5KGFqKSA/IGFqIDogbnVsbCk7CiAgICAgICAgICAgICAgaWYgKGxpc3QgJiYgIUFycmF5LmlzQXJyYXkobGlzdCkgJiYgbGlzdC5hZGRyZXNzZXNfZGF0YSkgbGlzdCA9IGxpc3QuYWRkcmVzc2VzX2RhdGE7CiAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGlzdCkgJiYgbGlzdC5sZW5ndGgpIHsKICAgICAgICAgICAgICAgIHZhciBhID0gbGlzdFswXTsKICAgICAgICAgICAgICAgIHZhciBhSWQgPSBhLmlkIHx8IGEuYWRkcmVzc19pZCB8fCAnJzsKICAgICAgICAgICAgICAgIHZhciBhTGF0ID0gYS5sYXRpdHVkZSB8fCBhLmxhdCB8fCAnJzsKICAgICAgICAgICAgICAgIHZhciBhTG5nID0gYS5sb25naXR1ZGUgfHwgYS5sbmcgfHwgYS5sb24gfHwgJyc7CiAgICAgICAgICAgICAgICBpZiAoYUlkKSB7IHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkID0gU3RyaW5nKGFJZCk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9hZGRyZXNzX2lkJywgU3RyaW5nKGFJZCkpOyB9CiAgICAgICAgICAgICAgICBpZiAoYUxhdCAmJiBhTG5nKSB7IHdpbmRvdy5fX2JsU3RvcmVkTGF0ID0gU3RyaW5nKGFMYXQpOyB3aW5kb3cuX19ibFN0b3JlZExuZyA9IFN0cmluZyhhTG5nKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2xhdCcsIFN0cmluZyhhTGF0KSk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sbmcnLCBTdHJpbmcoYUxuZykpOyB9CiAgICAgICAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfUkVTT0xWRUQnLCBhZGRyZXNzSWQ6IFN0cmluZyhhSWQpLCBsYXQ6IFN0cmluZyhhTGF0KSwgbG5nOiBTdHJpbmcoYUxuZykgfSkpOwogICAgICAgICAgICAgICAgdmFyIGF1dGhLZXkyID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2F1dGhLZXknKSB8fCAnJzsKICAgICAgICAgICAgICAgIHZhciBzZWxIID0geyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnYWNjZXNzX3Rva2VuJzogYWNjZXNzVG9rZW4sICdhdXRoX2tleSc6IGF1dGhLZXkyLCAnYXBwX2NsaWVudCc6ICdjb25zdW1lcl93ZWInLCAnbGF0JzogYUxhdCwgJ2xvbic6IGFMbmcsICdkZXZpY2VfaWQnOiBkZXZpY2VJZCwgJ3BsYXRmb3JtJzogJ21vYmlsZV93ZWInIH07CiAgICAgICAgICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92Mi9hZGRyZXNzL3NlbGVjdCcsIHsKICAgICAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsCiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHNlbEgsCiAgICAgICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYWRkcmVzc19pZDogTnVtYmVyKGFJZCkgfSkKICAgICAgICAgICAgICAgIH0pLnRoZW4oZnVuY3Rpb24ocikgewogICAgICAgICAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2Mi9zZWxlY3QvYXV0bycsIHN0YXR1czogci5zdGF0dXMgfSkpOwogICAgICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oKSB7fSk7CiAgICAgICAgICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92MS9hZGRyZXNzL3NlbGVjdCcsIHsKICAgICAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsCiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHNlbEgsCiAgICAgICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgaWQ6IE51bWJlcihhSWQpIH0pCiAgICAgICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKHIpIHsKICAgICAgICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX0RFQlVHJywgc291cmNlOiAndjEvc2VsZWN0L2F1dG8nLCBzdGF0dXM6IHIuc3RhdHVzIH0pKTsKICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKCkge30pOwogICAgICAgICAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjEvYWRkcmVzc2VzL3NlbGVjdCcsIHsKICAgICAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsCiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHNlbEgsCiAgICAgICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYWRkcmVzc19pZDogTnVtYmVyKGFJZCkgfSkKICAgICAgICAgICAgICAgIH0pLnRoZW4oZnVuY3Rpb24ocikgewogICAgICAgICAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2MXMvc2VsZWN0L2F1dG8nLCBzdGF0dXM6IHIuc3RhdHVzIH0pKTsKICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKCkge30pOwogICAgICAgICAgICAgIH0KICAgICAgICAgICAgfSBjYXRjaCAoZSkge30KICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKCkgeyB3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkID0gdHJ1ZTsgfSk7CiAgICAgICAgfSBjYXRjaCAoZSkge30KICAgICAgfQogICAgICBfYmxBdXRvRmV0Y2goKTsKICAgIH0gY2F0Y2ggKGUpIHt9CiAgfSkoKTsKICB0cnkgewogICAgdmFyIHN0b3JhZ2VLZXlzID0gWydjYXJ0JywgJ2NoZWNrb3V0J107CiAgICBmb3IgKHZhciBzaSA9IDA7IHNpIDwgc3RvcmFnZUtleXMubGVuZ3RoOyBzaSsrKSB7CiAgICAgIHZhciBzdiA9IFN0cmluZyhsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5c1tzaV0pIHx8ICcnKTsKICAgICAgaWYgKHN2KSB7CiAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgICB0eXBlOiAnQkxfTE9DQUxTVE9SQUdFJywga2V5OiBzdG9yYWdlS2V5c1tzaV0sIHZhbHVlOiBzdi5zbGljZSgwLCA2MDAwMCkKICAgICAgICB9KSk7CiAgICAgIH0KICAgIH0KICB9IGNhdGNoIChlMTApIHt9CiAgdHJ5IHsKICAgIHZhciBkaWFnID0gW107CiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxvY2FsU3RvcmFnZS5sZW5ndGggJiYgZGlhZy5sZW5ndGggPCA2MDsgaSsrKSB7CiAgICAgIHZhciBrID0gU3RyaW5nKGxvY2FsU3RvcmFnZS5rZXkoaSkpOwogICAgICBkaWFnLnB1c2goeyBrOiBrLnNsaWNlKDAsIDYwKSwgdjogU3RyaW5nKGxvY2FsU3RvcmFnZS5nZXRJdGVtKGspKS5zbGljZSgwLCAxNjApIH0pOwogICAgfQogICAgdmFyIGRjID0gJyc7CiAgICB0cnkgeyBkYyA9IFN0cmluZyhkb2N1bWVudC5jb29raWUpLnNsaWNlKDAsIDEyMDApOyB9IGNhdGNoIChlOSkge30KICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiAnQkxfRElBRycsIGVudHJpZXM6IGRpYWcsIGNvb2tpZTogZGMgfSkpOwogIH0gY2F0Y2ggKGU4KSB7fQogIH0gY2F0Y2ggKGVNYWluKSB7CiAgICB3aW5kb3cuX19ibFNjcmlwdEVycm9yID0gU3RyaW5nKGVNYWluICYmIGVNYWluLm1lc3NhZ2UgfHwgZU1haW4pOwogICAgd2luZG93Ll9fYmxTY3JpcHRTdGFjayA9IFN0cmluZyhlTWFpbiAmJiBlTWFpbi5zdGFjayB8fCAnJykuc2xpY2UoMCwgNTAwKTsKICAgIHRyeSB7IHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiAnQkxfQlJJREdFX0VSUk9SJywgZXJyb3I6IHdpbmRvdy5fX2JsU2NyaXB0RXJyb3IsIHN0YWNrOiB3aW5kb3cuX19ibFNjcmlwdFN0YWNrIH0pKTsgfSBjYXRjaCAoZTIpIHt9CiAgfQp9KSgpOwo=';

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
