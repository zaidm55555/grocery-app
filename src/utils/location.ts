import * as Location from 'expo-location';

/**
 * Fast GPS fetcher:
 * 1. Checks getLastKnownPositionAsync (returns in < 50ms if device has cached location).
 * 2. If null or older than 10 minutes, calls getCurrentPositionAsync with a 5-second timeout.
 */
export async function getFastLocation(): Promise<{ latitude: number; longitude: number } | null> {
  // 1. Try OS cached position first (near-instant)
  try {
    const last = await Location.getLastKnownPositionAsync();
    if (last && last.coords) {
      const ageMs = Date.now() - (last.timestamp || 0);
      if (ageMs < 10 * 60 * 1000) {
        return {
          latitude: last.coords.latitude,
          longitude: last.coords.longitude
        };
      }
    }
  } catch {}

  // 2. Query GPS hardware with Balanced accuracy and a 5-second timeout
  try {
    const posPromise = Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
    const result: any = await Promise.race([posPromise, timeoutPromise]);
    if (result && result.coords) {
      return {
        latitude: result.coords.latitude,
        longitude: result.coords.longitude
      };
    }
  } catch {}

  // 3. Fallback to any last known location
  try {
    const last = await Location.getLastKnownPositionAsync();
    if (last && last.coords) {
      return {
        latitude: last.coords.latitude,
        longitude: last.coords.longitude
      };
    }
  } catch {}

  return null;
}

/**
 * Resolves coordinates into a human-readable area name (e.g. "Alkapuri, Vadodara, Gujarat").
 * Tries Expo Location reverseGeocodeAsync first, with a fallback to OpenStreetMap reverse geocoding.
 */
export async function resolveAreaName(lat: number, lng: number): Promise<string> {
  // 1. Try Expo native reverse geocoding with 3s timeout
  try {
    const geocodePromise = Location.reverseGeocodeAsync({
      latitude: lat,
      longitude: lng
    });
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
    const geocode: any = await Promise.race([geocodePromise, timeoutPromise]);
    if (geocode && geocode.length > 0) {
      const g = geocode[0];
      const parts: string[] = [];
      if (g.name && !g.name.includes('+')) {
        parts.push(g.name);
      }
      if (g.street && g.street !== g.name) {
        parts.push(g.street);
      }
      const sub = g.district || g.subregion;
      if (sub && sub !== g.name && sub !== g.street) {
        parts.push(sub);
      }
      const city = g.city || (g.region !== sub ? g.region : null);
      if (city && city !== sub && city !== g.name && city !== g.street) {
        parts.push(city);
      }
      if (g.region && g.region !== city && g.region !== sub) {
        parts.push(g.region);
      }
      if (g.postalCode) {
        parts.push(g.postalCode);
      }
      const unique = Array.from(new Set(parts.filter(Boolean)));
      if (unique.length > 0) {
        return unique.join(', ');
      }
    }
  } catch {}

  // 2. Fallback: OpenStreetMap Nominatim reverse geocoder with 3s timeout
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`, {
      headers: { 'User-Agent': 'BasketBuddy-App' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const a = data.address || {};
      const parts: string[] = [];
      const building = a.building || a.house_number || a.road || a.pedestrian;
      if (building) parts.push(building);
      const sub = a.suburb || a.neighbourhood || a.residential || a.commercial || a.city_district;
      if (sub && sub !== building) parts.push(sub);
      const city = a.city || a.town || a.village || a.state_district;
      if (city && city !== sub && city !== building) parts.push(city);
      const state = a.state;
      if (state && state !== city && state !== sub) parts.push(state);
      if (a.postcode) parts.push(a.postcode);
      const unique = Array.from(new Set(parts.filter(Boolean)));
      if (unique.length > 0) {
        return unique.join(', ');
      }
    }
  } catch {}

  // 3. Fallback to coordinate formatting if offline / unreachable
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}
