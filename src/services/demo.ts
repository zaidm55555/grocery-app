import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Platform } from './storage';
import { requestEvalViaSwiggyBridge } from './swiggyBridge';
import type { UnifiedProduct, CartCalculation } from './api';

// Hardcoded demo mode: no logins, no network. Search returns canned products
// and the basket shows canned fees. On by default; the Profile switch persists
// the choice, and EXPO_PUBLIC_DEMO_MODE=0 flips the default to off.
const KEY = '@demo_mode';
let demoOn = process.env.EXPO_PUBLIC_DEMO_MODE !== '0';

export const isDemoMode = () => demoOn;

export async function loadDemoMode(): Promise<boolean> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    if (saved === '1') demoOn = true;
    else if (saved === '0') demoOn = false;
  } catch {}
  return demoOn;
}

export async function setDemoMode(on: boolean): Promise<void> {
  demoOn = on;
  try {
    await AsyncStorage.setItem(KEY, on ? '1' : '0');
  } catch {}
}

// MG Road, Bengaluru: a public landmark both stores deliver to.
export const DEMO_LOCATION = { latitude: 12.9757, longitude: 77.6069, address: 'Demo location • MG Road, Bengaluru' };
// Public web auth key blinkit.com itself sends for signed-out visitors.
export const DEMO_BLINKIT_AUTH_KEY = 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477';

// [title, brand, size, blinkit price, swiggy price, mrp]
const CATALOG: [string, string, string, number, number, number][] = [
  ['Full Cream Milk', 'Amul', '500 ml', 33, 34, 34],
  ['Toned Milk', 'Nandini', '1 L', 46, 47, 48],
  ['Brown Bread', 'Britannia', '400 g', 45, 42, 50],
  ['Eggs', 'Farm Fresh', '6 pcs', 58, 60, 66],
  ['Basmati Rice', 'India Gate', '1 kg', 142, 139, 175],
  ['Banana Robusta', 'Fresh', '1 kg', 52, 49, 60],
  ['Onion', 'Fresh', '1 kg', 38, 40, 45],
  ['Tomato', 'Fresh', '500 g', 28, 26, 32],
  ['Salted Butter', 'Amul', '100 g', 58, 58, 60],
  ['Curd', 'Mother Dairy', '400 g', 38, 36, 40],
  ['Potato Chips Classic', 'Lays', '52 g', 20, 20, 20],
  ['Instant Noodles Masala', 'Maggi', '280 g', 56, 54, 62],
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function toProduct(row: (typeof CATALOG)[number], platform: Platform): UnifiedProduct {
  const [title, brand, quantity, bPrice, sPrice, mrp] = row;
  const price = platform === 'blinkit' ? bPrice : sPrice;
  const id = `demo-${platform}-${slug(`${brand}-${title}-${quantity}`)}`;
  return {
    id, title, brand, quantity, price,
    originalPrice: mrp > price ? mrp : undefined,
    imageUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=200&q=80',
    platform,
    inStock: true,
    productId: id,
    originalId: id,
    storeId: `demo-${platform}-store`,
    storeVerified: true,
  };
}

export function demoSearch(platform: Platform, query: string): UnifiedProduct[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return CATALOG
    .filter((r) => {
      const hay = `${r[1]} ${r[0]} ${r[2]}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((r) => toProduct(r, platform));
}

const FEES: Record<Platform, { delivery: number; handling: number; smallCart: number; freeAbove: number }> = {
  blinkit: { delivery: 25, handling: 4, smallCart: 15, freeAbove: 199 },
  swiggy: { delivery: 30, handling: 5, smallCart: 20, freeAbove: 249 },
};

export function demoCalculate(
  items: { product: UnifiedProduct; quantity: number }[],
  platforms: Platform[],
  resolve: (item: { product: UnifiedProduct; quantity: number }, p: Platform) => { product: UnifiedProduct; quantity: number } | null,
): CartCalculation[] {
  return platforms.map((platform) => {
    const lines = items.map((i) => resolve(i, platform)).filter((l): l is NonNullable<typeof l> => !!l);
    const subtotal = lines.reduce((s, l) => s + l.product.price * l.quantity, 0);
    const mrp = lines.reduce((s, l) => s + (l.product.originalPrice ?? l.product.price) * l.quantity, 0);
    const f = FEES[platform];
    const free = subtotal >= f.freeAbove;
    const deliveryFee = lines.length === 0 || free ? 0 : f.delivery;
    const smallCartFee = lines.length > 0 && subtotal < 100 ? f.smallCart : 0;
    const handlingFee = lines.length ? f.handling : 0;
    return {
      platform,
      items: lines,
      subtotal,
      deliveryFee,
      handlingFee,
      smallCartFee,
      surgeFee: 0,
      tax: 0,
      total: subtotal + deliveryFee + handlingFee + smallCartFee,
      savings: mrp - subtotal,
      freeDeliveryGap: lines.length && !free ? f.freeAbove - subtotal : undefined,
      live: true,
      storeVerified: true,
    };
  });
}

// Point the Swiggy page's own location cookie at the demo location, so the
// guest cart is served from the same store the demo search used (otherwise the
// cart marks those items unavailable).
export async function setDemoSwiggyLocation(): Promise<void> {
  const value = encodeURIComponent(JSON.stringify({
    lat: DEMO_LOCATION.latitude,
    lng: DEMO_LOCATION.longitude,
    address: DEMO_LOCATION.address,
    area: '',
    showLocation: true,
  }));
  await requestEvalViaSwiggyBridge(
    `(function(){ document.cookie = 'userLocation=${value}; path=/; domain=.swiggy.com; secure; SameSite=None'; return 'ok'; })()`,
    5000,
  );
}
