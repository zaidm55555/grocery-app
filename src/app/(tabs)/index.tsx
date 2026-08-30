import React, { useState, useEffect, useCallback, useRef } from 'react';
import { StyleSheet, View, Text, TextInput, FlatList, TouchableOpacity, ActivityIndicator, Image, Keyboard, KeyboardAvoidingView, Platform as RNPlatform, Pressable, ScrollView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Search, MapPin, X, Plus, Minus, ChevronDown, Check, Zap, ShoppingCart, ShoppingBag } from 'lucide-react-native';
import { api, UnifiedProduct, PlatformVariant } from '../../services/api';
import { storage, Platform, LocationData } from '../../services/storage';
import { colors, fonts, platformThemes, PLATFORM_ORDER } from '../../constants/theme';
import { liveKey, familyKey } from '../../utils/productKey';
import { pickBestMatch } from '../../utils/matcher';
import MatchModal, { MatchFlowState, MatchTarget, MatchCell } from '../../components/MatchModal';
import VariantPickerModal from '../../components/VariantPickerModal';

const QUICK_SEARCHES = ['Milk', 'Bread', 'Eggs', 'Butter', 'Cheese'];
type StoreFilter = 'all' | Platform;

export function LogoTile({ platform, size = 30 }: { platform: Platform; size?: number }) {
  const t = platformThemes[platform];
  return (
    <View style={[styles.logoTile, {
      width: size,
      height: size,
      borderRadius: size * 0.28,
      backgroundColor: t.bgLight,
      borderColor: t.borderColor,
    }]}>
      <Text style={[styles.logoLetter, { color: t.color, fontSize: size * 0.5 }]}>{t.name[0]}</Text>
    </View>
  );
}

export default function SearchScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [products, setProducts] = useState<UnifiedProduct[]>([]);
  const [pendingPlatforms, setPendingPlatforms] = useState<Platform[]>([]);
  const [location, setLocation] = useState<LocationData | null>(null);
  const [cartItems, setCartItems] = useState<{ product: UnifiedProduct; quantity: number }[]>([]);
  const [storeFilter, setStoreFilter] = useState<StoreFilter>('all');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [matchFlow, setMatchFlow] = useState<MatchFlowState | null>(null);
  const [variantBase, setVariantBase] = useState<UnifiedProduct | null>(null);
  const [matchToast, setMatchToast] = useState<{ platform: Platform; name: string } | null>(null);

  const matchFlowRef = useRef<MatchFlowState | null>(null);
  matchFlowRef.current = matchFlow;
  const cartItemsRef = useRef(cartItems);
  cartItemsRef.current = cartItems;

  useEffect(() => {
    if (!matchToast) return;
    const timer = setTimeout(() => setMatchToast(null), 5000);
    return () => clearTimeout(timer);
  }, [matchToast]);

  const loadInitialData = async () => {
    const userLoc = await storage.getLocation();
    setLocation(userLoc);
    const cart = await storage.getCart();
    setCartItems(cart);
  };

  useFocusEffect(
    useCallback(() => {
      loadInitialData();
    }, [])
  );

  const performSearch = async (searchTerm: string) => {
    if (!searchTerm.trim()) return;
    Keyboard.dismiss();
    setLoading(true);
    setProducts([]);
    setPendingPlatforms(PLATFORM_ORDER);
    try {
      // Each platform's results stream in as soon as they arrive
      await api.search(searchTerm, (platform, results) => {
        setProducts(prev => [...prev, ...results]);
        setPendingPlatforms(prev => prev.filter(p => p !== platform));
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setPendingPlatforms([]);
    }
  };

  const handleClear = () => {
    setQuery('');
    setProducts([]);
  };

  const handleQuickSearch = (term: string) => {
    setQuery(term);
    performSearch(term);
  };

  // ---------- Auto-match engine ----------

  const toVariant = (p: UnifiedProduct): PlatformVariant => ({
    id: p.id,
    title: p.title,
    brand: p.brand,
    quantity: p.quantity,
    price: p.price,
    originalPrice: p.originalPrice,
    imageUrl: p.imageUrl,
    originalId: p.originalId,
    productId: p.productId,
    spinId: p.spinId,
    storeId: p.storeId,
  });

  const runCellSearch = useCallback(async (tid: string, target: MatchTarget, pid: Platform) => {
    const setCell = (cell: Partial<MatchCell>) => {
      setMatchFlow(prev => {
        if (!prev) return prev;
        const targetCells = prev.results[tid] || {};
        const next: MatchFlowState = {
          ...prev,
          results: {
            ...prev.results,
            [tid]: { ...targetCells, [pid]: { status: 'pending', candidates: [], best: null, score: null, ...targetCells[pid], ...cell } as MatchCell }
          }
        };
        // Once every cell is terminal, move to the confirm step so the
        // Skip / Confirm footer appears.
        if (next.step === 'searching') {
          const allTerminal = next.targets.every(t =>
            next.otherPlatforms.every(pl => {
              const c = next.results[t.id]?.[pl];
              return !!c && c.status !== 'pending';
            })
          );
          if (allTerminal && next.targets.length > 0) next.step = 'candidates';
        }
        return next;
      });
    };

    setCell({ status: 'pending', candidates: [], best: null, score: null });
    try {
      const results = await api.searchSingle(pid, target.name);
      const best = pickBestMatch<UnifiedProduct>({ name: target.name, unit: target.unit, price: target.price }, results);
      setCell({
        status: best ? 'ok' : 'empty',
        candidates: results.slice(0, 12),
        best: best?.candidate || null,
        score: best?.score ?? null,
      });
    } catch (e: any) {
      setCell({ status: 'error', error: String(e?.message || e) });
    }
  }, []);

  const startTargetSearches = useCallback((target: MatchTarget, others: Platform[]) => {
    setMatchFlow(prev => {
      if (!prev) return prev;
      const cells: Partial<Record<Platform, MatchCell>> = {};
      others.forEach(pid => { cells[pid] = { status: 'pending', candidates: [], best: null, score: null }; });
      return {
        ...prev,
        step: 'searching',
        targets: prev.targets.some(t => t.id === target.id) ? prev.targets : [...prev.targets, target],
        results: { ...prev.results, [target.id]: cells },
        chosen: { ...prev.chosen, [target.id]: {} },
      };
    });
    others.forEach(pid => runCellSearch(target.id, target, pid));
  }, [runCellSearch]);

  const beginMatchFlow = useCallback(async (line: { product: UnifiedProduct; quantity: number }) => {
    const p = line.product;
    const candidates = PLATFORM_ORDER.filter(pl => pl !== p.platform && !p.platformPrices?.[pl]);
    if (candidates.length === 0) return;

    // Only auto-match apps that actually have a linked session — otherwise
    // every search would come back empty and always report "no match".
    const linkChecks = await Promise.all(candidates.map(async pl => [pl, !!(await storage.getToken(pl))] as const));
    const others = linkChecks.filter(([, linked]) => linked).map(([pl]) => pl);
    if (others.length === 0) return;

    const target: MatchTarget = {
      id: p.id,
      name: p.title,
      unit: p.quantity,
      price: p.price,
      mrp: p.originalPrice,
      image: p.imageUrl,
    };
    const existing = matchFlowRef.current;
    if (existing && existing.sourcePlatform === p.platform) {
      // Batch: merge into the open session (like the desktop optimizer)
      startTargetSearches(target, existing.otherPlatforms);
    } else {
      const flow: MatchFlowState = {
        step: 'searching',
        targets: [],
        sourcePlatform: p.platform,
        otherPlatforms: others,
        results: {},
        chosen: {},
      };
      setMatchFlow(flow);
      // let state land, then kick off searches which mutate via updater
      setTimeout(() => startTargetSearches(target, others), 0);
    }
  }, [startTargetSearches]);

  const handleChoose = (tid: string, pid: Platform, pick: { product: UnifiedProduct; score: number } | 'skip') => {
    setMatchFlow(prev => {
      if (!prev) return prev;
      return { ...prev, chosen: { ...prev.chosen, [tid]: { ...(prev.chosen[tid] || {}), [pid]: pick } } };
    });
  };

  const handleRetry = (tid: string, _pid: Platform) => {
    const flow = matchFlowRef.current;
    if (!flow) return;
    const target = flow.targets.find(t => t.id === tid);
    if (!target) return;
    runCellSearch(tid, target, _pid);
  };

  const handleSkipMatch = () => setMatchFlow(null);

  const handleConfirmMatch = async () => {
    const flow = matchFlowRef.current;
    if (!flow) return;
    const updates = new Map<string, Partial<Record<Platform, PlatformVariant>>>();
    let toastPlatform: Platform | null = null;
    let toastName = '';
    for (const t of flow.targets) {
      const chosenFor = flow.chosen[t.id] || {};
      const prices: Partial<Record<Platform, PlatformVariant>> = {};
      for (const pid of flow.otherPlatforms) {
        const pick = chosenFor[pid];
        if (pick === 'skip') continue;
        // Explicit pick wins; otherwise fall back to the auto-matched best.
        const product = typeof pick === 'object' ? pick.product : flow.results[t.id]?.[pid]?.best;
        if (product) {
          prices[pid] = toVariant(product);
          if (!toastPlatform) { toastPlatform = pid; toastName = t.name; }
        }
      }
      if (Object.keys(prices).length > 0) updates.set(t.id, prices);
    }
    const updatedCart = cartItemsRef.current.map(ci => {
      const prices = updates.get(ci.product.id);
      if (!prices) return ci;
      return { ...ci, product: { ...ci.product, platformPrices: { ...(ci.product.platformPrices || {}), ...prices } } };
    });
    setCartItems(updatedCart);
    await storage.saveCart(updatedCart);
    setMatchFlow(null);
    if (toastPlatform) {
      setMatchToast({ platform: toastPlatform, name: toastName });
    }
  };

  // ---------- Cart mutations ----------

  const handleAddToCart = async (product: UnifiedProduct) => {
    const items = cartItemsRef.current;
    const sameLineIdx = lineIdxFor(items, product);

    if (sameLineIdx > -1) {
      const line = items[sameLineIdx];
      const alreadyPricedHere = line.product.platform === product.platform || !!line.product.platformPrices?.[product.platform];
      let updatedLine;
      if (alreadyPricedHere) {
        // Same product tapped again — just bump quantity
        updatedLine = { ...line, quantity: line.quantity + 1 };
      } else {
        // Twin listing from the other app — merge its price into the line
        updatedLine = {
          ...line,
          product: { ...line.product, platformPrices: { ...(line.product.platformPrices || {}), [product.platform]: toVariant(product) } }
        };
      }
      const updated = [...items];
      updated[sameLineIdx] = updatedLine;
      setCartItems(updated);
      await storage.saveCart(updated);
      return;
    }

    // Brand-new line — add it, then auto-match the other apps
    const newLine = { product, quantity: 1 };
    const updated = [...items, newLine];
    setCartItems(updated);
    await storage.saveCart(updated);
    beginMatchFlow(newLine);
  };

  // A product and its auto-matched twins share ONE basket line — resolve by
  // normalized identity against BOTH the line's source listing AND every
  // stored platform variant (the matcher pairs similar, not identical,
  // names — e.g. 'Amul Butter Pasteurised 500 g' ↔ 'Amul Butter 500 g').
  const lineIdxFor = (items: { product: UnifiedProduct; quantity: number }[], product: UnifiedProduct) => {
    const k = liveKey({ name: product.title, unit: product.quantity });
    return items.findIndex(ci =>
      liveKey({ name: ci.product.title, unit: ci.product.quantity }) === k ||
      !!Object.values(ci.product.platformPrices || {}).find(v => liveKey({ name: v.title, unit: v.quantity }) === k)
    );
  };

  const handleStepQty = async (product: UnifiedProduct, delta: number) => {
    const items = cartItemsRef.current;
    const idx = lineIdxFor(items, product);
    if (idx === -1) return;
    const updated = [...items];
    const nextQty = updated[idx].quantity + delta;
    if (nextQty <= 0) updated.splice(idx, 1);
    else updated[idx] = { ...updated[idx], quantity: nextQty };
    setCartItems(updated);
    await storage.saveCart(updated);
  };

  const qtyFor = (product: UnifiedProduct) => {
    const idx = lineIdxFor(cartItems, product);
    return idx > -1 ? cartItems[idx].quantity : 0;
  };

  // Filter & sort products
  const filteredProducts = products
    .filter(p => storeFilter === 'all' || p.platform === storeFilter)
    .sort((a, b) => a.price - b.price);

  // Collapse identical products (any pack size, either app) into ONE card —
  // tap it to open the variant picker, like the desktop optimizer.
  const productGroups = (() => {
    const map = new Map<string, UnifiedProduct[]>();
    for (const pr of filteredProducts) {
      // Per-app groups only — a card never mixes Blinkit & Instamart
      // listings; auto-match owns all cross-app linking.
      const k = pr.platform + '|' + familyKey(pr);
      if (!familyKey(pr)) { map.set(`id:${pr.id}`, [pr]); continue; }
      const arr = map.get(k);
      if (arr) arr.push(pr);
      else map.set(k, [pr]);
    }
    return Array.from(map.values())
      .map(items => ({ items, minPrice: Math.min(...items.map(i => i.price || Infinity)) }))
      .sort((a, b) => a.minPrice - b.minPrice);
  })();

  const filterLabel = storeFilter === 'all' ? 'All Stores' : platformThemes[storeFilter].name;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={RNPlatform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Glass Header */}
      <View style={styles.headerGlass}>
        <LinearGradient
          colors={[colors.accentPrimary, colors.accentSecondary]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.brandIcon}
        >
          <ShoppingBag size={22} color="#FFF" />
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>BasketBuddy</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            Blinkit · Instamart · live checkout bills
          </Text>
        </View>
        <TouchableOpacity onPress={() => router.navigate('/(tabs)/cart')} style={styles.cartToggle}>
          <LinearGradient
            colors={[colors.emerald, colors.emeraldDark]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cartToggleInner}
          >
            <ShoppingCart size={16} color="#FFF" />
            <Text style={styles.cartToggleText}>Basket</Text>
          </LinearGradient>
          {cartItems.length > 0 && (
            <View style={styles.cartBadge}>
              <Text style={styles.cartBadgeText}>{cartItems.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Location bar */}
        <View style={styles.locationBar}>
          <MapPin size={13} color={colors.accentPrimary} />
          <Text style={styles.locationText} numberOfLines={1}>
            {location?.address || 'Pin delivery location in Accounts Tab'}
          </Text>
        </View>

        {/* Search bar */}
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Search size={18} color={colors.textMuted} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search Milk, Eggs, Atta, Butter, Oil…"
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => performSearch(query)}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={handleClear} style={styles.clearBtn}>
                <X size={16} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity style={styles.searchBtn} onPress={() => performSearch(query)}>
            <Text style={styles.searchBtnText}>Search</Text>
          </TouchableOpacity>
        </View>

        {/* Quick searches */}
        {products.length === 0 && (
          <View style={styles.quickRow}>
            <Text style={styles.quickLabel}>Quick:</Text>
            {QUICK_SEARCHES.map(term => (
              <TouchableOpacity key={term} style={styles.quickChip} onPress={() => handleQuickSearch(term)}>
                <Text style={styles.quickChipText}>{term}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Platform switcher */}
        <View style={styles.switcherWrap}>
          {switcherOpen && <Pressable style={styles.switcherBackdrop} onPress={() => setSwitcherOpen(false)} />}
          <TouchableOpacity style={styles.switcherPill} onPress={() => setSwitcherOpen(o => !o)}>
            {storeFilter === 'all'
              ? <View style={[styles.logoTile, { width: 26, height: 26, borderRadius: 8, backgroundColor: 'rgba(99, 102, 241, 0.15)', borderColor: colors.borderGlow }]}><ShoppingBag size={13} color={colors.accentPrimary} /></View>
              : <LogoTile platform={storeFilter} size={26} />}
            <Text style={styles.switcherLabel}>Showing results from</Text>
            <Text style={[styles.switcherName, { color: storeFilter === 'all' ? colors.textPrimary : platformThemes[storeFilter].color }]}>
              {filterLabel}
            </Text>
            <ChevronDown size={15} color={colors.textMuted} style={switcherOpen && { transform: [{ rotate: '180deg' }] }} />
          </TouchableOpacity>

          {switcherOpen && (
            <View style={styles.switcherMenu}>
              {(['all', ...PLATFORM_ORDER] as StoreFilter[]).map(opt => (
                <TouchableOpacity
                  key={opt}
                  style={styles.switcherOption}
                  onPress={() => { setStoreFilter(opt); setSwitcherOpen(false); }}
                >
                  {opt === 'all'
                    ? <View style={[styles.logoTile, { width: 30, height: 30, borderRadius: 9, backgroundColor: 'rgba(99, 102, 241, 0.15)', borderColor: colors.borderGlow }]}><ShoppingBag size={14} color={colors.accentPrimary} /></View>
                    : <LogoTile platform={opt} />}
                  <Text style={[styles.switcherOptionName, { color: opt === 'all' ? colors.textPrimary : platformThemes[opt].color }]}>
                    {opt === 'all' ? 'All Stores' : platformThemes[opt].name}
                  </Text>
                  <Text style={styles.switcherTagline}>{opt === 'all' ? 'Both apps side-by-side' : platformThemes[opt].tagline}</Text>
                  {storeFilter === opt && <Check size={16} color={colors.emerald} />}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Main Content */}
        {loading && products.length === 0 ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color={colors.accentPrimary} />
            <Text style={styles.loadingText}>Fetching live results…</Text>
            <Text style={styles.loadingSubtext}>
              {pendingPlatforms.length > 0
                ? `Searching ${pendingPlatforms.map(p => platformThemes[p].name).join(' & ')}`
                : 'Searching Blinkit & Instamart'}
            </Text>
          </View>
        ) : products.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyEmoji}>🛒</Text>
            <Text style={styles.emptyTitle}>Build your optimized basket</Text>
            <Text style={styles.emptySubtitle}>
              Search a product, tap +, and we’ll auto-match it on the other app with live checkout pricing.
            </Text>
          </View>
        ) : (
          <View style={styles.liveSection}>
            <View style={styles.liveHeader}>
              <View style={styles.liveIconChip}>
                <Zap size={17} color={colors.emerald} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.liveTitle} numberOfLines={1}>Live Results for “{query}”</Text>
                <Text style={styles.liveHint}>Tap + to add the exact product — the other app gets auto-matched.</Text>
              </View>
            </View>

            {pendingPlatforms.length > 0 && (
              <View style={styles.searchingPill}>
                <ActivityIndicator size={11} color={colors.accentPrimary} />
                <Text style={styles.searchingPillText}>
                  Searching {pendingPlatforms.map(p => platformThemes[p].name).join(' & ')}…
                </Text>
              </View>
            )}

            <FlatList
              data={productGroups}
              keyExtractor={(g) => g.items[0].platform + '|' + (familyKey(g.items[0]) || g.items[0].id)}
              numColumns={2}
              columnWrapperStyle={styles.gridRow}
              scrollEnabled={false}
              contentContainerStyle={styles.gridContent}
              ListFooterComponent={
                loading && pendingPlatforms.length > 0 ? (
                  <View style={styles.partialLoadingRow}>
                    <ActivityIndicator size="small" color={colors.accentPrimary} />
                    <Text style={styles.partialLoadingText}>
                      Fetching {pendingPlatforms.map(p => platformThemes[p].name).join(' & ')} prices…
                    </Text>
                  </View>
                ) : null
              }
              renderItem={({ item: group }) => {
                const items = [...group.items].sort((a, b) => a.price - b.price);
                const rep = items[0];
                const t = platformThemes[rep.platform];
                const plats = Array.from(new Set(items.map(i => i.platform)));
                const cartedItem = items.find(i => qtyFor(i) > 0);
                const qty = cartedItem ? qtyFor(cartedItem) : 0;
                const inCart = !!cartedItem;
                const prices = Array.from(new Set(items.map(i => i.price)));
                const maxMrp = Math.max(...items.map(i => i.originalPrice || i.price || 0));
                const discount = maxMrp > rep.price ? Math.round(((maxMrp - rep.price) / maxMrp) * 100) : 0;
                return (
                  <TouchableOpacity
                    activeOpacity={0.9}
                    onPress={() => setVariantBase(rep)}
                    style={[styles.pcCard, inCart && styles.pcCardAdded]}
                  >
                    <View style={styles.pcImageArea}>
                      <Image source={{ uri: rep.imageUrl }} style={styles.pcImage} resizeMode="contain" />
                      {discount > 0 && (
                        <View style={styles.discountBadge}>
                          <Text style={styles.discountText}>{discount}% OFF</Text>
                        </View>
                      )}
                      {items.length > 1 && (
                        <View style={styles.optCountBadge}>
                          <Text style={styles.optCountText}>{items.length} options</Text>
                        </View>
                      )}
                      <View style={styles.platBadgesRow}>
                        {plats.map(pl => {
                          const tt = platformThemes[pl];
                          return (
                            <View key={pl} style={[styles.platformCorner, { backgroundColor: tt.bgLight, borderColor: tt.borderColor }]}>
                              <Text style={[styles.platformCornerText, { color: tt.color }]}>{tt.name}</Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                    <Text style={styles.pcName} numberOfLines={2}>{rep.title}</Text>
                    <Text style={styles.pcUnit} numberOfLines={1}>{rep.quantity}</Text>
                    <View style={styles.pcFooter}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                        {prices.length > 1 && !inCart && <Text style={styles.pcUnit}>from </Text>}
                        <Text style={styles.pcPrice} numberOfLines={1}>₹{rep.price}</Text>
                        {maxMrp > rep.price && !inCart && (
                          <Text style={styles.pcMrp} numberOfLines={1}>₹{maxMrp}</Text>
                        )}
                      </View>
                      {!inCart ? (
                        <TouchableOpacity
                          onPress={() => items.length > 1 ? setVariantBase(rep) : handleAddToCart(rep)}
                          style={{ borderRadius: 17, overflow: 'hidden' }}
                        >
                          <LinearGradient colors={t.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.addBtn}>
                            <Plus size={16} color={t.textColor} />
                          </LinearGradient>
                        </TouchableOpacity>
                      ) : (
                        <View style={styles.stepper}>
                          <TouchableOpacity onPress={() => handleStepQty(cartedItem!, -1)} style={styles.stepBtn}>
                            <Minus size={13} color="#FFF" />
                          </TouchableOpacity>
                          <Text style={styles.stepQty}>{qty}</Text>
                          <TouchableOpacity onPress={() => handleStepQty(cartedItem!, 1)} style={styles.stepBtn}>
                            <Plus size={13} color="#FFF" />
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      <VariantPickerModal
        visible={!!variantBase}
        base={variantBase}
        options={variantBase ? products.filter(pr => pr.platform === variantBase.platform && familyKey(pr) === familyKey(variantBase)) : []}
        qtyFor={qtyFor}
        onPick={(p) => { setVariantBase(null); handleAddToCart(p); }}
        onClose={() => setVariantBase(null)}
      />

      {matchFlow && (
        <MatchModal
          flow={matchFlow}
          onChoose={handleChoose}
          onRetry={handleRetry}
          onSkip={handleSkipMatch}
          onConfirm={handleConfirmMatch}
        />
      )}

      {matchToast && (
        <TouchableOpacity style={styles.matchToast} onPress={() => setMatchToast(null)} activeOpacity={0.9}>
          <LogoTile platform={matchToast.platform} size={34} />
          <View style={{ flex: 1 }}>
            <Text style={styles.toastTitle}>Added to basket · now on {platformThemes[matchToast.platform].name}</Text>
            <Text style={styles.toastSub} numberOfLines={1}>Auto-matched “{matchToast.name}”</Text>
          </View>
          <Check size={16} color={colors.emerald} />
        </TouchableOpacity>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDark,
  },
  headerGlass: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 54,
    paddingBottom: 12,
    backgroundColor: colors.glassBg,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorder,
  },
  brandIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: fonts.headingBold,
    fontSize: 19,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    color: colors.textSecondary,
    marginTop: 1,
  },
  cartToggle: {
    position: 'relative',
  },
  cartToggleInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 12,
  },
  cartToggleText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    color: '#FFF',
  },
  cartBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    borderWidth: 2,
    borderColor: colors.bgDark,
  },
  cartBadgeText: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    color: colors.emeraldDark,
  },
  content: {
    paddingBottom: 24,
  },
  locationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 6,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: colors.bgCardSolid,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  locationText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.textSecondary,
    maxWidth: 260,
  },
  searchRow: {
    flexDirection: 'row',
    padding: 16,
    gap: 10,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCardSolid,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: 12,
    height: 48,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.bodyMedium,
    fontSize: 13.5,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  clearBtn: {
    padding: 4,
  },
  searchBtn: {
    backgroundColor: colors.accentPrimary,
    borderRadius: 16,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: '#FFF',
  },
  quickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  quickLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.textMuted,
  },
  quickChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.bgCardSolid,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quickChipText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.textSecondary,
  },
  switcherWrap: {
    alignItems: 'center',
    marginVertical: 12,
  },
  switcherBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  switcherPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.bgCardSolid,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    zIndex: 2,
  },
  switcherLabel: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    color: colors.textSecondary,
  },
  switcherName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
  },
  switcherMenu: {
    position: 'absolute',
    top: 46,
    zIndex: 3,
    width: 290,
    backgroundColor: '#0f172a',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 6,
  },
  switcherOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 10,
  },
  switcherOptionName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
  },
  switcherTagline: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 9.5,
    color: colors.textMuted,
  },
  logoTile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    backgroundColor: colors.bgCardSolid,
  },
  logoLetter: {
    fontFamily: fonts.headingBold,
  },
  centerContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 90,
    paddingHorizontal: 30,
  },
  loadingText: {
    fontFamily: fonts.bodySemiBold,
    color: colors.textPrimary,
    fontSize: 15,
    marginTop: 16,
  },
  loadingSubtext: {
    fontFamily: fonts.body,
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 6,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 70,
    paddingHorizontal: 36,
  },
  emptyEmoji: {
    fontSize: 52,
    marginBottom: 14,
  },
  emptyTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 8,
  },
  liveSection: {
    marginHorizontal: 14,
    backgroundColor: colors.bgCard,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 13,
  },
  liveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    marginBottom: 6,
  },
  liveIconChip: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveTitle: {
    fontFamily: fonts.heading,
    fontSize: 14.5,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  liveHint: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    color: colors.textMuted,
    marginTop: 2,
  },
  searchingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    marginTop: 6,
    marginBottom: 4,
  },
  searchingPillText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.accentPrimary,
  },
  gridContent: {
    paddingTop: 8,
  },
  gridRow: {
    gap: 10,
    marginBottom: 10,
  },
  pcCard: {
    width: '48.5%',
    backgroundColor: colors.bgTile,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  pcCardAdded: {
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  pcImageArea: {
    backgroundColor: colors.imageBg,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pcImage: {
    width: '78%',
    height: '78%',
  },
  discountBadge: {
    position: 'absolute',
    top: 7,
    left: 7,
    backgroundColor: colors.discountRed,
    paddingHorizontal: 6,
    paddingVertical: 2.5,
    borderRadius: 6,
  },
  discountText: {
    fontFamily: fonts.bodyBold,
    fontSize: 8.5,
    color: '#FFF',
  },
  optCountBadge: {
    position: 'absolute',
    top: 7,
    right: 7,
    backgroundColor: 'rgba(99, 102, 241, 0.92)',
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 7,
  },
  optCountText: {
    color: '#FFF',
    fontFamily: fonts.bodySemiBold,
    fontSize: 9.5,
    letterSpacing: 0.2,
  },
  platBadgesRow: {
    position: 'absolute',
    bottom: 7,
    left: 7,
    flexDirection: 'row',
    gap: 4,
    flexWrap: 'wrap',
  },
  platformCorner: {
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 6,
    borderWidth: 1,
  },
  platformCornerText: {
    fontFamily: fonts.bodyBold,
    fontSize: 8,
    letterSpacing: 0.3,
  },
  pcName: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 16,
    height: 32,
    marginTop: 9,
    paddingHorizontal: 11,
    minHeight: 32,
  },
  pcUnit: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    color: colors.textMuted,
    marginTop: 2,
    paddingHorizontal: 11,
  },
  pcFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    marginTop: 7,
    paddingHorizontal: 11,
    paddingBottom: 11,
  },
  pcPrice: {
    fontFamily: fonts.headingBold,
    fontSize: 14.5,
    color: colors.textPrimary,
  },
  pcMrp: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textMuted,
    textDecorationLine: 'line-through',
    marginLeft: 6,
  },
  addBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.emeraldStepper,
    borderRadius: 17,
  },
  stepBtn: {
    width: 26,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepQty: {
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    color: '#FFF',
    minWidth: 16,
    textAlign: 'center',
  },
  partialLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
  },
  partialLoadingText: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    color: colors.textMuted,
  },
  matchToast: {
    position: 'absolute',
    bottom: 28,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: '#0f172a',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
    padding: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 18,
    elevation: 8,
  },
  toastTitle: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    color: colors.emerald,
  },
  toastSub: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 1,
  },
});
