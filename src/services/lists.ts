import AsyncStorage from '@react-native-async-storage/async-storage';
import { UnifiedProduct } from './api';
import { storage } from './storage';

export type CartLine = { product: UnifiedProduct; quantity: number };

export interface SavedList {
  id: string;
  name: string;
  items: CartLine[];
  createdAt: number;
  updatedAt: number;
}

const LISTS_KEY = '@saved_lists';

async function readJson<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Detach from live cart objects so later quantity edits don't mutate a snapshot.
const snapshot = (items: CartLine[]): CartLine[] =>
  items.filter(i => i.quantity > 0).map(i => ({ product: { ...i.product }, quantity: i.quantity }));

export function mergeLines(base: CartLine[], incoming: CartLine[]): CartLine[] {
  const merged = base.map(l => ({ ...l }));
  for (const line of incoming) {
    const existing = merged.find(l => l.product.id === line.product.id);
    if (existing) existing.quantity += line.quantity;
    else merged.push({ product: { ...line.product }, quantity: line.quantity });
  }
  return merged;
}

export const lists = {
  getAll(): Promise<SavedList[]> {
    return readJson<SavedList>(LISTS_KEY).then(l => l.sort((a, b) => b.updatedAt - a.updatedAt));
  },

  /** Saves under `name`; an existing list with the same name (case-insensitive) is overwritten. */
  async save(name: string, items: CartLine[]): Promise<SavedList | null> {
    const trimmed = name.trim();
    const snap = snapshot(items);
    if (!trimmed || snap.length === 0) return null;
    const all = await readJson<SavedList>(LISTS_KEY);
    const now = Date.now();
    const existing = all.find(l => l.name.toLowerCase() === trimmed.toLowerCase());
    let result: SavedList;
    if (existing) {
      existing.items = snap;
      existing.updatedAt = now;
      result = existing;
    } else {
      result = { id: newId(), name: trimmed, items: snap, createdAt: now, updatedAt: now };
      all.push(result);
    }
    await AsyncStorage.setItem(LISTS_KEY, JSON.stringify(all));
    return result;
  },

  async remove(id: string): Promise<void> {
    const all = await readJson<SavedList>(LISTS_KEY);
    await AsyncStorage.setItem(LISTS_KEY, JSON.stringify(all.filter(l => l.id !== id)));
  },

  /** Adds lines to the persisted cart (quantities summed) and returns the new cart. */
  async addToCart(items: CartLine[]): Promise<CartLine[]> {
    const merged = mergeLines((await storage.getCart()) as CartLine[], items);
    await storage.saveCart(merged);
    return merged;
  },

  async replaceCart(items: CartLine[]): Promise<CartLine[]> {
    const next = snapshot(items);
    await storage.saveCart(next);
    return next;
  },
};
