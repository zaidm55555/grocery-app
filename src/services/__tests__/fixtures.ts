import type { UnifiedProduct, PlatformVariant, CartCalculation } from '../api';

export const product = (over: Partial<UnifiedProduct> = {}): UnifiedProduct => ({
  id: 'blinkit-1',
  title: 'Tata Salt',
  brand: 'Tata',
  quantity: '1 kg',
  price: 28,
  imageUrl: '',
  platform: 'blinkit',
  ...over,
});

export const variant = (over: Partial<PlatformVariant> = {}): PlatformVariant => ({
  id: 'swiggy-1',
  title: 'Tata Salt',
  brand: 'Tata',
  quantity: '1 kg',
  price: 30,
  imageUrl: '',
  ...over,
});

export const calc = (platform: 'blinkit' | 'swiggy', over: Partial<CartCalculation> = {}): CartCalculation => ({
  platform,
  items: [],
  subtotal: 0,
  deliveryFee: 0,
  handlingFee: 0,
  smallCartFee: 0,
  surgeFee: 0,
  tax: 0,
  total: 0,
  savings: 0,
  live: true,
  ...over,
});
