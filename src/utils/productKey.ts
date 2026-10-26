// Ported from the Grocery Order Optimizer (src/utils/productKey.js): canonical
// product identity + pack-size parsing used by the auto-matcher. Since extended
// with text folding (accents, apostrophes), more units (mg, ltr, dozen) and a
// structured quantity parser that understands multipacks and ranges.

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

// ---------- Text folding ----------

// Used only when String.prototype.normalize is unavailable.
const ACCENT_FALLBACK: Record<string, string> = {
  à: 'a', á: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', ā: 'a', ç: 'c', è: 'e', é: 'e', ê: 'e', ë: 'e', ē: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i', ī: 'i', ñ: 'n', ò: 'o', ó: 'o', ô: 'o', ö: 'o', õ: 'o', ō: 'o',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ū: 'u', ý: 'y', ÿ: 'y',
};

/**
 * Lowercases and folds a title for comparison: accents dropped ("Nestlé" ->
 * "nestle"), in-word apostrophes joined ("Lay's" -> "lays"), "&" spelled out
 * and the multiplication sign turned into "x".
 */
export function foldText(s: string | null | undefined): string {
  let t = String(s || '').toLowerCase();
  try {
    t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    // engines without normalize(): fall through to the explicit map
  }
  t = t.replace(/[àáâäãåāçèéêëēìíîïīñòóôöõōùúûüūýÿ]/g, c => ACCENT_FALLBACK[c] || c);
  t = t.replace(/([a-z0-9])['’‘`´]([a-z])/g, '$1$2');
  t = t.replace(/&/g, ' and ').replace(/×/g, ' x ');
  return t;
}

// ---------- Units ----------

const WEIGHT_UNITS = 'mg|kgs?|kilos?|kilogram(?:me)?s?|gms?|gram(?:me)?s?|grm|gr|g';
const VOLUME_UNITS = 'ml|mls|millilit(?:re|er)s?|ltrs?|lt|lit(?:re|er)s?|l';
const COUNT_UNITS = 'pcs|pc|pieces?|nos|units?|count|ct|tablets?|tabs|capsules?|bags?|sachets?|rolls?|sheets?|pods?|wipes|eggs?';
const ANY_UNIT = `${WEIGHT_UNITS}|${VOLUME_UNITS}|${COUNT_UNITS}`;
const NUM = '\\d+(?:\\.\\d+)?';
const END = '(?![a-z])';

// "Atta - l kg", "Oil I Ltr": a lone lowercase L / capital I typed for the digit 1
// in front of kg or litre (folded text, so "I" is already "i").
const ONE_TYPO_RE = /(^|[\s(\-–,:/])[il]\s?(?=(?:kgs?|kilos?|kilogram(?:me)?s?|ltrs?|lt|lit(?:re|er)s?)(?![a-z]))/g;

/** Repairs the "l kg" / "I ltr" typo (meaning 1 kg / 1 litre) in folded text. */
export function fixSizeTypos(s: string): string {
  return s.replace(ONE_TYPO_RE, (_m, lead: string) => `${lead}1 `);
}

// Trailing-only pack-size stripping (kept for familyKey grouping and search retries).
const PACK_SIZE_RE = new RegExp(`[\\s.,:]*${NUM}\\s*(?:${ANY_UNIT}|pack|pkt|sachet)\\s*$`, 'i');
const PACK_OF_RE = /[\s.,:]*(?:\(\s*)?pack\s+of\s+\d+(?:\s*\))?\s*$/i;
const MULTI_PACK_RE = new RegExp(`[\\s.,:]*\\d+\\s*[x*×]\\s*${NUM}\\s*(?:${ANY_UNIT}|pack|pkt)\\s*$`, 'i');
const TRAILING_MULTI_RE = new RegExp(`[\\s.,:]*${NUM}\\s*(?:${ANY_UNIT}|pack|pkt)\\s*[x*×]\\s*\\d+\\s*$`, 'i');

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

// Every size / multipack / dozen expression, wherever it sits in the title.
const ALL_SIZE_RES: RegExp[] = [
  new RegExp(`\\d+\\s*x\\s*${NUM}\\s*(?:${ANY_UNIT})${END}`, 'g'),
  new RegExp(`${NUM}\\s*(?:${ANY_UNIT})\\s*x\\s*\\d+(?![\\d.])`, 'g'),
  new RegExp(`${NUM}(?:\\s*(?:-|–|to)\\s*${NUM})?\\s*(?:${ANY_UNIT})${END}`, 'g'),
  /(?:pack|set|combo|box)\s*of\s*\d+/g,
  /\b\d+\s*(?:packs?|pk|pkts?|packets?)(?![a-z])/g,
  /(?:\d+(?:\.\d+)?\s*)?(?:half\s+)?(?:dozens?|dzn|dz)(?![a-z])/g,
  /\bapprox(?:imately|\.)?/g,
];

/** Title with every pack-size expression removed (folded to lowercase). */
export function stripAllSizes(name: string | undefined): string {
  let s = fixSizeTypos(foldText(name));
  for (const re of ALL_SIZE_RES) s = s.replace(re, ' ');
  return s.replace(/\(\s*[^a-z0-9()]*\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

export function familyKey(item: KeyableItem | null | undefined): string {
  return productKey(stripSizeToken(itemName(item)), '');
}

// ---------- Quantity parsing ----------

export type QuantityKind = 'weight' | 'volume' | 'count';

export interface ParsedQuantity {
  /** Total grams across the whole listing (multipacks multiplied out). */
  weight?: number;
  /** Total millilitres. */
  volume?: number;
  /** Total pieces. */
  count?: number;
  /** Multipack factor: 3 for "Pack of 3", "3 x 100 g", "100 g x 3". */
  packs: number;
  /** Kind of the first measurement in the text (what the listing leads with). */
  primary: QuantityKind;
  /** The title names a multipack ("Pack of 2") that the unit field does not show. */
  uncertain?: boolean;
}

function unitKind(u: string): { kind: QuantityKind; mult: number } {
  if (new RegExp(`^(?:${WEIGHT_UNITS})$`).test(u)) {
    if (u === 'mg') return { kind: 'weight', mult: 0.001 };
    return { kind: 'weight', mult: /^k/.test(u) ? 1000 : 1 };
  }
  if (new RegExp(`^(?:${VOLUME_UNITS})$`).test(u)) {
    return { kind: 'volume', mult: /^m/.test(u) ? 1 : 1000 };
  }
  return { kind: 'count', mult: 1 };
}

// "Pack of 3", "Set of 2", "6 pack": the multipack count, 1 when absent.
function packOfCount(s: string): number {
  let n = 1;
  for (const m of [s.match(/(?:pack|set|combo|box)\s*of\s*(\d+)/), s.match(/\b(\d+)\s*(?:packs?|pk|pkts?|packets?)(?![a-z])/)]) {
    if (m) n = Math.max(n, parseFloat(m[1]) || 1);
  }
  return n;
}

const MEASURE_RE = new RegExp(`(${NUM})(?:\\s*(?:-|–|to)\\s*(${NUM}))?\\s*(${ANY_UNIT})${END}`, 'g');

// Listings without a pack size come through as "1 unit" (api.ts default):
// that is "unknown", not a count of one.
export function isUnknownQuantity(raw: string | undefined | null): boolean {
  return /^\s*(?:1\s*)?units?\s*$/i.test(String(raw || '')) || !String(raw || '').trim();
}

/**
 * Parses a pack-size string ("500 g", "2 x 500 ml", "1 dozen", "Pack of 3 52 g",
 * "3 pcs (approx. 450-600 g)") into totals per kind. Null when no size is found.
 */
export function parseQuantity(raw: string | undefined | null): ParsedQuantity | null {
  const s = fixSizeTypos(foldText(raw)).replace(/\*/g, ' x ');
  if (!s.trim()) return null;

  let packs = 1;
  // "4 x 70 g" / "70 g x 4": the per-pack measure comes from the expression itself,
  // so a total written next to it ("280 g (4 x 70 g)") is not multiplied again.
  let perPack: { kind: QuantityKind; value: number } | null = null;
  const before = s.match(new RegExp(`(\\d+)\\s*x\\s*(${NUM})\\s*(${ANY_UNIT})${END}`));
  const after = s.match(new RegExp(`(${NUM})\\s*(${ANY_UNIT})\\s*x\\s*(\\d+)(?![\\d.])`));
  if (before) {
    packs = parseFloat(before[1]) || 1;
    const u = unitKind(before[3]);
    perPack = { kind: u.kind, value: parseFloat(before[2]) * u.mult };
  } else if (after) {
    packs = parseFloat(after[3]) || 1;
    const u = unitKind(after[2]);
    perPack = { kind: u.kind, value: parseFloat(after[1]) * u.mult };
  }
  if (!perPack) packs = Math.max(packs, packOfCount(s));

  const found: Partial<Record<QuantityKind, number>> = {};
  let primary: QuantityKind | null = null;
  let firstAt = Infinity;
  MEASURE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEASURE_RE.exec(s))) {
    const hi = m[2] ? parseFloat(m[2]) : parseFloat(m[1]);
    // "450 - 600 g" is a range; "Combo of 2 - 1 kg" is not.
    const lo = m[2] && parseFloat(m[1]) < hi ? parseFloat(m[1]) : hi;
    const { kind, mult } = unitKind(m[3]);
    if (found[kind] === undefined) found[kind] = ((lo + hi) / 2) * mult;
    if (m.index < firstAt) { firstAt = m.index; primary = kind; }
  }

  const dozen = s.match(/(?:(\d+(?:\.\d+)?)\s*)?(half\s+)?(?:dozens?|dzn|dz)(?![a-z])/);
  if (dozen && found.count === undefined) {
    found.count = (dozen[2] ? 0.5 : 1) * (dozen[1] ? parseFloat(dozen[1]) : 1) * 12;
    if ((dozen.index ?? Infinity) < firstAt) { firstAt = dozen.index ?? 0; primary = 'count'; }
  }

  if (!primary) {
    // "Pack of 6" with no other measure = six pieces.
    if (packs > 1) return { count: packs, packs: 1, primary: 'count' };
    return null;
  }
  const out: ParsedQuantity = { packs, primary };
  if (perPack) found[perPack.kind] = perPack.value;
  if (found.weight !== undefined) out.weight = found.weight * packs;
  if (found.volume !== undefined) out.volume = found.volume * packs;
  // "6 pcs (Pack of 6)" names the same six pieces twice.
  if (found.count !== undefined) out.count = !perPack && found.count === packs ? found.count : found.count * packs;
  return out;
}

/** Quantity of a listing: its unit field, else a size written in its name. */
export function quantityOf(item: KeyableItem | null | undefined): ParsedQuantity | null {
  if (!item) return null;
  const unit = itemUnit(item);
  const fromUnit = isUnknownQuantity(unit) ? null : parseQuantity(unit);
  if (!fromUnit) return parseQuantity(itemName(item));
  // "Tata Salt (Pack of 2)" sold as "1 kg": per pack or in total? Can't tell.
  const name = foldText(itemName(item));
  const namePacks = Math.max(packOfCount(name), parseQuantity(name)?.packs ?? 1);
  if (namePacks > 1 && fromUnit.packs === 1) return { ...fromUnit, uncertain: true };
  return fromUnit;
}

// Normalized size in g/ml/pcs of the listing's leading measure; Infinity if unparseable.
export function variantSize(item: KeyableItem | null | undefined): number {
  const q = quantityOf(item);
  if (!q) return Infinity;
  const v = q[q.primary];
  return v === undefined ? Infinity : Math.round(v * 1000) / 1000;
}
