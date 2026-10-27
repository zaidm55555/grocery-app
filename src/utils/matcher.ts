// Cross-store product matcher.
//
// Two layers:
//  - `scoreMatch` / `decideMatch`: the ranking used to link a listing on one
//    store to its twin on another. Titles are normalised (accents, apostrophes,
//    Hindi/English synonyms, sizes stripped), then scored on brand, name overlap,
//    variant words, pack size, unit price and stock, with hard rejects for things
//    that can never be the same product (Zero vs regular, different product
//    words, weight vs volume...). Brand is a soft factor here (ALLOW_CROSS_BRAND):
//    another brand's listing of the same product type, at the same size and a
//    close unit price, may link, always with a 'different brand (X → Y)'
//    reason, and a same-brand listing always outranks it. `decideMatch` turns
//    the scores into a band:
//    'auto' (safe to link without asking), 'suggest' (show it, user confirms) or
//    'none'.
//  - `isSameProduct`: a strict identity check (wording differences only, same
//    pack size) used to re-find a stored listing in its own store's results.
//    It never crosses brands.
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
/**
 * Cross-store twins may be another brand's listing of the same product (the
 * user's call: "a different brand is fine as long as the other things match").
 * false restores the old hard reject on a different brand everywhere.
 */
export const ALLOW_CROSS_BRAND = true;
/**
 * A twin whose brand differs (or is only on one listing) auto-links only when
 * its unit price is within this fraction of the target's; beyond it, suggest.
 */
export const CROSS_BRAND_PRICE_TOLERANCE = 0.3;

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
  // Kannada names Blinkit/Instamart add in Bengaluru ("Onion (Eerulli)", "Toor Dal (Togari Bele)")
  eerulli: 'onion', erulli: 'onion', irulli: 'onion', bellulli: 'garlic', belluli: 'garlic',
  shunti: 'ginger', shunthi: 'ginger', menasinakayi: 'chili', menasinakai: 'chili', menasinkai: 'chili',
  kharada: 'chili', hasi: 'green', menasu: 'pepper', togari: 'toor', bele: 'dal', hesaru: 'moong',
  uddina: 'urad', uddu: 'urad', kadale: 'chana', kadalekai: 'groundnut', kadlekai: 'groundnut',
  sasive: 'mustard', saasive: 'mustard', kaalu: 'seed', jeerige: 'cumin', arshina: 'turmeric',
  arishina: 'turmeric', arisina: 'turmeric', pudi: 'powder', godihittu: 'atta', godi: 'wheat', hittu: 'flour',
  kothambari: 'dhaniya', kotthambari: 'dhaniya', soppu: 'leaf', karibevu: 'curryleaf', menthya: 'fenugreek',
  menthe: 'fenugreek', nimbe: 'lemon', hannu: 'fruit', gajjari: 'carrot', aloogadde: 'potato',
  alugadde: 'potato', bendekayi: 'okra', bendekai: 'okra', badanekayi: 'brinjal', badanekai: 'brinjal',
  southekayi: 'cucumber', sautekayi: 'cucumber', elekosu: 'cabbage', hookosu: 'cauliflower',
  mullangi: 'radish', sakkare: 'sugar', uppu: 'salt', akki: 'rice', avalakki: 'poha', tuppa: 'clarifiedbutter',
  mosaru: 'curd', haalu: 'milk', motte: 'egg', tengina: 'coconut', kobbari: 'coconut', dodda: 'large',
  hasiru: 'green', hasiri: 'green', kempu: 'red', bili: 'white',
  // "Nati" / "Desi" / "Country" / "Local" all name the native variety (vs hybrid)
  nati: 'desi', naati: 'desi', country: 'desi', local: 'desi', deshi: 'desi', naatu: 'desi',
  big: 'large', sambhar: 'sambar', organically: 'organic', khaalis: 'pure', khalis: 'pure',
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
  ['butter milk', 'buttermilk'], ['uncle chips', 'unclechipps'], ['kari menasu', 'blackpepper'],
  ['tooth paste', 'toothpaste'], ['hand wash', 'handwash'], ['dish wash', 'dishwash'], ['body wash', 'bodywash'],
  ['face wash', 'facewash'], ['corn flakes', 'cornflakes'], ['2 minute', 'minute'], ['two minute', 'minute'],
  ['hygienically packed', 'packed'], ['vacuum evaporated', 'iodised'], ['top load', 'topload'],
  ['front load', 'frontload'],
  ['coca cola', 'cocacola'], ['thums up', 'thumsup'], ['thumbs up', 'thumsup'], ['7 up', '7up'],
  ['mountain dew', 'mountaindew'], ['minute maid', 'minutemaid'], ['red bull', 'redbull'], ['red label', 'redlabel'],
  ['parle g', 'parleg'], ['dairy milk', 'dairymilk'], ['good day', 'goodday'], ['marie gold', 'mariegold'],
  ['nature fresh', 'naturefresh'],
];

// Phrases that fold a product-type word into its head ("Leaf Tea" -> "tea").
// Cross-store scoring uses them; the strict same-product check does not, so
// "Tata Tea Gold" and "Tata Tea Gold Leaf Tea" are not one listing there.
const DESCRIPTOR_PHRASES: [string, string][] = [
  ['potato chips', 'chip'], ['potato chip', 'chip'], ['leaf tea', 'tea'], ['coffee powder', 'coffee'],
  ['chocolate bar', 'bar'], ['dairy milk chocolate', 'dairymilk'], ['silk chocolate', 'silk'],
  ['energy drink', 'drink'], ['fruit drink', 'drink'], ['detergent powder', 'detergent'], ['washing powder', 'detergent'],
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
  ['hamdard'], ['bhagyalakshmi'], ['jk'], ['nectr'], ['nilgiris'], ['real', 'dabur'],
];

// Lines whose name is the whole title ("Coca-Cola", "Sprite"): with the brand
// set aside, the kind of product they are, so another brand's twin has words
// to agree (Coca-Cola ~ Thums Up) or differ (Sprite vs Fanta) on.
const BRAND_TYPES_RAW: [string, string][] = [
  ['coca cola', 'cola'], ['pepsi', 'cola'], ['thums up', 'cola'],
  ['sprite', 'lemonsoda'], ['7up', 'lemonsoda'], ['limca', 'lemonsoda'], ['fanta', 'orangesoda'], ['mirinda', 'orangesoda'],
  ['maaza', 'mangodrink'], ['frooti', 'mangodrink'], ['lays', 'potatochip'], ['uncle chipps', 'potatochip'],
  ['pringles', 'potatochip'], ['kurkure', 'cornpuff'], ['doritos', 'nachochip'], ['cornitos', 'nachochip'],
  ['bisleri', 'water'], ['kinley', 'water'], ['aquafina', 'water'], ['redbull', 'energydrink'],
  ['monster', 'energydrink'], ['sting', 'energydrink'],
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
  'disinfectant', 'bathing', 'soap', 'powder', 'edible', 'cooking', 'unpolished', 'grown',
]);
// "hybrid" (tomato) is the default variety on both apps, so it is descriptive.

// Origin / growing words: they say how a product was grown, never who made it,
// so a title leading with one has no brand there ("Desi Tomato", "Organic Ginger").
const ORIGIN = ['desi', 'organic', 'farm', 'homegrown', 'hydroponic'];
// Words that read as "desi" when the other title names the variety (desi / hybrid):
// "Indian Tomato" is the desi one, while "Indian Style Paneer" stays generic.
const ORIGIN_AS_DESI = ['indian', 'india'];

// One-sided presence of these means a different product ("Coca-Cola" vs "Coca-Cola Zero").
// Words that name a different kind of a staple ("Rock Salt", "Soy Milk",
// "Cocoa Butter", "Ice Tea", "Herbal Toothpaste"). Within one brand the usual
// extra-word cap applies; across brands one of these on one side only rejects.
const CROSS_KIND = [
  'rock', 'pink', 'sea', 'himalayan', 'sendha', 'black', 'lite', 'soya', 'oat', 'coconut', 'almond', 'cashew',
  'rice', 'flavour', 'powder', 'condensed', 'garlic', 'cocoa', 'shea', 'peanut', 'table',
  'ice', 'iced', 'herbal', 'green', 'masala', 'ginger', 'tulsi', 'lemon', 'kid', 'baby', 'sensitive', 'whitening',
  'charcoal', 'gel', 'multigrain', 'organic', 'sugarfree', 'brown',
];

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
  ['whole', 'seed', 'powder', 'crushed', 'split', 'flake', 'leaf', 'paste'],
  ['desi', 'hybrid'],
  ['soap', 'shampoo', 'conditioner', 'handwash', 'bodywash', 'facewash', 'toothpaste'],
];

// ---------- Normalisation ----------

function stem(t: string): string {
  if (t.length > 3 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('oes')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

// Kannada / Hindi words are romanised many ways ("Menasinakayi", "Menasinakaayi",
// "Menasinakai"): fold long vowels and the -kayi ending so the spellings meet.
// Used only to look up SYNONYMS, and only keys that are themselves romanised
// that way (long vowel or -kai), so "Good" never reaches "gud".
const translit = (t: string) => t.replace(/([aeiou])\1+/g, (_m, v: string) => (v === 'e' ? 'i' : v === 'o' ? 'u' : v))
  .replace(/kayi$/, 'kai');
const TRANSLIT_SYNONYMS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const clash = new Set<string>();
  for (const [k, v] of Object.entries(SYNONYMS)) {
    const f = translit(k);
    if (f === k && !k.endsWith('kai')) continue;
    if (out[f] !== undefined && out[f] !== v) clash.add(f);
    else out[f] = v;
  }
  clash.forEach(f => delete out[f]);
  return out;
})();

function normalizeWord(t: string): string {
  if (SYNONYMS[t]) return SYNONYMS[t];
  const s = stem(t);
  if (SYNONYMS[s]) return SYNONYMS[s];
  const f = translit(t);
  return (f !== t && TRANSLIT_SYNONYMS[f]) || s;
}

const words = (s: string) => s.split(/[^a-z0-9]+/).filter(Boolean);

// Phrase table keyed by the normalised words, longest first.
const PHRASE_TABLE: { from: string[]; to: string; descriptor?: boolean }[] = [
  ...PHRASES.map(([from, to]) => ({ from: words(from).map(normalizeWord), to })),
  ...DESCRIPTOR_PHRASES.map(([from, to]) => ({ from: words(from).map(normalizeWord), to, descriptor: true })),
  ...BRANDS.map(([b]) => words(b)).filter(w => w.length > 1).map(w => ({ from: w.map(normalizeWord), to: w.join('') })),
].sort((a, b) => b.from.length - a.from.length);

// Phrase outputs are canonical already (only synonym-mapped, never stemmed).
// `strict` leaves descriptor phrases unjoined.
function joinPhrases(list: string[], strict = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length;) {
    const hit = PHRASE_TABLE.find(p => !(strict && p.descriptor) && p.from.every((w, k) => list[i + k] === w));
    if (hit) { out.push(SYNONYMS[hit.to] || hit.to); i += hit.from.length; } else { out.push(list[i]); i++; }
  }
  return out;
}

// Normalised tokens of a phrase (already folded or not), stopwords included.
const phraseTokens = (text: string, strict = false) => joinPhrases(words(text).map(normalizeWord), strict);
const rawTokens = (str: string | undefined, strict = false) => phraseTokens(stripAllSizes(str), strict);

const norm = (list: Iterable<string>) => new Set([...list].map(normalizeWord));
const STOP_NORM = new Set([...STOPWORDS, ...norm(STOPWORDS)]);
const GENERIC_NORM = new Set([...GENERIC, ...norm(GENERIC)]);
const HARD_NORM = new Set([...HARD_QUALIFIERS, ...norm(HARD_QUALIFIERS)]);
const CROSS_KIND_NORM = new Set([...CROSS_KIND, ...norm(CROSS_KIND)]);
const CONFLICT_GROUPS = CONFLICT_GROUPS_RAW.map(g => [...new Set(g.map(normalizeWord))]);
const ORIGIN_NORM = new Set([...ORIGIN, ...norm(ORIGIN)]);
const ORIGIN_AS_DESI_NORM = new Set([...ORIGIN_AS_DESI, ...norm(ORIGIN_AS_DESI)]);
const DESI = normalizeWord('desi');
const VARIETY_GROUP = CONFLICT_GROUPS.find(g => g.includes(DESI))!;
/** A leading word that describes the product (generic or origin) rather than naming a brand. */
const isDescriptorLead = (t: string) => GENERIC_NORM.has(t) || ORIGIN_NORM.has(t);

// Brand token = what the brand name itself tokenises to, so it lines up with titles.
const brandToken = (b: string) => rawTokens(b).join('');
const BRAND_PARENT = new Map<string, string | null>();
BRANDS.forEach(([b, parent]) => BRAND_PARENT.set(brandToken(b), parent ? brandToken(parent) : null));
const BRAND_TYPES = new Map(BRAND_TYPES_RAW.map(([b, type]) => [brandToken(b), type]));
// How a brand token reads in a reason ("motherdairy" -> "Mother Dairy").
const BRAND_LABEL = new Map(BRANDS.map(([b]) => [brandToken(b), b.replace(/\b[a-z]/g, c => c.toUpperCase())]));

const dedupe = (list: string[]) => list.filter((t, i) => !STOP_NORM.has(t) && list.indexOf(t) === i);

// Ordered, normalised, stopword-free tokens of a title with its sizes removed
// (order kept so the leading token, usually the brand, can be weighted).
// Every word counts, brackets included; see parseTitle for the scoring view.
export function nameTokens(str: string | undefined, strict = false): string[] {
  return dedupe(rawTokens(str, strict));
}

// ---------- Title structure: glosses and slash pairs ----------

// Words that always say which product it is, wherever they appear.
const SIGNAL = new Set([...HARD_NORM, ...CONFLICT_GROUPS.flat()]);
const BRACKET_RE = /[([{]([^()[\]{}]*)(?:[)\]}]|$)/g;
// Clause breaks: a spaced dash ("Tomato - Hybrid"), comma, semicolon, pipe, colon.
const CLAUSE_RE = /\s[-–—]\s|[,;|:]/;

export interface TitleParts {
  /** What the title says the product is: ordered, normalised, stopword-free. */
  tokens: string[];
  /**
   * Help-only words: a bracket that restates the product in another language
   * ("Onion (Eerulli)", "Toor Dal (Togari Bele)"). They count when the other
   * title has them and are ignored when it does not.
   */
  aliases: string[];
  /**
   * Slash pairs ("Sabja/ Basil Seeds"): [left words, right words] naming the
   * same thing two ways. Both sides are in `tokens`; when comparing, the side
   * the other title does not use becomes an alias.
   */
  alts: [string[], string[]][];
  /**
   * Unknown words that appear only inside the title's trailing bracket(s) and
   * are not brands or variant words ("Green Chilli (Hasiru Menasinakaayi)").
   * Present only when non-empty.
   */
  bracketOnly?: string[];
}

// The words on each side of a slash that differ ("Sabja" / "Basil Seeds"), or
// null when one side only repeats the other ("Arhar Dal/ Toor Dal"). The left
// side stops at a brand, a hard qualifier or the title's first word (probably
// an unknown brand), so a slash can never make the brand optional.
function slashPair(left: string[], right: string[], before: string[]): [string[], string[]] | null {
  const inLeft = new Set(left), inRight = new Set(right);
  const rightAlt = right.filter(t => !inLeft.has(t) && !before.includes(t) && !HARD_NORM.has(t) && !BRAND_PARENT.has(t));
  let i = left.length - 1;
  while (i >= 0 && inRight.has(left[i])) i--; // shared head noun: "Cumin Seeds / Jeera Seeds"
  const leftAlt: string[] = [];
  const firstWord = before.length > 1 ? before[0] : null;
  while (i >= 0 && leftAlt.length < 2 && !inRight.has(left[i]) && !BRAND_PARENT.has(left[i]) &&
    !HARD_NORM.has(left[i]) && left[i] !== firstWord) {
    leftAlt.unshift(left[i]);
    i--;
  }
  return leftAlt.length && rightAlt.length ? [leftAlt, rightAlt] : null;
}

/**
 * Splits a title into the words that identify the product, gloss words that can
 * only help, and slash alternatives. A bracket is a gloss when it shares a word
 * with the rest of the title after synonyms ("Green Chilli (Menasinakayi)");
 * otherwise ("(Fruit & Nut)", "(Bubbly)") it is part of the name. Hard
 * qualifiers, variant words and brands always count, gloss or not.
 */
export function parseTitle(str: string | undefined): TitleParts {
  const glosses: { inner: string; trailing: boolean }[] = [];
  const body = stripAllSizes(str).replace(BRACKET_RE, (m: string, inner: string, at: number, whole: string) => {
    const rest = whole.slice(at + m.length).replace(BRACKET_RE, '').replace(/[^a-z0-9]/gi, '');
    glosses.push({ inner, trailing: rest === '' });
    return ' | ';
  });
  const tokens: string[] = [];
  const add = (t: string) => { if (!STOP_NORM.has(t) && !tokens.includes(t)) tokens.push(t); };
  const alts: [string[], string[]][] = [];
  for (const clause of body.split(CLAUSE_RE)) {
    const sides = clause.split('/').map(side => dedupe(phraseTokens(side)));
    sides[0].forEach(add);
    for (let k = 1; k < sides.length; k++) {
      const pair = slashPair(sides[k - 1], sides[k], [...tokens]);
      if (pair) alts.push(pair);
      sides[k].forEach(add);
    }
  }
  const aliases: string[] = [];
  const bracketOnly: string[] = [];
  for (const { inner, trailing } of glosses) {
    const inside = dedupe(phraseTokens(inner));
    const gloss = inside.some(t => tokens.includes(t));
    for (const t of inside) {
      if (tokens.includes(t) || aliases.includes(t)) continue;
      const plain = !SIGNAL.has(t) && !BRAND_PARENT.has(t);
      if (gloss && plain) aliases.push(t);
      else {
        tokens.push(t);
        if (trailing && plain && !GENERIC_NORM.has(t)) bracketOnly.push(t);
      }
    }
  }
  return { tokens, aliases, alts, ...(bracketOnly.length ? { bracketOnly } : {}) };
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
// similarity behind isSameProduct. Every word counts (brackets too) and
// descriptor phrases stay unjoined. The leading token (usually the brand)
// counts extra; conflicting variant words zero the score.
export function nameSimilarity(a: string | undefined, b: string | undefined): number {
  const la = nameTokens(a, true);
  const lb = nameTokens(b, true);
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

interface Analysed extends TitleParts {
  brands: string[];
  distinctive: Set<string>;
  qty: ParsedQuantity | null;
  price: number;
  inStock: boolean;
}

type AnalysedBase = Omit<Analysed, 'tokens' | 'brands' | 'distinctive'>;

// Umbrella brands (no parent) are compared as brands only; product-line brands
// ("Maggi", "Good Day") also stay in the name, since they say which product it is.
const isUmbrella = (t: string) => BRAND_PARENT.has(t) && !BRAND_PARENT.get(t);

function analyse(item: MatchableItem): Analysed {
  const { tokens, aliases, alts, bracketOnly } = parseTitle(itemName(item));
  return withTokens(tokens, { aliases, alts, bracketOnly, qty: quantityOf(item), price: Number(item.price) || 0, inStock: item.inStock !== false });
}

function withTokens(tokens: string[], base: AnalysedBase): Analysed {
  const brands = tokens.filter(t => BRAND_PARENT.has(t));
  // "Brooke Bond Red Label": the parent mention adds nothing once the line is named.
  const parentMention = (t: string) => brands.some(b => b !== t && ancestors(b).includes(t));
  const distinctive = new Set(tokens.filter(t =>
    !isUmbrella(t) && !parentMention(t) && !GENERIC_NORM.has(t) && !/^\d+$/.test(t)));
  return { ...base, tokens, brands, distinctive };
}

const allWords = (x: Analysed) => new Set([...x.tokens, ...x.aliases]);

// Reads `x` the way `other` is written: of each slash pair, the side `other`
// does not use becomes an alias ("Sabja/ Basil Seeds" vs "Basil Seeds"), and
// alias words that `other` does use count as shared words.
function readAgainst(x: Analysed, other: Set<string>): Analysed {
  const dropped = new Set<string>();
  for (const [left, right] of x.alts) {
    const cover = (side: string[]) => side.filter(t => other.has(t)).length / side.length;
    const l = cover(left), r = cover(right);
    if (l === 1 && r === 1) continue;
    (l > r ? right : left).forEach(t => dropped.add(t));
  }
  const aliases = [...x.aliases, ...dropped];
  const tokens = x.tokens.filter(t => !dropped.has(t));
  aliases.forEach(t => { if (other.has(t) && !tokens.includes(t)) tokens.push(t); });
  if (!dropped.size && tokens.length === x.tokens.length) return x;
  return withTokens(tokens, { ...x, aliases: aliases.filter(t => !tokens.includes(t)), alts: [] });
}

// "Indian Tomato" vs "Desi Tomato" / "Tomato Hybrid": when the other title names
// the variety, "Indian" is the desi one. Otherwise it stays a generic word.
function readOrigin(x: Analysed, other: Set<string>): Analysed {
  const all = [...x.tokens, ...x.aliases];
  if (!VARIETY_GROUP.some(t => other.has(t)) || all.includes(DESI) || !all.some(t => ORIGIN_AS_DESI_NORM.has(t))) return x;
  const swap = (list: string[]) => [...new Set(list.map(t => (ORIGIN_AS_DESI_NORM.has(t) ? DESI : t)))];
  return withTokens(swap(x.tokens), { ...x, aliases: swap(x.aliases) });
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
    return changed ? withTokens(out, x) : x;
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
const brandName = (t: string) => BRAND_LABEL.get(t) ?? pretty(t);

// `x` with its brand set aside: the leading run of known brands (and their
// parents) goes, or `lead` (an unknown word in the brand's place), and a line
// that is its own product ("Coca-Cola") leaves the kind of product it is.
function withoutBrand(x: Analysed, lead?: string): Analysed {
  let i = 0;
  while (i < x.tokens.length && BRAND_PARENT.has(x.tokens[i])) i++;
  const run = i ? x.tokens.slice(0, i) : x.brands.slice(0, 1);
  const drop = new Set(run.flatMap(ancestors));
  if (lead) drop.add(lead);
  const implied = run.map(b => BRAND_TYPES.get(b)).filter((t): t is string => !!t);
  return withTokens(dedupe([...x.tokens.filter(t => !drop.has(t)), ...implied]), x);
}

/**
 * How the two brands compare: 'same' (they agree, or neither title names one),
 * 'one-sided' (only one listing names a brand), 'unverified' (a known brand
 * against an unknown leading word, probably another brand) or 'different'.
 */
export type BrandRelation = 'same' | 'one-sided' | 'unverified' | 'different';
// Brand agreement rank: a lower tier always beats a higher one on equal footing.
const BRAND_TIER: Record<BrandRelation, number> = { same: 0, 'one-sided': 1, unverified: 1, different: 2 };

export interface ScoreOptions {
  /** Let another brand's listing be the twin (default ALLOW_CROSS_BRAND). */
  crossBrand?: boolean;
}

export interface MatchDetail {
  /** 0..1; 0 when rejected. */
  score: number;
  /** Can never be the same product (variant, product words, weight vs volume...). */
  rejected: boolean;
  brandRelation: BrandRelation;
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
export function scoreMatch(target: MatchableItem, candidate: MatchableItem, opts: ScoreOptions = {}): MatchDetail {
  return scoreAnalysed(analyse(target), analyse(candidate), opts.crossBrand ?? ALLOW_CROSS_BRAND);
}

// Unit price within this ratio corroborates that a bracket is only a gloss.
const GLOSS_PRICE_RATIO = 1.15;

// Every extra word sits in the trailing bracket of an unbranded title, the other
// title is fully covered, and the exact pack size and unit price agree. Branded
// titles never qualify: a bracket there names a sub-line ("Dairy Milk (Fruit &
// Nut)") priced like its parent, so price cannot tell them apart.
function bracketGloss(A: Analysed, B: Analysed, extras: string[]): boolean {
  const side = A.distinctive.has(extras[0]) ? A : B;
  if (A.brands.length || B.brands.length || !A.inStock || !B.inStock) return false;
  if (!extras.every(t => side.bracketOnly?.includes(t))) return false;
  const cmp = compareQuantity(A.qty, B.qty);
  if (cmp.status !== 'same' || !cmp.a || !cmp.b || !A.price || !B.price) return false;
  const ua = A.price / cmp.a, ub = B.price / cmp.b;
  return Math.max(ua, ub) / Math.min(ua, ub) <= GLOSS_PRICE_RATIO;
}

function scoreAnalysed(rawA: Analysed, rawB: Analysed, crossBrand: boolean): MatchDetail {
  const [oA, oB] = [readOrigin(rawA, allWords(rawB)), readOrigin(rawB, allWords(rawA))];
  const [A, B] = joinCompounds(readAgainst(oA, allWords(oB)), readAgainst(oB, allWords(oA)));
  const parts = { brand: 0, name: 0, variant: 0, size: 0, price: 0, stock: 0 };
  const reasons: string[] = [];
  let capped = false;
  let brandRelation: BrandRelation = 'same';
  const reject = (why: string): MatchDetail => ({ score: 0, rejected: true, autoEligible: false, brandRelation, reasons: [why, ...reasons], parts });

  if (!A.tokens.length || !B.tokens.length) return reject('no name to compare');
  const setA = new Set(A.tokens), setB = new Set(B.tokens);

  // Brand. Across brands (crossBrand) the product words are compared with the
  // brands set aside (NA / NB), and auto needs every other signal to agree:
  // pack size within 10%, unit price within CROSS_BRAND_PRICE_TOLERANCE, in stock.
  let nameMult = 1;
  let NA = A, NB = B;
  let priceGate = 0; // > 0: the unit-price ratio auto needs
  let brandNote = ''; // shown first: the user must see a brand swap
  if (A.brands.length && B.brands.length) {
    if (!brandsAgree(A.brands, B.brands)) {
      if (!crossBrand) return reject(`different brand (${pretty(A.brands[0])} vs ${pretty(B.brands[0])})`);
      brandRelation = 'different';
      brandNote = `different brand (${brandName(A.brands[0])} → ${brandName(B.brands[0])})`;
      reasons.push(brandNote);
      parts.brand = 0.3;
      [NA, NB] = [withoutBrand(A), withoutBrand(B)];
      priceGate = 1 + CROSS_BRAND_PRICE_TOLERANCE;
      if (!NA.tokens.length || !NB.tokens.length) return reject(`${brandNote}: no product words to compare`);
    } else {
      parts.brand = 1;
    }
  } else if (A.brands.length || B.brands.length) {
    const [branded, bare] = A.brands.length ? [setA, B.tokens] : [setB, A.tokens];
    parts.brand = 0.4;
    if (bare.length > 1 && !branded.has(bare[0]) && !isDescriptorLead(bare[0])) {
      brandRelation = 'unverified';
      brandNote = `brand may differ (${pretty(bare[0])} vs ${crossBrand ? brandName(A.brands[0] || B.brands[0]) : pretty(A.brands[0] || B.brands[0])})`;
      reasons.push(brandNote);
      // An unknown leading word may be another brand, but just as often it says
      // which kind of product it is ("Rock Salt", "Soy Milk", "Ice Tea"), so it
      // is never set aside: at most a suggestion. Real brands go in BRANDS.
      nameMult = 0.6;
      capped = true;
    } else {
      brandRelation = 'one-sided';
      reasons.push(A.brands.length ? 'no brand on this listing' : `brand only on this listing (${crossBrand ? brandName(B.brands[0]) : pretty(B.brands[0])})`);
      if (crossBrand) {
        [NA, NB] = [withoutBrand(A), withoutBrand(B)];
        priceGate = 1 + CROSS_BRAND_PRICE_TOLERANCE;
        if (!NA.tokens.length || !NB.tokens.length) return reject('no product words to compare');
      } else {
        capped = true;
      }
    }
  } else if (A.tokens[0] === B.tokens[0]) {
    parts.brand = 0.8;
  } else if (A.tokens.length > 1 && B.tokens.length > 1 && !setB.has(A.tokens[0]) && !setA.has(B.tokens[0])
    && !GENERIC_NORM.has(A.tokens[0]) && !GENERIC_NORM.has(B.tokens[0])
    && (ORIGIN_NORM.has(A.tokens[0]) !== ORIGIN_NORM.has(B.tokens[0]))) {
    // An origin word against some other leading word ("Desi Ghee" vs "Cow Ghee"):
    // not a brand, but each title names a different kind of the product.
    parts.brand = 0.6;
    nameMult = 0.6;
    capped = true;
    reasons.push(`different kind (${pretty(A.tokens[0])} vs ${pretty(B.tokens[0])})`);
  } else if (A.tokens.length > 1 && B.tokens.length > 1 && !setB.has(A.tokens[0]) && !setA.has(B.tokens[0])
    && !isDescriptorLead(A.tokens[0]) && !isDescriptorLead(B.tokens[0])) {
    parts.brand = 0.2;
    nameMult = 0.6;
    capped = true;
    reasons.push(`brand may differ (${pretty(A.tokens[0])} vs ${pretty(B.tokens[0])})`);
  } else {
    parts.brand = 0.6;
  }

  // Variant words (gloss words included: they describe the product too)
  const wordsA = allWords(A), wordsB = allWords(B);
  const q = oneSidedQualifier(wordsA, wordsB);
  if (q) return reject(`"${q}" variant on one side only`);
  // Across brands, a kind-of-product word on one side only ("Rock Salt",
  // "Milk Powder", "Herbal Toothpaste") is another product, not a substitute.
  if (crossBrand && brandRelation !== 'same') {
    const kind = [...wordsA, ...wordsB].find(t => CROSS_KIND_NORM.has(t) && wordsA.has(t) !== wordsB.has(t));
    if (kind) return reject(`"${kind}" on one side only`);
  }
  const conflict = conflictingVariant(wordsA, wordsB);
  if (conflict) return reject(`different variant (${conflict[0]} vs ${conflict[1]})`);

  // Name overlap on the distinctive words (brand and descriptors excluded)
  const DA = NA.distinctive, DB = NB.distinctive;
  const shared = [...DA].filter(t => DB.has(t));
  const onlyA = [...DA].filter(t => !DB.has(t));
  const onlyB = [...DB].filter(t => !DA.has(t));
  let name: number;
  if (DA.size && DB.size && !shared.length) return reject('different product');
  // Another brand whose title has product words only on one side ("Amul Butter"
  // vs "Maggi Noodles"): nothing says it is the same kind of product.
  if (brandRelation === 'different' && !DA.size !== !DB.size) return reject('different product');
  if (onlyA.length && onlyB.length) {
    name = (shared.length / Math.min(DA.size, DB.size)) * 0.5;
    parts.variant = 0.2;
    reasons.push(`different words (${onlyA.join(' ')} vs ${onlyB.join(' ')})`);
  } else if ((onlyA.length || onlyB.length) && bracketGloss(A, B, onlyA.length ? onlyA : onlyB)) {
    // "Green Chilli (Hasiru Menasinakaayi)" vs "Green Chilli": unknown words only
    // in an unbranded title's trailing bracket, with the exact pack and unit price
    // agreeing, read as a translation rather than a different product.
    name = 1;
    parts.variant = 1;
    reasons.push(`bracket read as a translation (${(onlyA.length ? onlyA : onlyB).join(' ')}): same size and price`);
  } else if (onlyA.length || onlyB.length) {
    const extras = onlyA.length ? onlyA : onlyB;
    name = 1 - Math.min(0.5, 0.25 * extras.length);
    parts.variant = 0.3;
    capped = true;
    reasons.push(onlyB.length ? `extra words here: ${onlyB.join(', ')}` : `missing words: ${onlyA.join(', ')}`);
  } else {
    const anyShared = NA.tokens.some(t => NB.tokens.includes(t));
    name = DA.size || anyShared || brandsAgree(A.brands, B.brands) ? 1 : 0.5;
    parts.variant = 1;
    // Another brand with only a category word in common ("Soap", "Namkeen")
    // says nothing about which product it is.
    if (priceGate && !DA.size) {
      capped = true;
      reasons.push('only the product category matches');
    }
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
  // Across brands, a unit price we cannot compare cannot corroborate the twin.
  if (priceGate && !(A.price && B.price && cmp.ratio !== undefined && cmp.a && cmp.b)) capped = true;
  if (!A.price || !B.price) {
    parts.price = 0.6;
  } else if (cmp.ratio !== undefined && cmp.a && cmp.b) {
    const ua = A.price / cmp.a, ub = B.price / cmp.b;
    const r = Math.max(ua, ub) / Math.min(ua, ub);
    parts.price = priceCurve(r);
    if (r > 1.75 || (priceGate && r > priceGate)) {
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
  if (brandNote) reasons.unshift(...reasons.splice(reasons.indexOf(brandNote), 1));
  return { score, rejected: false, autoEligible: !capped, brandRelation, reasons, parts };
}

/** The brand reason to show with a link ('different brand (Tata → Aashirvaad)'), if the brands are not the same. */
export function brandNote(d: Pick<MatchDetail, 'brandRelation' | 'reasons'>): string | undefined {
  return d.brandRelation === 'same' ? undefined : d.reasons.find(r => /\bbrand\b/.test(r));
}

export function matchScore(target: MatchableItem, candidate: MatchableItem): number {
  return scoreMatch(target, candidate).score;
}

// Strict identity check (not a ranking): is `candidate` the same product as
// `target`, allowing only wording/spelling differences and ~equal pack size?
export function isSameProduct(target: MatchableItem, candidate: MatchableItem): boolean {
  if (compareQuantity(quantityOf(target), quantityOf(candidate)).status === 'conflict') return false;
  // Never across brands: this resolves a stored listing, not a substitute.
  if (scoreMatch(target, candidate, { crossBrand: false }).rejected) return false;
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

export interface DecideOptions extends ScoreOptions {
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

/**
 * Scores every candidate and sorts best first (ties: brand agreement, in stock,
 * closest size, closest price). Brand agreement is also in the score, so a
 * same-brand twin outranks another brand's otherwise equal listing.
 */
export function rankCandidates<T extends MatchableItem>(
  target: MatchableItem,
  candidates: T[] | null | undefined,
  opts: ScoreOptions = {},
): RankedCandidate<T>[] {
  const tPrice = Number(target.price) || 0;
  const A = analyse(target);
  const crossBrand = opts.crossBrand ?? ALLOW_CROSS_BRAND;
  const rows = (candidates || []).map((candidate, index) => ({
    index,
    size: sizeDistance(target, candidate),
    ranked: { candidate, ...scoreAnalysed(A, analyse(candidate), crossBrand) } as RankedCandidate<T>,
  }));
  rows.sort((a, b) =>
    b.ranked.score - a.ranked.score ||
    (crossBrand ? BRAND_TIER[a.ranked.brandRelation] - BRAND_TIER[b.ranked.brandRelation] : 0) ||
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
 *   Another brand can be 'auto' (its reasons say 'different brand (X → Y)'),
 *   but only when no listing of a closer brand is a plausible pick, and a
 *   listing of a farther brand never blocks a closer-brand pick.
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
  const ranked = rankCandidates(target, candidates, opts);
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
  // Brand tiers only apply across brands; crossBrand: false is the old strict path.
  const crossBrand = opts.crossBrand ?? ALLOW_CROSS_BRAND;
  const tier = BRAND_TIER[top.brandRelation];
  const runnerUp = viable.slice(1).find(r => !equivalent(top, r) && (!crossBrand || BRAND_TIER[r.brandRelation] <= tier));
  // e.g. Aashirvaad Salt 1 kg on top while Tata Salt 500 g is listed: let the user choose.
  const closerBrand = crossBrand ? viable.find(r => BRAND_TIER[r.brandRelation] < tier && r.score >= suggestMin) : undefined;
  const margin = top.score - (runnerUp?.score ?? 0);
  const reasons = [...top.reasons];
  let band: MatchBand = 'suggest';
  if (top.score >= autoMin && top.autoEligible && margin >= marginMin && !closerBrand) band = 'auto';
  else if (closerBrand) reasons.push(`${top.brandRelation === 'different' && closerBrand.brandRelation === 'same' ? 'same brand' : 'also'} listed: ${itemName(closerBrand.candidate)} ${itemUnit(closerBrand.candidate)}`.trim());
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
export function pickBestMatch<T extends MatchableItem>(
  target: MatchableItem,
  candidates: T[] | null | undefined,
  opts: ScoreOptions = {},
): BestMatch<T> | null {
  const ranked = rankCandidates(target, candidates, opts);
  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return null;
  const runnerUp = ranked[1]?.score ?? 0;
  return { candidate: best.candidate, score: best.score, ambiguous: best.score - runnerUp <= AMBIGUOUS_MARGIN && runnerUp >= MATCH_THRESHOLD };
}

// ---------- Search ladder ----------

const DESCRIPTOR_WORDS = new Set(['premium', 'pure', 'shudh', 'natural', 'classic', 'original', 'regular', 'new',
  'improved', 'best', 'quality', 'special', 'superior', 'daily', 'value', 'standard', 'family', 'healthy', 'tasty',
  'delicious', 'instant', 'ready', 'packed', 'hygienically', 'hygienic', 'iodised', 'iodized', 'vacuum', 'evaporated',
  'pasteurised', 'pasteurized', 'homogenised', 'homogenized', 'india', 'indian', 'loose', 'farm', 'rich', 'taste',
  'unpolished']);

/**
 * Searches to try, most specific first: the full title; the title without
 * sizes, brackets, descriptors and repeated words ("Arhar Dal/ Toor Dal");
 * brand + first two product words; the head noun. Duplicates dropped.
 */
export function buildQueryLadder(title: string | undefined): string[] {
  const full = String(title || '').trim();
  const body = stripAllSizes(full).replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const ws = body.split(/[^a-z0-9]+/).filter(Boolean)
    .filter(w => !STOP_NORM.has(w) && !STOP_NORM.has(normalizeWord(w)))
    .filter((w, i, all) => all.findIndex(o => normalizeWord(o) === normalizeWord(w)) === i);
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
