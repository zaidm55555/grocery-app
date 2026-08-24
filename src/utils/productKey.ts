// Ported verbatim from the Grocery Order Optimizer (src/utils/productKey.js):
// canonical product identity + pack-size parsing used by the auto-matcher.

export function productKey(name: string | undefined, unit?: string): string {
  const raw = (name || '') + ' ' + (unit || '');
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// Field resolvers so keys/matcher work with both shapes used in the app:
// match targets ({name, unit}) and UnifiedProduct rows ({title, quantity}).
export type KeyableItem = {
  name?: string;
  title?: string;
  unit?: string;
  quantity?: string;
};

export function itemName(item: KeyableItem | null | undefined): string {
  return (item && (item.name || item.title)) || '';
}

export function itemUnit(item: KeyableItem | null | undefined): string {
  return (item && (item.unit || item.quantity)) || '';
}

export function liveKey(item: KeyableItem): string {
  return productKey(itemName(item), itemUnit(item));
}

const PACK_SIZE_RE = /[\s.,:]*\d+(?:\.\d+)?\s*(?:g|gm|kg|gram|grams|kilogram|kilograms|ml|millilitre|millilitres|l|litre|litres|liter|liters|pcs|pc|pieces|pack|pkt|sachet|count)\s*$/i;
const PACK_OF_RE = /[\s.,:]*(?:\(\s*)?pack\s+of\s+\d+(?:\s*\))?\s*$/i;
const MULTI_PACK_RE = /[\s.,:]*\d+\s*[x*]\s*\d+(?:\.\d+)?\s*(?:g|gm|kg|ml|l|gram|grams|kilogram|kilograms|litre|litres|liter|liters|millilitre|millilitres|pcs|pieces|pack|pkt)\s*$/i;
const TRAILING_MULTI_RE = /[\s.,:]*\d+(?:\.\d+)?\s*(?:g|gm|kg|ml|l|gram|grams|kilogram|kilograms|litre|litres|liter|liters|millilitre|millilitres|pcs|pieces|pack|pkt)\s*[x*]\s*\d+\s*$/i;

export function stripSizeToken(name: string | undefined): string {
  let s = String(name || '').trim();
  if (!s) return s;
  let prev: string;
  do {
    prev = s;
    s = s.replace(MULTI_PACK_RE, '').trim();
    s = s.replace(TRAILING_MULTI_RE, '').trim();
    s = s.replace(PACK_OF_RE, '').trim();
    s = s.replace(PACK_SIZE_RE, '').trim();
  } while (s !== prev && s.length > 0);
  return s;
}

export function familyKey(item: KeyableItem | null | undefined): string {
  return productKey(stripSizeToken(itemName(item)), '');
}

const SIZE_UNIT_PART = '(kg|kgs|kilogram|kilograms|g|gm|gms|gram|grams|l|litre|litres|liter|liters|ml|millilitre|millilitres|pcs|pieces|count|pack|pkt)';

// Normalized size in g/ml; Infinity if unparseable.
export function variantSize(item: KeyableItem | null | undefined): number {
  const raw = String((item && (itemUnit(item) || itemName(item))) || '').toLowerCase();
  const withUnit = raw.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + SIZE_UNIT_PART));
  const bare = raw.match(/(\d+(?:\.\d+)?)/);
  if (!withUnit && !bare) return Infinity;
  let v = withUnit ? parseFloat(withUnit[1]) : parseFloat(bare![1]);
  const u = (withUnit && withUnit[2]) || '';
  let mult = 1;
  const after = raw.match(/(?:x|\*|×)\s*(\d+(?:\.\d+)?)\s*$/); // "500 ml x 2"
  if (after) mult = parseFloat(after[1]);
  const before = raw.match(new RegExp('^(\\d+(?:\\.\\d+)?)\\s*(?:x|\\*|×)\\s*(\\d+(?:\\.\\d+)?)\\s*' + SIZE_UNIT_PART)); // "2 x 500 ml"
  if (before && parseFloat(before[2]) === v) mult = parseFloat(before[1]);
  const packOf = raw.match(/pack\s+of\s+(\d+)/);
  if (packOf) mult *= parseFloat(packOf[1]);
  if (/kg|kilo/.test(u)) v *= 1000;
  else if (/l|litre|liter/.test(u) && !/ml/.test(u)) v *= 1000;
  return v * mult;
}
