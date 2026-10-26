// Cross-store product matcher.
//
// Two layers:
//  - `scoreMatch` / `decideMatch`: the ranking used to link a listing on one
//    store to its twin on another. Titles are normalised (accents, apostrophes,
//    Hindi/English synonyms, sizes stripped), then scored on brand, name overlap,
//    variant words, pack size, unit price and stock, with hard rejects for things
//    that can never be the same product (different brand, Zero vs regular,
//    weight vs volume...). `decideMatch` turns the scores into a band:
//    'auto' (safe to link without asking), 'suggest' (show it, user confirms) or
//    'none'.
//  - `isSameProduct`: a strict identity check (wording differences only, same
//    pack size) used to re-find a stored listing in its own store's results.
//
// `matchScore` / `pickBestMatch` remain for older callers and sit on top of the
// same scoring.
import { foldText, itemName, itemUnit, quantityOf, stripAllSizes, ParsedQuantity, QuantityKind } from './productKey';

/** Floor for the legacy `pickBestMatch`. */
export const MATCH_THRESHOLD = 0.5;
/** `decideMatch` bands. */
export const AUTO_MIN = 0.85;
export const SUGGEST_MIN = 0.6;
/** Auto-link needs the best candidate this far ahead of the runner-up. */
export const AUTO_MARGIN = 0.1;
// Legacy pickBestMatch: top pick is flagged ambiguous when the runner-up is this close.
const AMBIGUOUS_MARGIN = 0.05;
// Same-product check used to re-validate stored basket links.
const SAME_PRODUCT_NAME = 0.85;

// Accepts both match targets ({name, unit}) and UnifiedProduct rows ({title, quantity}).
export interface MatchableItem {
  name?: string;
  title?: string;
  unit?: string;
  quantity?: string;
  price?: number;
  inStock?: boolean;
}

// ---------- Vocabulary ----------

// Words that carry no product identity at all (packaging, filler, offers).
const STOPWORDS = new Set([
  'of', 'with', 'and', 'the', 'a', 'an', 'for', 'in', 'by', 'from', 'to', 'on',
  'fresh', 'pack', 'pouch', 'bottle', 'packet', 'pkt', 'pc', 'pcs', 'piece', 'combo', 'jar', 'can', 'tin', 'box',
  'carton', 'tetra', 'tetrapak', 'pak', 'tray', 'cup', 'tub', 'refill', 'sachet', 'bag', 'approx', 'each', 'per', 'net', 'wt',
  'qty', 'x', 'buy', 'get', 'offer', 'save', 'off', 'rs', 'inr', 'mrp', 'free', 'only',
]);

// Spelling / language variants collapsed to one canonical token.
const SYNONYMS: Record<string, string> = {
  dahi: 'curd', yoghurt: 'yogurt', yogourt: 'yogurt',
  chilli: 'chili', chillies: 'chili', chilies: 'chili', chiles: 'chili', mirch: 'chili', mirchi: 'chili',
  tomatoes: 'tomato', tamatar: 'tomato', potatoes: 'potato', aloo: 'potato', alu: 'potato', batata: 'potato',
  pyaz: 'onion', pyaaz: 'onion', piyaz: 'onion', kanda: 'onion', onions: 'onion',
  biscuits: 'biscuit', cookies: 'cookie', coriander: 'dhaniya', cilantro: 'dhaniya', dhania: 'dhaniya',
  capsicum: 'bellpepper', paneer: 'cottagecheese', ghee: 'clarifiedbutter',
  haldi: 'turmeric', jeera: 'cumin', zeera: 'cumin', bhindi: 'okra', bhendi: 'okra', ladyfinger: 'okra',
  adrak: 'ginger', lehsun: 'garlic', lahsun: 'garlic', lasun: 'garlic', palak: 'spinach', methi: 'fenugreek',
  matar: 'pea', mutter: 'pea', peas: 'pea', gajar: 'carrot', kheera: 'cucumber', khira: 'cucumber',
  baingan: 'brinjal', eggplant: 'brinjal', aubergine: 'brinjal', lauki: 'bottlegourd', dudhi: 'bottlegourd',
  doodhi: 'bottlegourd', karela: 'bittergourd', nimbu: 'lemon', nimboo: 'lemon', lemons: 'lemon',
  kela: 'banana', seb: 'apple', anda: 'egg', ande: 'egg', eggs: 'egg', chawal: 'rice', chini: 'sugar',
  shakkar: 'sugar', namak: 'salt', doodh: 'milk', makhan: 'butter', channa: 'chana', chickpea: 'kabulichana',
  chickpeas: 'kabulichana', chole: 'kabulichana', chhole: 'kabulichana', tur: 'toor', tuvar: 'toor',
  arhar: 'toor', mung: 'moong', urd: 'urad', suji: 'sooji', rava: 'sooji', rawa: 'sooji', semolina: 'sooji',
  elaichi: 'cardamom', laung: 'clove', lavang: 'clove', cloves: 'clove', dalchini: 'cinnamon',
  carom: 'ajwain', rai: 'mustard', sarson: 'mustard', til: 'sesame', saunf: 'fennel', asafoetida: 'hing',
  imli: 'tamarind', gud: 'jaggery', gur: 'jaggery', shahad: 'honey', kaju: 'cashew', cashews: 'cashew',
  badam: 'almond', almonds: 'almond', kishmish: 'raisin', raisins: 'raisin', akhrot: 'walnut',
  walnuts: 'walnut', pista: 'pistachio', pistachios: 'pistachio', pudina: 'mint', kesar: 'saffron',
  santra: 'orange', angoor: 'grape', anar: 'pomegranate', papita: 'papaya', nariyal: 'coconut',
  amrood: 'guava', chiku: 'sapota', chikoo: 'sapota', mooli: 'radish', chukandar: 'beetroot', beet: 'beetroot',
  kaddu: 'pumpkin', makka: 'corn', makai: 'corn', bhutta: 'corn', tel: 'oil', chai: 'tea', daal: 'dal',
  dhal: 'dal', aata: 'atta', soy: 'soya', soybean: 'soyabean', peanut: 'groundnut', peanuts: 'groundnut',
  moongphali: 'groundnut', mungfali: 'groundnut', leaves: 'leaf', kala: 'black', kali: 'black', hari: 'green',
  lal: 'red', standardised: 'standardized', homogenized: 'homogenised', pasteurized: 'pasteurised',
  iodized: 'iodised', flavor: 'flavour', flavored: 'flavour', flavoured: 'flavour', decaffeinated: 'decaf',
  // brand spellings
  coke: 'cocacola', cocacola: 'cocacola', thumsup: 'thumsup', lays: 'lays', lay: 'lays',
  aashirwad: 'aashirvaad', ashirwad: 'aashirvaad', ashirvaad: 'aashirvaad', aashirvad: 'aashirvaad',
  ashirvad: 'aashirvaad', haldirams: 'haldiram', kelloggs: 'kelloggs', kellogg: 'kelloggs', kellogs: 'kelloggs',
  cadburys: 'cadbury', britania: 'britannia', maggie: 'maggi', mcvities: 'mcvities', gowardhan: 'gowardhan',
  govardhan: 'gowardhan', hersheys: 'hersheys', chings: 'chings', bagrrys: 'bagrrys', venkys: 'venkys',
  hellmanns: 'hellmanns', ponds: 'ponds', chaas: 'buttermilk', chhach: 'buttermilk', patta: 'leaf', patti: 'leaf',
  achaari: 'achari', chips: 'chip', seeds: 'seed',
};

// Multi-word phrases (written in plain words, normalised at load) -> one token.
const PHRASES: [string, string][] = [
  ['whole wheat atta', 'atta'], ['whole wheat flour', 'atta'], ['wheat atta', 'atta'], ['wheat flour', 'atta'],
  ['chakki atta', 'atta'], ['refined flour', 'maida'], ['all purpose flour', 'maida'], ['gram flour', 'besan'],
  ['cottage cheese', 'paneer'], ['lady finger', 'ladyfinger'], ['ladies finger', 'ladyfinger'],
  ['bottle gourd', 'lauki'], ['bitter gourd', 'karela'], ['spring onion', 'springonion'],
  ['patta gobhi', 'cabbage'], ['patta gobi', 'cabbage'], ['phool gobhi', 'cauliflower'], ['phool gobi', 'cauliflower'],
  ['gobhi', 'cauliflower'], ['gobi', 'cauliflower'], ['shimla mirch', 'capsicum'], ['bell pepper', 'capsicum'],
  ['kali mirch', 'blackpepper'], ['black pepper', 'blackpepper'], ['sweet potato', 'sweetpotato'],
  ['sweet corn', 'sweetcorn'], ['sweet lime', 'mosambi'], ['curry leaf', 'curryleaf'], ['kadi patta', 'curryleaf'],
  ['kadhi patta', 'curryleaf'], ['curry patta', 'curryleaf'], ['kabuli chana', 'kabulichana'],
  ['pigeon pea', 'toor'], ['green gram', 'moong'], ['kidney bean', 'rajma'], ['flattened rice', 'poha'],
  ['beaten rice', 'poha'], ['fox nut', 'makhana'], ['lotus seed', 'makhana'], ['peanut butter', 'peanutbutter'],
  ['sugar free', 'sugarfree'], ['no sugar', 'sugarfree'], ['no added sugar', 'sugarfree'], ['zero sugar', 'zero'],
  ['less sugar', 'lesssugar'], ['low fat', 'lowfat'], ['fat free', 'fatfree'], ['gluten free', 'glutenfree'],
  ['lactose free', 'lactosefree'], ['low sodium', 'lowsodium'], ['full cream', 'fullcream'],
  ['double toned', 'doubletoned'], ['extra virgin', 'extravirgin'], ['cold pressed', 'coldpressed'],
  ['kachi ghani', 'kachighani'], ['extra hot', 'extrahot'], ['mixed fruit', 'mixedfruit'],
  ['ice cream', 'icecream'], ['soft drink', 'softdrink'], ['cold drink', 'softdrink'], ['health drink', 'healthdrink'],
  ['potato chips', 'chip'], ['potato chip', 'chip'], ['butter milk', 'buttermilk'], ['leaf tea', 'tea'],
  ['coffee powder', 'coffee'], ['chocolate bar', 'bar'], ['dairy milk chocolate', 'dairymilk'],
  ['silk chocolate', 'silk'], ['energy drink', 'drink'], ['fruit drink', 'drink'], ['uncle chips', 'unclechipps'], ['detergent powder', 'detergent'], ['washing powder', 'detergent'],
  ['tooth paste', 'toothpaste'], ['hand wash', 'handwash'], ['dish wash', 'dishwash'], ['body wash', 'bodywash'],
  ['face wash', 'facewash'], ['corn flakes', 'cornflakes'], ['2 minute', 'minute'], ['two minute', 'minute'],
  ['hygienically packed', 'packed'], ['vacuum evaporated', 'iodised'], ['top load', 'topload'],
  ['front load', 'frontload'],
  ['coca cola', 'cocacola'], ['thums up', 'thumsup'], ['thumbs up', 'thumsup'], ['7 up', '7up'],
  ['mountain dew', 'mountaindew'], ['minute maid', 'minutemaid'], ['red bull', 'redbull'], ['red label', 'redlabel'],
  ['parle g', 'parleg'], ['dairy milk', 'dairymilk'], ['good day', 'goodday'], ['marie gold', 'mariegold'],
  ['nature fresh', 'naturefresh'],
];

// Known brands (umbrella brands and the product lines titles lead with), with
// an optional parent so "Nestle Maggi" and "Maggi" agree. Multi-word names are
// joined into one token automatically.
const BRANDS: [string, string?][] = [
  ['amul'], ['mother dairy'], ['nandini'], ['heritage'], ['aavin'], ['milky mist'], ['akshayakalpa'],
  ['country delight'], ['gowardhan'], ['britannia'], ['parle'], ['parle agro'], ['frooti', 'parle agro'],
  ['appy', 'parle agro'], ['itc'], ['sunfeast', 'itc'], ['aashirvaad', 'itc'], ['bingo', 'itc'], ['yippee', 'itc'],
  ['b natural', 'itc'], ['savlon', 'itc'], ['fiama', 'itc'], ['tata'], ['tata sampann', 'tata'],
  ['tetley', 'tata'], ['tata soulfull', 'tata'], ['nestle'], ['maggi', 'nestle'],
  ['milkmaid', 'nestle'], ['kitkat', 'nestle'], ['munch', 'nestle'], ['nescafe', 'nestle'], ['cerelac', 'nestle'],
  ['cadbury'], ['bournvita', 'cadbury'], ['oreo', 'cadbury'], ['pepsico'], ['lays', 'pepsico'],
  ['kurkure', 'pepsico'], ['uncle chipps', 'pepsico'], ['doritos', 'pepsico'], ['quaker', 'pepsico'],
  ['tropicana', 'pepsico'], ['pepsi', 'pepsico'], ['mountain dew', 'pepsico'], ['7up', 'pepsico'],
  ['mirinda', 'pepsico'], ['aquafina', 'pepsico'], ['sting', 'pepsico'], ['tccc'], ['cocacola', 'tccc'],
  ['thums up', 'tccc'], ['sprite', 'tccc'], ['fanta', 'tccc'], ['limca', 'tccc'],
  ['maaza', 'tccc'], ['minute maid', 'tccc'], ['kinley', 'tccc'], ['haldiram'], ['bikaji'],
  ['bikano'], ['balaji'], ['pringles'], ['too yumm'], ['cornitos'], ['hul'], ['kissan', 'hul'], ['knorr', 'hul'],
  ['brooke bond', 'hul'], ['red label', 'brooke bond'], ['taj mahal', 'brooke bond'], ['bru', 'hul'],
  ['surf excel', 'hul'], ['rin', 'hul'], ['wheel', 'hul'], ['vim', 'hul'], ['domex', 'hul'], ['lifebuoy', 'hul'],
  ['lux', 'hul'], ['dove', 'hul'], ['pepsodent', 'hul'], ['closeup', 'hul'], ['sunsilk', 'hul'],
  ['clinic plus', 'hul'], ['vaseline', 'hul'], ['ponds', 'hul'], ['hamam', 'hul'], ['p and g'], ['ariel', 'p and g'],
  ['tide', 'p and g'], ['pantene', 'p and g'], ['head and shoulders', 'p and g'], ['whisper', 'p and g'],
  ['gillette', 'p and g'], ['pampers', 'p and g'], ['reckitt'], ['harpic', 'reckitt'], ['lizol', 'reckitt'],
  ['dettol', 'reckitt'], ['colgate'], ['palmolive', 'colgate'], ['sensodyne'], ['dabur'], ['hajmola', 'dabur'],
  ['patanjali'], ['himalaya'], ['mdh'], ['everest'], ['catch'], ['mtr'], ['gits'], ['fortune'], ['marico'],
  ['saffola', 'marico'], ['parachute', 'marico'], ['sundrop'], ['dhara'], ['gemini'], ['figaro'], ['borges'],
  ['disano'], ['del monte'], ['kelloggs'], ['chocos', 'kelloggs'], ['bagrrys'], ['true elements'], ['yoga bar'],
  ['epigamia'], ['english oven'], ['harvest gold'], ['wibs'], ['bonn'], ['kwality walls'], ['havmor'],
  ['baskin robbins'], ['vadilal'], ['hersheys'], ['nutella'], ['ferrero'], ['snickers'], ['bounty'], ['galaxy'],
  ['toblerone'], ['lindt'], ['unibic'], ['mcvities'], ['india gate'], ['daawat'], ['kohinoor'], ['lal qilla'],
  ['annapurna'], ['pillsbury'], ['rajdhani'], ['organic tattva'], ['24 mantra'], ['pro nature'], ['safal'],
  ['mothers recipe'], ['priya'], ['chings'], ['veeba'], ['funfoods'], ['hellmanns'], ['mapro'], ['paper boat'],
  ['bisleri'], ['redbull'], ['monster'], ['raw pressery'], ['horlicks'], ['complan'], ['boost'], ['pediasure'],
  ['ensure'], ['protinex'], ['nivea'], ['godrej'], ['good knight', 'godrej'], ['cinthol', 'godrej'], ['santoor'],
  ['medimix'], ['all out'], ['odonil'], ['mamypoko'], ['huggies'], ['stayfree'], ['ghadi'], ['nirma'], ['exo'],
  ['pril'], ['scotch brite'], ['naturefresh'], ['venkys'], ['suguna'], ['eggoz'], ['henfruit'], ['happilo'],
  ['nutraj'], ['farmley'], ['wingreens'], ['lijjat'], ['eastern'], ['aachi'], ['sakthi'], ['kitchens of india', 'itc'],
  ['jivo'], ['emami'], ['tops'], ['weikfield'], ['keya'], ['tang'],
  ['parleg', 'parle'], ['goodday', 'britannia'], ['mariegold', 'britannia'], ['monaco', 'parle'],
  ['krackjack', 'parle'], ['hide and seek', 'parle'], ['little hearts', 'britannia'], ['nutrichoice', 'britannia'],
];

// Descriptor / packaging / category words: present on one side only, they say
// nothing about which product it is ("Fresh", "Premium", "Chips", "Iodised").
const GENERIC = new Set([
  'premium', 'pure', 'shudh', 'chakki', 'natural', 'classic', 'original', 'regular', 'new', 'improved', 'best',
  'quality', 'special', 'superior', 'daily', 'value', 'standard', 'family', 'healthy', 'tasty', 'delicious',
  'instant', 'minute', 'ready', 'packed', 'hygienic', 'iodised', 'vacuum', 'evaporated', 'pasteurised',
  'homogenised', 'refined', 'india', 'indian', 'loose', 'chips', 'chip', 'crisp', 'namkeen', 'snack', 'softdrink',
  'drink', 'beverage', 'noodle', 'biscuit', 'cookie', 'bar', 'detergent', 'juice', 'taste', 'flavour', 'rich',
  'farm', 'wash', 'healthdrink', 'style', 'pasteurized', 'hybrid', 'processed', 'mineral', 'packaged', 'drinking',
  'disinfectant', 'bathing', 'soap', 'powder', 'edible', 'cooking', 'unpolished',
]);
// "hybrid" (tomato) is the default variety on both apps, so it is descriptive.

// One-sided presence of these means a different product ("Coca-Cola" vs "Coca-Cola Zero").
const HARD_QUALIFIERS = new Set([
  'zero', 'diet', 'sugarfree', 'unsalted', 'lite', 'light', 'decaf', 'lowfat', 'fatfree', 'glutenfree',
  'eggless', 'unsweetened', 'lactosefree', 'sugarless', 'lowsodium', 'lesssugar',
]);

// Mutually exclusive variant words: a candidate carrying a *different* member
// of a group than the target is a different product, regardless of other overlap.
const CONFLICT_GROUPS_RAW: string[][] = [
  ['salted', 'unsalted'],
  ['toned', 'doubletoned', 'fullcream', 'skimmed', 'slim', 'lowfat', 'standardized'],
  ['taaza', 'gold', 'shakti'],
  ['diet', 'zero', 'regular', 'sugarfree'],
  ['sweet', 'sweetened', 'unsweetened'],
  ['white', 'brown', 'black', 'red', 'green', 'yellow'],
  ['mild', 'spicy', 'hot', 'extrahot'],
  ['original', 'chocolate', 'vanilla', 'strawberry', 'mango', 'butterscotch', 'orange', 'lemon', 'lime', 'pineapple',
    'apple', 'litchi', 'guava', 'mixedfruit', 'saffron', 'cardamom', 'rose', 'coffee', 'caramel', 'mint', 'masala',
    'tomato', 'onion', 'cheese', 'peri', 'jalapeno', 'chicken', 'chili', 'salted', 'plain', 'cream', 'butter',
    'cashew', 'almond', 'pista', 'blueberry', 'grape', 'kesar', 'elaichi', 'badam'],
  ['small', 'medium', 'large', 'jumbo', 'mini'],
  ['cow', 'buffalo'],
  ['raw', 'roasted', 'boiled'],
  ['topload', 'frontload'],
  ['liquid', 'powder', 'gel', 'spray', 'tablet', 'cube', 'bar'],
  ['whole', 'seed', 'powder', 'crushed', 'split', 'flake'],
];

// ---------- Normalisation ----------

function stem(t: string): string {
  if (t.length > 3 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('oes')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function normalizeWord(t: string): string {
  if (SYNONYMS[t]) return SYNONYMS[t];
  const s = stem(t);
  return SYNONYMS[s] || s;
}

const words = (s: string) => s.split(/[^a-z0-9]+/).filter(Boolean);

// Phrase table keyed by the normalised words, longest first.
const PHRASE_TABLE: { from: string[]; to: string }[] = [
  ...PHRASES.map(([from, to]) => ({ from: words(from).map(normalizeWord), to })),
  ...BRANDS.map(([b]) => words(b)).filter(w => w.length > 1).map(w => ({ from: w.map(normalizeWord), to: w.join('') })),
].sort((a, b) => b.from.length - a.from.length);

// Phrase outputs are canonical already (only synonym-mapped, never stemmed).
function joinPhrases(list: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length;) {
    const hit = PHRASE_TABLE.find(p => p.from.every((w, k) => list[i + k] === w));
    if (hit) { out.push(SYNONYMS[hit.to] || hit.to); i += hit.from.length; } else { out.push(list[i]); i++; }
  }
  return out;
}

// Normalised tokens of a phrase, stopwords included.
const rawTokens = (str: string | undefined) => joinPhrases(words(stripAllSizes(str)).map(normalizeWord));

const norm = (list: Iterable<string>) => new Set([...list].map(normalizeWord));
const STOP_NORM = new Set([...STOPWORDS, ...norm(STOPWORDS)]);
const GENERIC_NORM = new Set([...GENERIC, ...norm(GENERIC)]);
const HARD_NORM = new Set([...HARD_QUALIFIERS, ...norm(HARD_QUALIFIERS)]);
const CONFLICT_GROUPS = CONFLICT_GROUPS_RAW.map(g => [...new Set(g.map(normalizeWord))]);

// Brand token = what the brand name itself tokenises to, so it lines up with titles.
const brandToken = (b: string) => rawTokens(b).join('');
const BRAND_PARENT = new Map<string, string | null>();
BRANDS.forEach(([b, parent]) => BRAND_PARENT.set(brandToken(b), parent ? brandToken(parent) : null));

// Ordered, normalised, stopword-free tokens of a title with its sizes removed
// (order kept so the leading token, usually the brand, can be weighted).
export function nameTokens(str: string | undefined): string[] {
  const out: string[] = [];
  rawTokens(str).forEach(t => {
    if (STOP_NORM.has(t) || out.includes(t)) return;
    out.push(t);
  });
  return out;
}

export function tokenSet(str: string | undefined): Set<string> {
  return new Set(nameTokens(str));
}

function hasVariantConflict(ta: Set<string>, tb: Set<string>): boolean {
  return oneSidedQualifier(ta, tb) !== null || conflictingVariant(ta, tb) !== null;
}

function oneSidedQualifier(ta: Set<string>, tb: Set<string>): string | null {
  const qa = [...ta].filter(t => HARD_NORM.has(t));
  const qb = [...tb].filter(t => HARD_NORM.has(t));
  if ((qa.length > 0) === (qb.length > 0)) return null;
  return (qa[0] || qb[0]) as string;
}

function conflictingVariant(ta: Set<string>, tb: Set<string>): [string, string] | null {
  for (const group of CONFLICT_GROUPS) {
    const ga = group.filter(w => ta.has(w));
    const gb = group.filter(w => tb.has(w));
    if (ga.length > 0 && gb.length > 0 && !ga.some(w => gb.includes(w))) return [ga[0], gb[0]];
  }
  return null;
}

// Weighted Jaccard over the size-stripped name tokens: the strict, symmetric
// similarity behind isSameProduct. The leading token (usually the brand) counts
// extra; conflicting variant words zero the score.
export function nameSimilarity(a: string | undefined, b: string | undefined): number {
  const la = nameTokens(a);
  const lb = nameTokens(b);
  if (!la.length || !lb.length) return 0;
  const ta = new Set(la), tb = new Set(lb);
  if (hasVariantConflict(ta, tb)) return 0;
  const weighted = la.length > 1 && lb.length > 1;
  const w = (t: string, list: string[]) => (weighted && list[0] === t ? 2.5 : 1);
  let shared = 0, total = 0;
  const all = new Set([...la, ...lb]);
  all.forEach(t => {
    const wa = ta.has(t) ? w(t, la) : 0;
    const wb = tb.has(t) ? w(t, lb) : 0;
    shared += Math.min(wa, wb);
    total += Math.max(wa, wb);
  });
  let sim = total ? shared / total : 0;
  // Different leading token on both sides = different brand ("Tata Salt" vs "Aashirvaad Salt").
  if (weighted && !tb.has(la[0]) && !ta.has(lb[0])) sim *= 0.5;
  // Each side carries words the other lacks ("Pav Bread" vs "Milk Bread"): that
  // is two different products, not one listing with extra wording.
  if (la.some(t => !tb.has(t)) && lb.some(t => !ta.has(t))) sim *= 0.75;
  return sim;
}

// ---------- Quantity comparison ----------

type QtyStatus = 'same' | 'near' | 'multipack' | 'close' | 'multiple' | 'different' | 'incomparable' | 'conflict' | 'unknown';

interface QtyCompare {
  status: QtyStatus;
  kind?: QuantityKind;
  ratio?: number;
  a?: number;
  b?: number;
}

const kindsOf = (q: ParsedQuantity): QuantityKind[] =>
  (['weight', 'volume', 'count'] as QuantityKind[]).filter(k => q[k] !== undefined);

function compareQuantity(qa: ParsedQuantity | null, qb: ParsedQuantity | null): QtyCompare {
  if (!qa || !qb) return { status: 'unknown' };
  const ka = kindsOf(qa), kb = kindsOf(qb);
  const shared = ka.filter(k => kb.includes(k));
  if (!shared.length) {
    const measured = (ks: QuantityKind[]) => ks.some(k => k !== 'count');
    return { status: measured(ka) && measured(kb) ? 'conflict' : 'incomparable' };
  }
  const kind = shared.includes(qa.primary) ? qa.primary : shared.includes(qb.primary) ? qb.primary : shared[0];
  const a = qa[kind]!, b = qb[kind]!;
  if (!(a > 0) || !(b > 0)) return { status: 'unknown' };
  const ratio = Math.max(a, b) / Math.min(a, b);
  const base = { kind, ratio, a, b };
  if (ratio <= 1.1 && (qa.packs !== qb.packs || qa.uncertain || qb.uncertain)) return { status: 'multipack', ...base };
  if (ratio <= 1.02) return { status: 'same', ...base };
  if (ratio <= 1.1) return { status: 'near', ...base };
  if (ratio <= 1.25) return { status: 'close', ...base };
  if (ratio <= 4.05 && Math.abs(ratio - Math.round(ratio)) < 0.05) return { status: 'multiple', ...base };
  return { status: 'different', ...base };
}

const trim = (n: number) => String(Math.round(n * 100) / 100);
function fmtAmount(kind: QuantityKind, n: number): string {
  if (kind === 'weight') return n >= 1000 ? `${trim(n / 1000)} kg` : `${trim(n)} g`;
  if (kind === 'volume') return n >= 1000 ? `${trim(n / 1000)} L` : `${trim(n)} ml`;
  return `${trim(n)} pcs`;
}
function fmtQty(q: ParsedQuantity | null, kind?: QuantityKind): string {
  if (!q) return '?';
  const k = kind && q[kind] !== undefined ? kind : q.primary;
  const total = q[k]!;
  return q.packs > 1 && k !== 'count' ? `${q.packs} × ${fmtAmount(k, total / q.packs)}` : fmtAmount(k, total);
}

// Pack-size compatibility in [0,1]. Same normalized size = 1; near-equal
// (±10%) = 0.9; ±25% = 0.6; whole-number multiple ≤4x (500g vs 1kg) = 0.5;
// different unit type (weight vs volume, count vs weight) or unrelated size = 0;
// unparseable = 0.4.
export function sizeScore(target: MatchableItem, candidate: MatchableItem): number {
  const qa = quantityOf(target), qb = quantityOf(candidate);
  if (!qa || !qb) return 0.4;
  const c = compareQuantity(qa, qb);
  if (c.status === 'conflict' || c.status === 'incomparable' || c.ratio === undefined) return 0;
  const ratio = c.ratio;
  if (ratio < 1.0005) return 1;
  if (ratio <= 1.1) return 0.9;
  if (ratio <= 1.25) return 0.6;
  if (ratio <= 4.05 && Math.abs(ratio - Math.round(ratio)) < 0.05) return 0.5;
  return 0;
}

// ---------- Scoring ----------

interface Analysed {
  tokens: string[];
  brands: string[];
  distinctive: Set<string>;
  qty: ParsedQuantity | null;
  price: number;
  inStock: boolean;
}

// Umbrella brands (no parent) are compared as brands only; product-line brands
// ("Maggi", "Good Day") also stay in the name, since they say which product it is.
const isUmbrella = (t: string) => BRAND_PARENT.has(t) && !BRAND_PARENT.get(t);

function analyse(item: MatchableItem): Analysed {
  return withTokens(nameTokens(itemName(item)), quantityOf(item), Number(item.price) || 0, item.inStock !== false);
}

function withTokens(tokens: string[], qty: ParsedQuantity | null, price: number, inStock: boolean): Analysed {
  const brands = tokens.filter(t => BRAND_PARENT.has(t));
  // "Brooke Bond Red Label": the parent mention adds nothing once the line is named.
  const parentMention = (t: string) => brands.some(b => b !== t && ancestors(b).includes(t));
  const distinctive = new Set(tokens.filter(t =>
    !isUmbrella(t) && !parentMention(t) && !GENERIC_NORM.has(t) && !/^\d+$/.test(t)));
  return { tokens, brands, distinctive, qty, price, inStock };
}

// "Max Fresh" vs "MaxFresh", "Soya Bean" vs "Soyabean": join adjacent words
// when the joined form is what the other title uses.
function joinCompounds(A: Analysed, B: Analysed): [Analysed, Analysed] {
  const join = (x: Analysed, other: Set<string>): Analysed => {
    const out: string[] = [];
    let changed = false;
    for (let i = 0; i < x.tokens.length; i++) {
      const pair = x.tokens[i] + (x.tokens[i + 1] ?? '');
      if (i + 1 < x.tokens.length && other.has(pair) && !other.has(x.tokens[i])) { out.push(pair); i++; changed = true; } else out.push(x.tokens[i]);
    }
    return changed ? withTokens(out, x.qty, x.price, x.inStock) : x;
  };
  return [join(A, new Set(B.tokens)), join(B, new Set(A.tokens))];
}

function ancestors(b: string): string[] {
  const out = [b];
  let p = BRAND_PARENT.get(b);
  while (p && !out.includes(p)) { out.push(p); p = BRAND_PARENT.get(p); }
  return out;
}

// The leading brands agree when one names the other or its parent ("Nestle
// Maggi" ~ "Maggi"); sibling lines of one company ("Sunfeast" vs "Aashirvaad") do not.
function brandsAgree(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  return ancestors(a[0]).includes(b[0]) || ancestors(b[0]).includes(a[0]);
}

const pretty = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export interface MatchDetail {
  /** 0..1; 0 when rejected. */
  score: number;
  /** Can never be the same product (different brand, variant, weight vs volume...). */
  rejected: boolean;
  /** Nothing caps this pair below 'auto' (exact pack size, no unexplained words...). */
  autoEligible: boolean;
  /** Human-readable notes, most important first. */
  reasons: string[];
  parts: { brand: number; name: number; variant: number; size: number; price: number; stock: number };
}

const WEIGHTS = { brand: 0.15, name: 0.35, variant: 0.1, size: 0.2, price: 0.15, stock: 0.05 };

function priceCurve(r: number): number {
  return r <= 1.15 ? 1 : Math.max(0, 1 - (r - 1.15) / 1.85);
}

function rupees(n: number): string {
  const v = Math.round(n);
  return v === 0 ? '' : `, ${v > 0 ? '+' : '−'}₹${Math.abs(v)}`;
}

/** Full scoring of `candidate` as the twin of `target`, with the reasons behind it. */
export function scoreMatch(target: MatchableItem, candidate: MatchableItem): MatchDetail {
  return scoreAnalysed(analyse(target), analyse(candidate));
}

function scoreAnalysed(rawA: Analysed, rawB: Analysed): MatchDetail {
  const [A, B] = joinCompounds(rawA, rawB);
  const parts = { brand: 0, name: 0, variant: 0, size: 0, price: 0, stock: 0 };
  const reasons: string[] = [];
  let capped = false;
  const reject = (why: string): MatchDetail => ({ score: 0, rejected: true, autoEligible: false, reasons: [why, ...reasons], parts });

  if (!A.tokens.length || !B.tokens.length) return reject('no name to compare');
  const setA = new Set(A.tokens), setB = new Set(B.tokens);

  // Brand
  let nameMult = 1;
  if (A.brands.length && B.brands.length) {
    if (!brandsAgree(A.brands, B.brands)) return reject(`different brand (${pretty(A.brands[0])} vs ${pretty(B.brands[0])})`);
    parts.brand = 1;
  } else if (A.brands.length || B.brands.length) {
    const [branded, bare] = A.brands.length ? [setA, B.tokens] : [setB, A.tokens];
    parts.brand = 0.4;
    capped = true;
    if (bare.length > 1 && !branded.has(bare[0]) && !GENERIC_NORM.has(bare[0])) {
      nameMult = 0.6;
      reasons.push(`brand may differ (${pretty(bare[0])} vs ${pretty((A.brands[0] || B.brands[0]))})`);
    } else {
      reasons.push(A.brands.length ? 'no brand on this listing' : `brand only on this listing (${pretty(B.brands[0])})`);
    }
  } else if (A.tokens[0] === B.tokens[0]) {
    parts.brand = 0.8;
  } else if (A.tokens.length > 1 && B.tokens.length > 1 && !setB.has(A.tokens[0]) && !setA.has(B.tokens[0])) {
    parts.brand = 0.2;
    nameMult = 0.6;
    capped = true;
    reasons.push(`brand may differ (${pretty(A.tokens[0])} vs ${pretty(B.tokens[0])})`);
  } else {
    parts.brand = 0.6;
  }

  // Variant words
  const q = oneSidedQualifier(setA, setB);
  if (q) return reject(`"${q}" variant on one side only`);
  const conflict = conflictingVariant(setA, setB);
  if (conflict) return reject(`different variant (${conflict[0]} vs ${conflict[1]})`);

  // Name overlap on the distinctive words (brand and descriptors excluded)
  const DA = A.distinctive, DB = B.distinctive;
  const shared = [...DA].filter(t => DB.has(t));
  const onlyA = [...DA].filter(t => !DB.has(t));
  const onlyB = [...DB].filter(t => !DA.has(t));
  let name: number;
  if (DA.size && DB.size && !shared.length) return reject('different product');
  if (onlyA.length && onlyB.length) {
    name = (shared.length / Math.min(DA.size, DB.size)) * 0.5;
    parts.variant = 0.2;
    reasons.push(`different words (${onlyA.join(' ')} vs ${onlyB.join(' ')})`);
  } else if (onlyA.length || onlyB.length) {
    const extras = onlyA.length ? onlyA : onlyB;
    name = 1 - Math.min(0.5, 0.25 * extras.length);
    parts.variant = 0.3;
    capped = true;
    reasons.push(onlyB.length ? `extra words here: ${onlyB.join(', ')}` : `missing words: ${onlyA.join(', ')}`);
  } else {
    const anyShared = A.tokens.some(t => setB.has(t));
    name = DA.size || anyShared || brandsAgree(A.brands, B.brands) ? 1 : 0.5;
    parts.variant = 1;
  }
  name *= nameMult;
  if (name < 0.5) return reject(reasons.pop() || 'different product');
  parts.name = name;

  // Pack size
  const cmp = compareQuantity(A.qty, B.qty);
  const sizeA = fmtQty(A.qty, cmp.kind), sizeB = fmtQty(B.qty, cmp.kind);
  const delta = A.price && B.price ? rupees(B.price - A.price) : '';
  switch (cmp.status) {
    case 'conflict':
      return reject(`weight vs volume (${sizeA} vs ${sizeB})`);
    case 'same':
      parts.size = 1;
      break;
    case 'near':
      parts.size = 0.9;
      reasons.push(`size differs slightly (${sizeA} vs ${sizeB})`);
      break;
    case 'multipack':
      parts.size = 0.7;
      capped = true;
      reasons.push(`different packing (${sizeA} vs ${sizeB}${delta})`);
      break;
    case 'close':
    case 'multiple':
    case 'different':
      parts.size = cmp.status === 'close' ? 0.6 : cmp.status === 'multiple' ? 0.4 : 0.15;
      capped = true;
      reasons.unshift(`different size ${sizeA} vs ${sizeB}${delta}`);
      break;
    case 'incomparable':
      parts.size = 0.3;
      capped = true;
      reasons.unshift(`can't compare ${sizeA} with ${sizeB}`);
      break;
    default:
      parts.size = A.qty || B.qty ? 0.5 : 0.6;
      capped = true;
      reasons.push('pack size unknown');
  }

  // Price per unit of pack size when the sizes compare, else the raw price.
  if (!A.price || !B.price) {
    parts.price = 0.6;
  } else if (cmp.ratio !== undefined && cmp.a && cmp.b) {
    const ua = A.price / cmp.a, ub = B.price / cmp.b;
    const r = Math.max(ua, ub) / Math.min(ua, ub);
    parts.price = priceCurve(r);
    if (r > 1.75) {
      capped = true;
      reasons.push(`unit price ${trim(r)}× ${ub > ua ? 'higher' : 'lower'}`);
    }
  } else if (cmp.status === 'unknown' && !A.qty && !B.qty) {
    parts.price = priceCurve(Math.max(A.price, B.price) / Math.min(A.price, B.price));
  } else {
    parts.price = 0.5;
  }

  // Stock
  parts.stock = B.inStock ? 1 : 0;
  if (!B.inStock) {
    capped = true;
    reasons.push('out of stock');
  }

  const raw = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((s, k) => s + WEIGHTS[k] * parts[k], 0);
  const score = Math.round(raw * 1000) / 1000;
  return { score, rejected: false, autoEligible: !capped, reasons, parts };
}

export function matchScore(target: MatchableItem, candidate: MatchableItem): number {
  return scoreMatch(target, candidate).score;
}

// Strict identity check (not a ranking): is `candidate` the same product as
// `target`, allowing only wording/spelling differences and ~equal pack size?
export function isSameProduct(target: MatchableItem, candidate: MatchableItem): boolean {
  if (compareQuantity(quantityOf(target), quantityOf(candidate)).status === 'conflict') return false;
  if (scoreMatch(target, candidate).rejected) return false;
  return nameSimilarity(itemName(target), itemName(candidate)) >= SAME_PRODUCT_NAME && sizeScore(target, candidate) >= 0.9;
}

// ---------- Decisions ----------

export interface RankedCandidate<T> extends MatchDetail {
  candidate: T;
}

export type MatchBand = 'auto' | 'suggest' | 'none';

export interface MatchDecision<T> {
  band: MatchBand;
  /** The pick for 'auto' / 'suggest'; null for 'none'. */
  best: RankedCandidate<T> | null;
  /** Next best viable candidates (up to 3), sorted by score. */
  alternatives: RankedCandidate<T>[];
  /** Every candidate, best first (rejected ones last), for pickers. */
  ranked: RankedCandidate<T>[];
  /** Why this band, e.g. "different size 1 kg vs 500 g, +₹12". */
  reasons: string[];
}

export interface DecideOptions {
  autoMin?: number;
  suggestMin?: number;
  margin?: number;
}

function sizeDistance(target: MatchableItem, c: MatchableItem): number {
  const cmp = compareQuantity(quantityOf(target), quantityOf(c));
  return cmp.ratio === undefined ? Infinity : cmp.ratio;
}

/** Same listing twice (same words, same pack): not a competitor for the margin. */
function equivalent<T extends MatchableItem>(a: RankedCandidate<T>, b: RankedCandidate<T>): boolean {
  const ta = analyse(a.candidate), tb = analyse(b.candidate);
  const key = (x: Analysed) => [...x.brands, ...x.distinctive].sort().join(' ');
  const cmp = compareQuantity(ta.qty, tb.qty);
  return key(ta) === key(tb) && (cmp.status === 'same' || cmp.status === 'near');
}

/** Scores every candidate and sorts best first (ties: in stock, closest size, closest price). */
export function rankCandidates<T extends MatchableItem>(target: MatchableItem, candidates: T[] | null | undefined): RankedCandidate<T>[] {
  const tPrice = Number(target.price) || 0;
  const A = analyse(target);
  const rows = (candidates || []).map((candidate, index) => ({
    index,
    size: sizeDistance(target, candidate),
    ranked: { candidate, ...scoreAnalysed(A, analyse(candidate)) } as RankedCandidate<T>,
  }));
  rows.sort((a, b) =>
    b.ranked.score - a.ranked.score ||
    Number(b.ranked.candidate.inStock !== false) - Number(a.ranked.candidate.inStock !== false) ||
    a.size - b.size ||
    Math.abs((Number(a.ranked.candidate.price) || 0) - tPrice) - Math.abs((Number(b.ranked.candidate.price) || 0) - tPrice) ||
    a.index - b.index);
  return rows.map(r => r.ranked);
}

/**
 * Picks `target`'s twin among `candidates` and says how sure we are:
 * - 'auto': score >= 0.85, pack size within 10%, nothing unexplained, and at
 *   least 0.1 ahead of the next different listing. Safe to link silently.
 * - 'suggest': score 0.60-0.85, or a capped/ambiguous top pick. Show it with
 *   its reasons and let the user confirm.
 * - 'none': nothing scores 0.60.
 */
export function decideMatch<T extends MatchableItem>(
  target: MatchableItem,
  candidates: T[] | null | undefined,
  opts: DecideOptions = {},
): MatchDecision<T> {
  const autoMin = opts.autoMin ?? AUTO_MIN;
  const suggestMin = opts.suggestMin ?? SUGGEST_MIN;
  const marginMin = opts.margin ?? AUTO_MARGIN;
  const ranked = rankCandidates(target, candidates);
  const viable = ranked.filter(r => !r.rejected && r.score > 0);
  const top = viable[0];
  if (!top || top.score < suggestMin) {
    return {
      band: 'none',
      best: null,
      alternatives: viable.slice(0, 3),
      ranked,
      reasons: top ? [`closest is ${Math.round(top.score * 100)}%`, ...top.reasons] : ['no similar product'],
    };
  }
  const runnerUp = viable.slice(1).find(r => !equivalent(top, r));
  const margin = top.score - (runnerUp?.score ?? 0);
  const reasons = [...top.reasons];
  let band: MatchBand = 'suggest';
  if (top.score >= autoMin && top.autoEligible && margin >= marginMin) band = 'auto';
  else if (runnerUp && margin < marginMin) reasons.push(`close runner-up: ${itemName(runnerUp.candidate)} ${itemUnit(runnerUp.candidate)}`.trim());
  if (band === 'suggest' && !reasons.length) reasons.push(`${Math.round(top.score * 100)}% match`);
  return { band, best: top, alternatives: viable.filter(r => r !== top).slice(0, 3), ranked, reasons };
}

// ---------- Legacy picker ----------

interface BestMatch<T extends MatchableItem> {
  candidate: T;
  score: number;
  // True when the runner-up scored within AMBIGUOUS_MARGIN of the winner and
  // the callers may want the user to confirm the pick.
  ambiguous: boolean;
}

/** Highest-scoring candidate at or above MATCH_THRESHOLD (no banding). */
export function pickBestMatch<T extends MatchableItem>(target: MatchableItem, candidates: T[] | null | undefined): BestMatch<T> | null {
  const ranked = rankCandidates(target, candidates);
  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return null;
  const runnerUp = ranked[1]?.score ?? 0;
  return { candidate: best.candidate, score: best.score, ambiguous: best.score - runnerUp <= AMBIGUOUS_MARGIN && runnerUp >= MATCH_THRESHOLD };
}

// ---------- Search ladder ----------

const DESCRIPTOR_WORDS = new Set(['premium', 'pure', 'shudh', 'natural', 'classic', 'original', 'regular', 'new',
  'improved', 'best', 'quality', 'special', 'superior', 'daily', 'value', 'standard', 'family', 'healthy', 'tasty',
  'delicious', 'instant', 'ready', 'packed', 'hygienically', 'hygienic', 'iodised', 'iodized', 'vacuum', 'evaporated',
  'pasteurised', 'pasteurized', 'homogenised', 'homogenized', 'india', 'indian', 'loose', 'farm', 'rich', 'taste']);

/**
 * Searches to try, most specific first: the full title; the title without
 * sizes, brackets and descriptors; brand + first two product words; the head
 * noun. Duplicates dropped.
 */
export function buildQueryLadder(title: string | undefined): string[] {
  const full = String(title || '').trim();
  const body = stripAllSizes(full).replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const ws = body.split(/[^a-z0-9]+/).filter(Boolean)
    .filter(w => !STOP_NORM.has(w) && !STOP_NORM.has(normalizeWord(w)));
  const plain = ws.filter(w => !DESCRIPTOR_WORDS.has(w));

  // Brand words: a known brand as one word or as two/three adjacent words.
  const brandIdx = new Set<number>();
  for (let i = 0; i < plain.length; i++) {
    for (const n of [3, 2, 1]) {
      const joined = n === 1 ? normalizeWord(plain[i]) : plain.slice(i, i + n).join('');
      if (i + n <= plain.length && BRAND_PARENT.has(joined)) {
        for (let k = i; k < i + n; k++) brandIdx.add(k);
        break;
      }
    }
  }
  const brand = plain.filter((_, i) => brandIdx.has(i));
  const content = plain.filter((_, i) => !brandIdx.has(i));
  const head = content.length ? content[content.length - 1] : '';

  const rungs = [full, plain.join(' '), [...brand, ...content.slice(0, 2)].join(' '), head];
  const seen = new Set<string>();
  return rungs.filter(q => {
    const k = foldText(q).replace(/[^a-z0-9]+/g, ' ').trim();
    if (k.length < 2 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
