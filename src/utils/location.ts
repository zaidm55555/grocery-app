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
      const area = g.name || g.street || g.district || g.subregion;
      const city = g.city || g.subregion || g.region;
      const state = g.region;
      const parts = [area, city, state].filter(Boolean) as string[];
      const unique = Array.from(new Set(parts));
      if (unique.length > 0) {
        return unique.join(', ');
      }
    }
  } catch {}

  // 2. Fallback: OpenStreetMap Nominatim reverse geocoder with 3s timeout
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`, {
      headers: { 'User-Agent': 'BasketBuddy-App' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const a = data.address || {};
      const area = a.suburb || a.neighbourhood || a.road || a.residential || a.commercial || a.city_district || a.town || a.village;
      const city = a.city || a.town || a.state_district || a.county;
      const state = a.state;
      const parts = [area, city, state].filter(Boolean) as string[];
      const unique = Array.from(new Set(parts));
      if (unique.length > 0) {
        return unique.join(', ');
      }
    }
  } catch {}

  // 3. Fallback to coordinate formatting if offline / unreachable
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}
