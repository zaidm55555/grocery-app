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
      // Only fetch once -- no need to spam the API.
      if (addrId && !window.__blAddrApiFetched) {
        window.__blAddrApiFetched = true;
        var bLat = localStorage.getItem('selected_lat') || lat || '12.9716';
        var bLng = localStorage.getItem('selected_lng') || lng || '77.5946';
        var accessToken = '';
        try { var authObj = JSON.parse(localStorage.getItem('auth') || '{}'); accessToken = authObj.accessToken || ''; } catch (e) {}
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
  // This ensures the server-side session always has the correct address,
  // even if Blinkit's SPA already wrote selected_address_id to localStorage.
  // The API response provides authoritative lat/lng for pricing.
  // Only runs once per bridge instance.
  (function() {
    try {
      if (window.__blAddrApiFetched) return;
      var authRaw = localStorage.getItem('auth');
      if (!authRaw) return;
      var authObj = JSON.parse(authRaw);
      var accessToken = authObj.accessToken || '';
      if (!accessToken) return;
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
            // CRITICAL: also call address SELECT APIs so the server session
            // knows which address to use for delivery pricing.
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
  } catch (eMain) {
    window.__blScriptError = String(eMain && eMain.message || eMain);
    window.__blScriptStack = String(eMain && eMain.stack || '').slice(0, 500);
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BL_BRIDGE_ERROR', error: window.__blScriptError, stack: window.__blScriptStack })); } catch (e2) {}
  }
})();
`;

const BRIDGE_SCRIPT_B64 = 'CihmdW5jdGlvbigpIHsKICB0cnkgewogIGlmICh3aW5kb3cuX19ibEJyaWRnZUluc3RhbGxlZCkgcmV0dXJuOwogIHdpbmRvdy5fX2JsQnJpZGdlSW5zdGFsbGVkID0gdHJ1ZTsKICB3aW5kb3cuX19ibFNjcmlwdFJhbiA9IHRydWU7CiAgd2luZG93Ll9fYmxTY3JpcHRFcnJvciA9IG51bGw7CgogIC8vIFN0b3JlZCBkZWxpdmVyeSBhZGRyZXNzIC0tIHNldCBieSBSZWFjdCBOYXRpdmUgYWZ0ZXIgcmVhZGluZyBBc3luY1N0b3JhZ2UuCiAgLy8gX19ibEhhbmRsZVJlcXVlc3QgdXNlcyB0aGlzIHRvIGZvcmNlLWluamVjdCBhZGRyZXNzX2lkIGludG8gL3Y1L2NhcnRzCiAgLy8gcmVxdWVzdCBib2RpZXMgc28gdGhlIHNlcnZlciBhbHdheXMgc2VlcyB0aGUgdXNlcidzIGFkZHJlc3MgcmVnYXJkbGVzcwogIC8vIG9mIHRoZSBTUEEncyBpbnRlcm5hbCBzdGF0ZS4KICB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCA9IG51bGw7CiAgd2luZG93Ll9fYmxTdG9yZWRMYXQgPSBudWxsOwogIHdpbmRvdy5fX2JsU3RvcmVkTG5nID0gbnVsbDsKICB3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkID0gZmFsc2U7CgogIHdpbmRvdy5fX2JsQXBwbHlDb29raWVzID0gZnVuY3Rpb24oY29va2llU3RyKSB7CiAgICB0cnkgewogICAgICB2YXIgcGFydHMgPSBTdHJpbmcoY29va2llU3RyIHx8ICcnKS5zcGxpdCgvO1xccyovKTsKICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXJ0cy5sZW5ndGg7IGkrKykgewogICAgICAgIGlmICghcGFydHNbaV0pIGNvbnRpbnVlOwogICAgICAgIHZhciBlcSA9IHBhcnRzW2ldLmluZGV4T2YoJz0nKTsKICAgICAgICBpZiAoZXEgPD0gMCkgY29udGludWU7CiAgICAgICAgZG9jdW1lbnQuY29va2llID0gcGFydHNbaV0gKyAnOyBwYXRoPS87IGRvbWFpbj0uYmxpbmtpdC5jb207IHNlY3VyZTsgU2FtZVNpdGU9Tm9uZSc7CiAgICAgIH0KICAgIH0gY2F0Y2ggKGUpIHt9CiAgfTsKCiAgd2luZG93Ll9fYmxTZXREZWxpdmVyeUNvbnRleHQgPSBmdW5jdGlvbihhZGRySWQsIGxhdCwgbG5nKSB7CiAgICB0cnkgewogICAgICAvLyBGYWxsIGJhY2sgdG8gQmxpbmtpdCdzIG93biBsb2NhbFN0b3JhZ2UgaWYgUmVhY3QgTmF0aXZlIGRpZG4ndCBwcm92aWRlIGxhdC9sbmcKICAgICAgaWYgKCFsYXQgfHwgIWxuZykgewogICAgICAgIHRyeSB7CiAgICAgICAgICB2YXIgbHNMYXQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc2VsZWN0ZWRfbGF0Jyk7CiAgICAgICAgICB2YXIgbHNMbmcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnc2VsZWN0ZWRfbG5nJyk7CiAgICAgICAgICBpZiAobHNMYXQgJiYgbHNMbmcpIHsgbGF0ID0gbGF0IHx8IGxzTGF0OyBsbmcgPSBsbmcgfHwgbHNMbmc7IH0KICAgICAgICB9IGNhdGNoIChlKSB7fQogICAgICB9CiAgICAgIHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkID0gYWRkcklkIHx8IG51bGw7CiAgICAgIHdpbmRvdy5fX2JsU3RvcmVkTGF0ID0gbGF0IHx8IG51bGw7CiAgICAgIHdpbmRvdy5fX2JsU3RvcmVkTG5nID0gbG5nIHx8IG51bGw7CiAgICAgIGlmIChhZGRySWQpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9hZGRyZXNzX2lkJywgU3RyaW5nKGFkZHJJZCkpOwogICAgICBpZiAobGF0KSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfbGF0JywgU3RyaW5nKGxhdCkpOwogICAgICBpZiAobG5nKSBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfbG5nJywgU3RyaW5nKGxuZykpOwogICAgICAvLyBBbHNvIHRyeSB0byBzZXQgQmxpbmtpdCBTUEEncyBvd24gYWRkcmVzcyBzdG9yYWdlIGtleXMKICAgICAgdHJ5IHsKICAgICAgICB2YXIgYWRkcktleSA9ICdhZGRyZXNzZXNfZGF0YSc7CiAgICAgICAgdmFyIGV4aXN0aW5nID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oYWRkcktleSk7CiAgICAgICAgaWYgKGV4aXN0aW5nICYmIGFkZHJJZCkgewogICAgICAgICAgdmFyIHBhcnNlZCA9IEpTT04ucGFyc2UoZXhpc3RpbmcpOwogICAgICAgICAgaWYgKHBhcnNlZCAmJiBwYXJzZWQuYWRkcmVzc2VzICYmIEFycmF5LmlzQXJyYXkocGFyc2VkLmFkZHJlc3Nlcy5hZGRyZXNzZXNfZGF0YSkpIHsKICAgICAgICAgICAgdmFyIG1hdGNoID0gcGFyc2VkLmFkZHJlc3Nlcy5hZGRyZXNzZXNfZGF0YS5maW5kKGZ1bmN0aW9uKGEpIHsgcmV0dXJuIFN0cmluZyhhLmlkKSA9PT0gU3RyaW5nKGFkZHJJZCk7IH0pOwogICAgICAgICAgICBpZiAobWF0Y2gpIHsKICAgICAgICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfYWRkcmVzc19pZCcsIFN0cmluZyhhZGRySWQpKTsKICAgICAgICAgICAgfQogICAgICAgICAgfQogICAgICAgIH0KICAgICAgfSBjYXRjaCAoZTIpIHt9CiAgICAgIC8vIENhbGwgQmxpbmtpdCdzIC92NC9hZGRyZXNzIEFQSSB0byBzZXQgc2VydmVyLXNpZGUgc2Vzc2lvbiBhZGRyZXNzLgogICAgICAvLyBPbmx5IGZldGNoIG9uY2UgLS0gbm8gbmVlZCB0byBzcGFtIHRoZSBBUEkuCiAgICAgIGlmIChhZGRySWQgJiYgIXdpbmRvdy5fX2JsQWRkckFwaUZldGNoZWQpIHsKICAgICAgICB3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkID0gdHJ1ZTsKICAgICAgICB2YXIgYkxhdCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdzZWxlY3RlZF9sYXQnKSB8fCBsYXQgfHwgJzEyLjk3MTYnOwogICAgICAgIHZhciBiTG5nID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ3NlbGVjdGVkX2xuZycpIHx8IGxuZyB8fCAnNzcuNTk0Nic7CiAgICAgICAgdmFyIGFjY2Vzc1Rva2VuID0gJyc7CiAgICAgICAgdHJ5IHsgdmFyIGF1dGhPYmogPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoJykgfHwgJ3t9Jyk7IGFjY2Vzc1Rva2VuID0gYXV0aE9iai5hY2Nlc3NUb2tlbiB8fCAnJzsgfSBjYXRjaCAoZSkge30KICAgICAgICB2YXIgZGV2aWNlSWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKSB8fCAnJzsKICAgICAgICB2YXIgYXV0aEtleSA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoS2V5JykgfHwgJyc7CiAgICAgICAgdmFyIHNlbGVjdEhlYWRlcnMgPSB7CiAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLAogICAgICAgICAgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi9qc29uJywKICAgICAgICAgICdhY2Nlc3NfdG9rZW4nOiBhY2Nlc3NUb2tlbiwKICAgICAgICAgICdhdXRoX2tleSc6IGF1dGhLZXksCiAgICAgICAgICAnYXBwX2NsaWVudCc6ICdjb25zdW1lcl93ZWInLAogICAgICAgICAgJ2xhdCc6IGJMYXQsCiAgICAgICAgICAnbG9uJzogYkxuZywKICAgICAgICAgICdkZXZpY2VfaWQnOiBkZXZpY2VJZCwKICAgICAgICAgICdwbGF0Zm9ybSc6ICdtb2JpbGVfd2ViJwogICAgICAgIH07CiAgICAgICAgLy8gQWRkcmVzcyBzZWxlY3QgdmFyaWFudHMgZm9yIHNlcnZlci1zaWRlIHNlc3Npb24KICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92Mi9hZGRyZXNzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFkZHJlc3NfaWQ6IE51bWJlcihhZGRySWQpIH0pCiAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2Mi9zZWxlY3QnLCBzdGF0dXM6IHIuc3RhdHVzIH0pKTsKICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgICBmZXRjaCgnaHR0cHM6Ly9ibGlua2l0LmNvbS92MS9hZGRyZXNzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGlkOiBOdW1iZXIoYWRkcklkKSB9KQogICAgICAgIH0pLnRoZW4oZnVuY3Rpb24ocikgewogICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX0RFQlVHJywgc291cmNlOiAndjEvc2VsZWN0Jywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oKSB7fSk7CiAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjEvYWRkcmVzc2VzL3NlbGVjdCcsIHsKICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgIGhlYWRlcnM6IHNlbGVjdEhlYWRlcnMsCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGFkZHJlc3NfaWQ6IE51bWJlcihhZGRySWQpIH0pCiAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2MXMvc2VsZWN0Jywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24oKSB7fSk7CiAgICAgIH0KICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgdHlwZTogJ0JMX0FERFJfU0VUJywgYWRkcklkOiBhZGRySWQsIGxhdDogbGF0LCBsbmc6IGxuZwogICAgICB9KSk7CiAgICB9IGNhdGNoIChlKSB7fQogIH07CgogIHdpbmRvdy5fX2JsSGFuZGxlUmVxdWVzdCA9IGZ1bmN0aW9uKGlkLCB1cmwsIG1ldGhvZCwgYm9keSwgZXh0cmFIZWFkZXJzSnNvbikgewogICAgdmFyIG9wdHMgPSB7CiAgICAgIG1ldGhvZDogbWV0aG9kIHx8ICdHRVQnLAogICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICBoZWFkZXJzOiB7ICdBY2NlcHQnOiAnYXBwbGljYXRpb24vanNvbiwgdGV4dC9wbGFpbiwgKi8qJyB9CiAgICB9OwogICAgdHJ5IHsKICAgICAgdmFyIGV4dHJhID0gSlNPTi5wYXJzZShleHRyYUhlYWRlcnNKc29uIHx8ICd7fScpOwogICAgICBmb3IgKHZhciBrIGluIGV4dHJhKSB7IGlmIChleHRyYVtrXSkgb3B0cy5oZWFkZXJzW2tdID0gZXh0cmFba107IH0KICAgIH0gY2F0Y2ggKGUyKSB7fQogICAgdHJ5IHsKICAgICAgdmFyIGFrID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2F1dGhLZXknKTsKICAgICAgaWYgKGFrICYmICFvcHRzLmhlYWRlcnNbJ2F1dGhfa2V5J10pIG9wdHMuaGVhZGVyc1snYXV0aF9rZXknXSA9IGFrOwogICAgfSBjYXRjaCAoZTMpIHt9CiAgICB0cnkgewogICAgICB2YXIgZHYgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnZGV2aWNlSWQnKTsKICAgICAgaWYgKGR2KSB7CiAgICAgICAgaWYgKCFvcHRzLmhlYWRlcnNbJ0RldmljZUlEJ10pIG9wdHMuaGVhZGVyc1snRGV2aWNlSUQnXSA9IGR2OwogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydkZXZpY2VfaWQnXSkgb3B0cy5oZWFkZXJzWydkZXZpY2VfaWQnXSA9IGR2OwogICAgICAgIGlmICghb3B0cy5oZWFkZXJzWydkZXZpY2VpZCddKSBvcHRzLmhlYWRlcnNbJ2RldmljZWlkJ10gPSBkdjsKICAgICAgICBpZiAoIW9wdHMuaGVhZGVyc1sneC1kZXZpY2UtaWQnXSkgb3B0cy5oZWFkZXJzWyd4LWRldmljZS1pZCddID0gZHY7CiAgICAgIH0KICAgIH0gY2F0Y2ggKGUxMSkge30KICAgIGlmIChib2R5KSB7CiAgICAgIG9wdHMuaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7CiAgICAgIC8vIEZvcmNlLWluamVjdCBhZGRyZXNzX2lkIGludG8gL3Y1L2NhcnRzIFBPU1QgYm9kaWVzLiBUaGUgU1BBIG1heQogICAgICAvLyBub3QgaGF2ZSBhbiBhZGRyZXNzIHNlbGVjdGVkIGluIGl0cyBpbnRlcm5hbCBzdGF0ZSwgYnV0IG91ciBzdG9yZWQKICAgICAgLy8gYWRkcmVzcyBlbnN1cmVzIHRoZSBzZXJ2ZXIgYWx3YXlzIHByaWNlcyB1bmRlciB0aGUgY29ycmVjdCB6b25lLgogICAgICBpZiAoL1wvdjVcL2NhcnRzLy50ZXN0KHVybCkgJiYgbWV0aG9kID09PSAnUE9TVCcpIHsKICAgICAgICB0cnkgewogICAgICAgICAgdmFyIGIgPSBKU09OLnBhcnNlKGJvZHkpOwogICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9DQVJUX1JFUScsIHVybDogdXJsLCBhZGRyZXNzSWQ6IGIuYWRkcmVzc19pZCB8fCBudWxsLCBzdG9yZWRBZGRySWQ6IHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkIHx8IG51bGwsIGl0ZW1zOiAoYi5pdGVtcyB8fCBbXSkubGVuZ3RoIH0pKTsKICAgICAgICAgIGlmICghYi5hZGRyZXNzX2lkICYmIHdpbmRvdy5fX2JsU3RvcmVkQWRkcklkKSB7CiAgICAgICAgICAgIGIuYWRkcmVzc19pZCA9IE51bWJlcih3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCk7CiAgICAgICAgICAgIGJvZHkgPSBKU09OLnN0cmluZ2lmeShiKTsKICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9DQVJUX1JFUScsIGluamVjdGVkOiB0cnVlLCBhZGRyZXNzSWQ6IGIuYWRkcmVzc19pZCB9KSk7CiAgICAgICAgICB9CiAgICAgICAgfSBjYXRjaCAoZTQpIHt9CiAgICAgIH0KICAgICAgb3B0cy5ib2R5ID0gYm9keTsKICAgIH0KICAgIGZldGNoKHVybCwgb3B0cykudGhlbihmdW5jdGlvbihyZXMpIHsKICAgICAgcmV0dXJuIHJlcy50ZXh0KCkudGhlbihmdW5jdGlvbih0KSB7CiAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgICB0eXBlOiAnQkxfQVBJX1JFU1BPTlNFJywgaWQ6IGlkLCBzdGF0dXM6IHJlcy5zdGF0dXMsIHRleHQ6IFN0cmluZyh0KS5zbGljZSgwLCAxNTAwMDAwKQogICAgICAgIH0pKTsKICAgICAgfSk7CiAgICB9KS5jYXRjaChmdW5jdGlvbihlKSB7CiAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHR5cGU6ICdCTF9BUElfUkVTUE9OU0UnLCBpZDogaWQsIHN0YXR1czogMCwgdGV4dDogU3RyaW5nKChlICYmIGUubWVzc2FnZSkgfHwgZSkKICAgICAgfSkpOwogICAgfSk7CiAgfTsKICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0JSSURHRV9SRUFEWScgfSkpOwogIC8vIEF1dG8tZmV0Y2ggYWRkcmVzc2VzIHZpYSAvdjQvYWRkcmVzcyBvbiBldmVyeSBicmlkZ2UgbG9hZC4KICAvLyBUaGlzIGVuc3VyZXMgdGhlIHNlcnZlci1zaWRlIHNlc3Npb24gYWx3YXlzIGhhcyB0aGUgY29ycmVjdCBhZGRyZXNzLAogIC8vIGV2ZW4gaWYgQmxpbmtpdCdzIFNQQSBhbHJlYWR5IHdyb3RlIHNlbGVjdGVkX2FkZHJlc3NfaWQgdG8gbG9jYWxTdG9yYWdlLgogIC8vIFRoZSBBUEkgcmVzcG9uc2UgcHJvdmlkZXMgYXV0aG9yaXRhdGl2ZSBsYXQvbG5nIGZvciBwcmljaW5nLgogIC8vIE9ubHkgcnVucyBvbmNlIHBlciBicmlkZ2UgaW5zdGFuY2UuCiAgKGZ1bmN0aW9uKCkgewogICAgdHJ5IHsKICAgICAgaWYgKHdpbmRvdy5fX2JsQWRkckFwaUZldGNoZWQpIHJldHVybjsKICAgICAgdmFyIGF1dGhSYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnYXV0aCcpOwogICAgICBpZiAoIWF1dGhSYXcpIHJldHVybjsKICAgICAgdmFyIGF1dGhPYmogPSBKU09OLnBhcnNlKGF1dGhSYXcpOwogICAgICB2YXIgYWNjZXNzVG9rZW4gPSBhdXRoT2JqLmFjY2Vzc1Rva2VuIHx8ICcnOwogICAgICBpZiAoIWFjY2Vzc1Rva2VuKSByZXR1cm47CiAgICAgIHZhciBsb2NSYXcgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnbG9jYXRpb24nKTsKICAgICAgdmFyIGxhdCA9ICcxMi45NzE2JywgbG5nID0gJzc3LjU5NDYnOwogICAgICBpZiAobG9jUmF3KSB7IHRyeSB7IHZhciBsb2MgPSBKU09OLnBhcnNlKGxvY1Jhdyk7IGxhdCA9IGxvYy5jb29yZHMubGF0IHx8IGxhdDsgbG5nID0gbG9jLmNvb3Jkcy5sb24gfHwgbG5nOyB9IGNhdGNoIChlKSB7fSB9CiAgICAgIHZhciBkZXZpY2VJZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdkZXZpY2VJZCcpIHx8ICcnOwogICAgICB3aW5kb3cuX19ibEFkZHJBcGlGZXRjaGVkID0gdHJ1ZTsKICAgICAgdmFyIHVybCA9ICdodHRwczovL2JsaW5raXQuY29tL3Y0L2FkZHJlc3M/Y3VyX2xhdD0nICsgbGF0ICsgJyZjdXJfbG9uPScgKyBsbmc7CiAgICAgIGZldGNoKHVybCwgewogICAgICAgIG1ldGhvZDogJ0dFVCcsCiAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICBoZWFkZXJzOiB7CiAgICAgICAgICAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLAogICAgICAgICAgJ2FjY2Vzc190b2tlbic6IGFjY2Vzc1Rva2VuLAogICAgICAgICAgJ2F1dGhfa2V5JzogJ2M3NjFlYzM2MzNjMjJhZmFkOTM0ZmIxN2E2NjM4NWMxYzA2YzU0NzJiNDg5OGI4NjZiNzMwNjE4NmQwYmI0NzcnLAogICAgICAgICAgJ2FwcF9jbGllbnQnOiAnY29uc3VtZXJfd2ViJywKICAgICAgICAgICdsYXQnOiBsYXQsCiAgICAgICAgICAnbG9uJzogbG5nLAogICAgICAgICAgJ2RldmljZV9pZCc6IGRldmljZUlkLAogICAgICAgICAgJ3BsYXRmb3JtJzogJ21vYmlsZV93ZWInCiAgICAgICAgfQogICAgICB9KS50aGVuKGZ1bmN0aW9uKHIpIHsKICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2NC9hdXRvJywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgaWYgKCFyLm9rKSByZXR1cm4gbnVsbDsKICAgICAgICByZXR1cm4gci50ZXh0KCk7CiAgICAgIH0pLnRoZW4oZnVuY3Rpb24odCkgewogICAgICAgIGlmICghdCkgcmV0dXJuOwogICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiAnQkxfQUREUl9ERUJVRycsIHNvdXJjZTogJ3Y0L2F1dG8nLCBib2R5OiB0LnNsaWNlKDAsIDIwMDApIH0pKTsKICAgICAgICB0cnkgewogICAgICAgICAgdmFyIGFqID0gSlNPTi5wYXJzZSh0KTsKICAgICAgICAgIHZhciBsaXN0ID0gYWouYWRkcmVzc2VzIHx8IGFqLmRhdGEgfHwgYWouYWRkcmVzc2VzX2RhdGEgfHwgKEFycmF5LmlzQXJyYXkoYWopID8gYWogOiBudWxsKTsKICAgICAgICAgIGlmIChsaXN0ICYmICFBcnJheS5pc0FycmF5KGxpc3QpICYmIGxpc3QuYWRkcmVzc2VzX2RhdGEpIGxpc3QgPSBsaXN0LmFkZHJlc3Nlc19kYXRhOwogICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGlzdCkgJiYgbGlzdC5sZW5ndGgpIHsKICAgICAgICAgICAgdmFyIGEgPSBsaXN0WzBdOwogICAgICAgICAgICB2YXIgYUlkID0gYS5pZCB8fCBhLmFkZHJlc3NfaWQgfHwgJyc7CiAgICAgICAgICAgIHZhciBhTGF0ID0gYS5sYXRpdHVkZSB8fCBhLmxhdCB8fCAnJzsKICAgICAgICAgICAgdmFyIGFMbmcgPSBhLmxvbmdpdHVkZSB8fCBhLmxuZyB8fCBhLmxvbiB8fCAnJzsKICAgICAgICAgICAgaWYgKGFJZCkgeyB3aW5kb3cuX19ibFN0b3JlZEFkZHJJZCA9IFN0cmluZyhhSWQpOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnc2VsZWN0ZWRfYWRkcmVzc19pZCcsIFN0cmluZyhhSWQpKTsgfQogICAgICAgICAgICBpZiAoYUxhdCAmJiBhTG5nKSB7IHdpbmRvdy5fX2JsU3RvcmVkTGF0ID0gU3RyaW5nKGFMYXQpOyB3aW5kb3cuX19ibFN0b3JlZExuZyA9IFN0cmluZyhhTG5nKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ3NlbGVjdGVkX2xhdCcsIFN0cmluZyhhTGF0KSk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdzZWxlY3RlZF9sbmcnLCBTdHJpbmcoYUxuZykpOyB9CiAgICAgICAgICAgIHdpbmRvdy5SZWFjdE5hdGl2ZVdlYlZpZXcucG9zdE1lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoeyB0eXBlOiAnQkxfQUREUl9SRVNPTFZFRCcsIGFkZHJlc3NJZDogU3RyaW5nKGFJZCksIGxhdDogU3RyaW5nKGFMYXQpLCBsbmc6IFN0cmluZyhhTG5nKSB9KSk7CiAgICAgICAgICAgIC8vIENSSVRJQ0FMOiBhbHNvIGNhbGwgYWRkcmVzcyBTRUxFQ1QgQVBJcyBzbyB0aGUgc2VydmVyIHNlc3Npb24KICAgICAgICAgICAgLy8ga25vd3Mgd2hpY2ggYWRkcmVzcyB0byB1c2UgZm9yIGRlbGl2ZXJ5IHByaWNpbmcuCiAgICAgICAgICAgIHZhciBhdXRoS2V5MiA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdhdXRoS2V5JykgfHwgJyc7CiAgICAgICAgICAgIHZhciBzZWxIID0geyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLCAnYWNjZXNzX3Rva2VuJzogYWNjZXNzVG9rZW4sICdhdXRoX2tleSc6IGF1dGhLZXkyLCAnYXBwX2NsaWVudCc6ICdjb25zdW1lcl93ZWInLCAnbGF0JzogYUxhdCwgJ2xvbic6IGFMbmcsICdkZXZpY2VfaWQnOiBkZXZpY2VJZCwgJ3BsYXRmb3JtJzogJ21vYmlsZV93ZWInIH07CiAgICAgICAgICAgIGZldGNoKCdodHRwczovL2JsaW5raXQuY29tL3YyL2FkZHJlc3Mvc2VsZWN0JywgewogICAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLAogICAgICAgICAgICAgIGhlYWRlcnM6IHNlbEgsCiAgICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBhZGRyZXNzX2lkOiBOdW1iZXIoYUlkKSB9KQogICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKHIpIHsKICAgICAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2Mi9zZWxlY3QvYXV0bycsIHN0YXR1czogci5zdGF0dXMgfSkpOwogICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjEvYWRkcmVzcy9zZWxlY3QnLCB7CiAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsCiAgICAgICAgICAgICAgaGVhZGVyczogc2VsSCwKICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGlkOiBOdW1iZXIoYUlkKSB9KQogICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uKHIpIHsKICAgICAgICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ0JMX0FERFJfREVCVUcnLCBzb3VyY2U6ICd2MS9zZWxlY3QvYXV0bycsIHN0YXR1czogci5zdGF0dXMgfSkpOwogICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbigpIHt9KTsKICAgICAgICAgICAgZmV0Y2goJ2h0dHBzOi8vYmxpbmtpdC5jb20vdjEvYWRkcmVzc2VzL3NlbGVjdCcsIHsKICAgICAgICAgICAgICBtZXRob2Q6ICdQT1NUJywgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywKICAgICAgICAgICAgICBoZWFkZXJzOiBzZWxILAogICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYWRkcmVzc19pZDogTnVtYmVyKGFJZCkgfSkKICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbihyKSB7CiAgICAgICAgICAgICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9BRERSX0RFQlVHJywgc291cmNlOiAndjFzL3NlbGVjdC9hdXRvJywgc3RhdHVzOiByLnN0YXR1cyB9KSk7CiAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKCkge30pOwogICAgICAgICAgfQogICAgICAgIH0gY2F0Y2ggKGUpIHt9CiAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKCkge30pOwogICAgfSBjYXRjaCAoZSkge30KICB9KSgpOwogIHRyeSB7CiAgICB2YXIgc3RvcmFnZUtleXMgPSBbJ2NhcnQnLCAnY2hlY2tvdXQnXTsKICAgIGZvciAodmFyIHNpID0gMDsgc2kgPCBzdG9yYWdlS2V5cy5sZW5ndGg7IHNpKyspIHsKICAgICAgdmFyIHN2ID0gU3RyaW5nKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXlzW3NpXSkgfHwgJycpOwogICAgICBpZiAoc3YpIHsKICAgICAgICB3aW5kb3cuUmVhY3ROYXRpdmVXZWJWaWV3LnBvc3RNZXNzYWdlKEpTT04uc3RyaW5naWZ5KHsKICAgICAgICAgIHR5cGU6ICdCTF9MT0NBTFNUT1JBR0UnLCBrZXk6IHN0b3JhZ2VLZXlzW3NpXSwgdmFsdWU6IHN2LnNsaWNlKDAsIDYwMDAwKQogICAgICAgIH0pKTsKICAgICAgfQogICAgfQogIH0gY2F0Y2ggKGUxMCkge30KICB0cnkgewogICAgdmFyIGRpYWcgPSBbXTsKICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbG9jYWxTdG9yYWdlLmxlbmd0aCAmJiBkaWFnLmxlbmd0aCA8IDYwOyBpKyspIHsKICAgICAgdmFyIGsgPSBTdHJpbmcobG9jYWxTdG9yYWdlLmtleShpKSk7CiAgICAgIGRpYWcucHVzaCh7IGs6IGsuc2xpY2UoMCwgNjApLCB2OiBTdHJpbmcobG9jYWxTdG9yYWdlLmdldEl0ZW0oaykpLnNsaWNlKDAsIDE2MCkgfSk7CiAgICB9CiAgICB2YXIgZGMgPSAnJzsKICAgIHRyeSB7IGRjID0gU3RyaW5nKGRvY3VtZW50LmNvb2tpZSkuc2xpY2UoMCwgMTIwMCk7IH0gY2F0Y2ggKGU5KSB7fQogICAgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9ESUFHJywgZW50cmllczogZGlhZywgY29va2llOiBkYyB9KSk7CiAgfSBjYXRjaCAoZTgpIHt9CiAgfSBjYXRjaCAoZU1haW4pIHsKICAgIHdpbmRvdy5fX2JsU2NyaXB0RXJyb3IgPSBTdHJpbmcoZU1haW4gJiYgZU1haW4ubWVzc2FnZSB8fCBlTWFpbik7CiAgICB3aW5kb3cuX19ibFNjcmlwdFN0YWNrID0gU3RyaW5nKGVNYWluICYmIGVNYWluLnN0YWNrIHx8ICcnKS5zbGljZSgwLCA1MDApOwogICAgdHJ5IHsgd2luZG93LlJlYWN0TmF0aXZlV2ViVmlldy5wb3N0TWVzc2FnZShKU09OLnN0cmluZ2lmeSh7IHR5cGU6ICdCTF9CUklER0VfRVJST1InLCBlcnJvcjogd2luZG93Ll9fYmxTY3JpcHRFcnJvciwgc3RhY2s6IHdpbmRvdy5fX2JsU2NyaXB0U3RhY2sgfSkpOyB9IGNhdGNoIChlMikge30KICB9Cn0pKCk7Cg==';

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
