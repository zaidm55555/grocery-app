import * as Location from 'expo-location';

/**
 * Resolves coordinates into a human-readable area name (e.g. "Alkapuri, Vadodara, Gujarat").
 * Tries Expo Location reverseGeocodeAsync first, with a fallback to OpenStreetMap reverse geocoding.
 */
export async function resolveAreaName(lat: number, lng: number): Promise<string> {
  // 1. Try Expo native reverse geocoding
  try {
    const geocode = await Location.reverseGeocodeAsync({
      latitude: lat,
      longitude: lng
    });
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

  // 2. Fallback: OpenStreetMap Nominatim reverse geocoder
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`, {
      headers: { 'User-Agent': 'BasketBuddy-App' }
    });
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
