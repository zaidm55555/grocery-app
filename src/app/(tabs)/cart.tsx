import React, { useState, useCallback, useRef, useMemo } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, Image, Alert, ActivityIndicator, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { Plus, Minus, Trophy, ShieldCheck, Layers, RefreshCw, Trash2, Bookmark, Send, AlertTriangle, MapPinOff, CheckCircle2, AlertCircle, Info } from 'lucide-react-native';
import { storage, Platform } from '../../services/storage';
import { api, UnifiedProduct, CartCalculation, resolvePlatformProduct, getProductOverallMax } from '../../services/api';
import { refreshBasketLines, applyLiveLimits } from '../../services/basketRefresh';
import { computeBasketVerdict, getPlatformFulfillment, BasketVerdict } from '../../utils/basketVerdict';
import SavedListsModal from '../../components/SavedListsModal';
import { lists } from '../../services/lists';
import { createBlinkitShareLink } from '../../services/blinkitExport';
import { exportCartToSwiggy } from '../../services/swiggyExport';
import { colors, fonts, platformThemes, PLATFORM_ORDER } from '../../constants/theme';

function LogoTile({ platform, size = 26 }: { platform: Platform; size?: number }) {
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

interface VariantRowItem {
  platform: Platform;
  product: UnifiedProduct;
  isOos: boolean;
  platformLimit?: number;
  billedQty?: number;
  isCapped: boolean;
}

const EMPTY_VERDICT: BasketVerdict = {
  winnerKey: null, mostCompleteKeys: [], lowestBillKey: null, winnerIsPartial: false, fulfillment: {},
};

export default function CartScreen() {
  const router = useRouter();
  const [cartItems, setCartItems] = useState<{ product: UnifiedProduct; quantity: number }[]>([]);
  const [calculations, setCalculations] = useState<CartCalculation[]>([]);
  // Platforms whose live bill is still being fetched — rendered as skeleton
  // cards so an already-arrived platform shows up immediately.
  const [pendingPlatforms, setPendingPlatforms] = useState<Platform[]>([]);
  const [exporting, setExporting] = useState<Platform | 'blinkit' | 'swiggy' | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [locationMismatch, setLocationMismatch] = useState(false);
  const [cartLocationName, setCartLocationName] = useState<string | null>(null);
  const [listsOpen, setListsOpen] = useState(false);
  const calcRunIdRef = useRef(0);

  // Verdict badges are derived, never stored: recomputed only once every
  // priced platform has reported, so a fast-but-expensive result never
  // flashes as "Best Value".
  const verdict = useMemo(
    () => (pendingPlatforms.length === 0 && calculations.length > 0 && !locationMismatch
      ? computeBasketVerdict(calculations, cartItems)
      : EMPTY_VERDICT),
    [calculations, cartItems, pendingPlatforms, locationMismatch],
  );
  const winnerPlatform = verdict.winnerKey;
  const mostCompleteKeys = verdict.mostCompleteKeys;

  const loadCartData = async () => {
    const [cart, currentLoc, cartLoc, mismatchFlag] = await Promise.all([
      storage.getCart(),
      storage.getLocation(),
      storage.getCartLocation(),
      AsyncStorage.getItem('@cart_location_mismatch'),
    ]);
    setLoaded(true);
    setCartItems(cart);

    // Saved lines can be days old: re-validate price/stock/links against the
    // live catalogs before pricing, so the basket matches what Search shows.
    // Skipped on a location mismatch (prices there would be for another area).
    let liveCart = cart;
    if (cart.length > 0 && !(currentLoc && cartLoc && Math.hypot(currentLoc.latitude - cartLoc.latitude, currentLoc.longitude - cartLoc.longitude) > 0.005) && mismatchFlag !== 'true') {
      const refreshed = await refreshBasketLines(cart);
      if (refreshed.changed) {
        liveCart = refreshed.items;
        setCartItems(liveCart);
        await storage.saveCart(liveCart);
      }
    }

    let isMismatch = mismatchFlag === 'true';

    if (cart.length > 0 && currentLoc && cartLoc) {
      const dist = Math.sqrt(
        Math.pow(currentLoc.latitude - cartLoc.latitude, 2) +
        Math.pow(currentLoc.longitude - cartLoc.longitude, 2)
      );
      if (dist > 0.005) {
        isMismatch = true;
      }
      setCartLocationName(cartLoc.address || null);
    } else if (cart.length > 0 && mismatchFlag === 'true') {
      setCartLocationName('previous location');
    } else {
      setCartLocationName(null);
    }

    setLocationMismatch(isMismatch);

    // If location has changed, do NOT fetch prices for the new location!
    if (isMismatch) {
      calcRunIdRef.current++;
      setCalculations([]);
      setPendingPlatforms([]);
      return;
    }

    await runCalculations(liveCart);
  };

  useFocusEffect(
    useCallback(() => {
      // Intentionally run once per focus with the latest cart — re-adding
      // loadCartData here would re-subscribe on every render.
      loadCartData();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const runCalculations = async (items: { product: UnifiedProduct; quantity: number }[]) => {
    if (items.length === 0) {
      calcRunIdRef.current++;
      setCalculations([]);
      setPendingPlatforms([]);
      return;
    }

    // Invalidate any in-flight run so its late callbacks can't clobber
    // results from a newer cart/quantity change.
    const runId = ++calcRunIdRef.current;
    const isStale = () => calcRunIdRef.current !== runId;

    // Only platforms that actually have items need a live bill — the others
    // resolve instantly with zeroed totals.
    const platformsWithItems = PLATFORM_ORDER
      .filter(p => items.some(i => i.product.platform === p || i.product.platformPrices?.[p]));

    setCalculations([]);
    setPendingPlatforms(platformsWithItems);

    try {
      const results = await api.calculateCart(items, (calc) => {
        if (isStale()) return;
        setCalculations(prev => {
          const map = new Map(prev.map(c => [c.platform, c]));
          map.set(calc.platform, calc);
          return PLATFORM_ORDER.map(p => map.get(p)).filter((c): c is CartCalculation => !!c);
        });
        setPendingPlatforms(prev => prev.filter(p => p !== calc.platform));
      });
      if (isStale()) return;
      // Persist the live stock limits so Search/Basket stop trusting the stale snapshot.
      const base = await storage.getCart();
      const upd = applyLiveLimits(base, results);
      if (upd.changed) {
        await storage.saveCart(upd.items);
        if (!isStale()) setCartItems(upd.items);
      }
    } catch (err) {
      console.error(err);
      setPendingPlatforms([]);
    }
  };

  const handleUpdateQuantity = async (productId: string, delta: number) => {
    let updatedCart = [...cartItems];
    const index = updatedCart.findIndex(item => item.product.id === productId);
    if (index === -1) return;

    if (delta > 0) {
      const overall = getProductOverallMax(updatedCart[index].product, calculations);
      if (updatedCart[index].quantity >= overall.maxAllowed) {
        Alert.alert('Stock Limit Reached', `Maximum available stock of ${overall.maxAllowed} unit${overall.maxAllowed === 1 ? '' : 's'} reached across stores.`);
        return;
      }
    }

    updatedCart[index].quantity += delta;
    if (updatedCart[index].quantity <= 0) {
      updatedCart.splice(index, 1);
    }

    setCartItems(updatedCart);
    await storage.saveCart(updatedCart);
    if (!locationMismatch) {
      await runCalculations(updatedCart);
    }
  };

  const handleCartChangedByLists = async (next: { product: UnifiedProduct; quantity: number }[]) => {
    setCartItems(next);
    // Loaded items may predate the current delivery location; re-run the
    // location check so stale baskets don't get priced for the wrong place.
    await loadCartData();
  };

  const handleClearCart = async () => {
    Alert.alert('Clear Cart', 'Empty the optimized basket?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          setCartItems([]);
          await storage.saveCart([]);
          await AsyncStorage.removeItem('@cart_location');
          await AsyncStorage.removeItem('@cart_location_mismatch');
          await runCalculations([]);
          setLocationMismatch(false);
        }
      }
    ]);
  };

  const handleClearAndSearchAgain = async () => {
    setCartItems([]);
    await storage.saveCart([]);
    await AsyncStorage.removeItem('@cart_location');
    await AsyncStorage.removeItem('@cart_location_mismatch');
    setCalculations([]);
    setLocationMismatch(false);
    router.push('/(tabs)');
  };

  const handleRefreshPlatform = async (platform: Platform) => {
    if (pendingPlatforms.includes(platform) || cartItems.length === 0) return;
    setPendingPlatforms(prev => [...prev, platform]);
    try {
      await api.calculateCart(cartItems, (calc) => {
        setCalculations(prev => {
          const map = new Map(prev.map(c => [c.platform, c]));
          map.set(calc.platform, calc);
          return PLATFORM_ORDER.map(p => map.get(p)).filter((c): c is CartCalculation => !!c);
        });
        setPendingPlatforms(prev => prev.filter(p => p !== calc.platform));
      }, platform);
    } catch (err) {
      console.error(err);
      setPendingPlatforms(prev => prev.filter(p => p !== platform));
    }
  };

  // Push the optimized basket into the user's real account on a platform:
  //  - Blinkit: resolve the session's PERSISTENT cart and PUT the full basket
  //    to /v5/carts/{id} (a fresh-cart POST alone leaves the old server cart
  //    in place, which doubles quantities and triggers Blinkit's
  //    "prices have changed" modal at checkout), then a visible page writes
  //    the basket into localStorage['cart'] and opens the cart page.
  //  - Swiggy (Instamart): clear → write → verify over the real checkout/v2
  //    cart APIs, then the visible page wipes local caches and navigates to
  //    /instamart/cart.
  const handleExport = async (platform: 'blinkit' | 'swiggy') => {
    if (exporting || cartItems.length === 0) return;
    const display = platform === 'swiggy' ? 'Swiggy' : 'Blinkit';
    const linked = await storage.getToken(platform);
    if (!linked) {
      Alert.alert(`${display} not linked`, `Link your ${display} account in the Accounts tab first, then export your basket.`, [
        { text: 'OK' }
      ]);
      return;
    }
    setExporting(platform);
    try {
      if (platform === 'blinkit') {
        const share = await createBlinkitShareLink(cartItems, calculations);
        if (!share) {
          Alert.alert('Blinkit not linked', 'Link your Blinkit account in the Accounts tab first, then export your basket.', [
            { text: 'OK' }
          ]);
          return;
        }
        if (share.items.length === 0) {
          const parts: string[] = [];
          if (share.outOfStock.length > 0) {
            parts.push(`Out of Stock on Blinkit:\n${share.outOfStock.map((o) => `• ${o.name}`).join('\n')}`);
          }
          if (share.missing.length > 0) {
            parts.push(`Not found on Blinkit:\n${share.missing.map((m) => `• ${m.name}`).join('\n')}`);
          }
          Alert.alert(
            'Cannot export to Blinkit',
            parts.length > 0
              ? `No items could be exported:\n\n${parts.join('\n\n')}`
              : 'None of the basket items could be resolved to available Blinkit products.',
            [{ text: 'OK' }]
          );
          return;
        }
        if (!share.url) {
          console.warn('[BlinkitShare] no share url extracted', share);
          Alert.alert('Could not create a share link', 'Blinkit did not return a shareable link. Please try again in a moment.', [
            { text: 'OK' }
          ]);
          return;
        }
        try {
          await Clipboard.setStringAsync(share.url);
        } catch {}

        const proceedToOpen = async () => {
          lists.recordOrder(cartItems, 'blinkit').catch(() => {});
          try {
            await Linking.openURL(share.url);
          } catch (e) {
            console.warn('[BlinkitShare] open failed', e);
            Alert.alert('Could not open the link', 'Copy the basket link and open it in Blinkit manually.', [
              { text: 'OK' }
            ]);
          }
        };

        const notices: string[] = [];
        if (share.outOfStock.length > 0) {
          notices.push(`Skipped (Out of Stock on Blinkit):\n${share.outOfStock.map((o) => `• ${o.name}`).join('\n')}`);
        }
        if (share.clamped.length > 0) {
          notices.push(`Quantity adjusted to available stock:\n${share.clamped.map((c) => `• ${c.name} (${c.requestedQty} → ${c.exportedQty})`).join('\n')}`);
        }
        if (share.missing.length > 0) {
          notices.push(`Skipped (Not found on Blinkit):\n${share.missing.map((m) => `• ${m.name}`).join('\n')}`);
        }

        if (notices.length > 0) {
          Alert.alert(
            'Exporting to Blinkit',
            `${notices.join('\n\n')}\n\nOpening Blinkit with ${share.items.length} in-stock item${share.items.length === 1 ? '' : 's'}...`,
            [{ text: 'Continue', onPress: proceedToOpen }]
          );
        } else {
          await proceedToOpen();
        }
        return;
      }

      // Swiggy
      const swiggyResult = await exportCartToSwiggy(cartItems, calculations);
      if (!swiggyResult) {
        Alert.alert('Swiggy not linked', 'Link your Swiggy account in the Accounts tab first, then export your basket.', [
          { text: 'OK' }
        ]);
        return;
      }
      if (swiggyResult.items.length === 0) {
        const parts: string[] = [];
        if (swiggyResult.outOfStock.length > 0) {
          parts.push(`Out of Stock on Swiggy:\n${swiggyResult.outOfStock.map((o) => `• ${o.name}`).join('\n')}`);
        }
        if (swiggyResult.missing.length > 0) {
          parts.push(`Not found on Swiggy:\n${swiggyResult.missing.map((m) => `• ${m.name}`).join('\n')}`);
        }
        Alert.alert(
          'Cannot export to Swiggy',
          parts.length > 0
            ? `No items could be exported:\n\n${parts.join('\n\n')}`
            : 'None of the basket items could be resolved to available Swiggy products.',
          [{ text: 'OK' }]
        );
        return;
      }

      const proceedToWebview = () => {
        lists.recordOrder(cartItems, 'swiggy').catch(() => {});
        const swiggyCartB64 = swiggyResult.writePayload ? btoaUnicode(JSON.stringify(swiggyResult.writePayload)) : '';
        router.push({
          pathname: '/webview',
          params: { platform: 'swiggy', mode: 'export', url: swiggyResult.cartUrl, cartId: swiggyResult.cartId || '', oldCartId: swiggyResult.oldCartId || '', cart: swiggyCartB64 }
        });
      };

      const notices: string[] = [];
      if (swiggyResult.outOfStock.length > 0) {
        notices.push(`Skipped (Out of Stock on Swiggy):\n${swiggyResult.outOfStock.map((o) => `• ${o.name}`).join('\n')}`);
      }
      if (swiggyResult.clamped.length > 0) {
        notices.push(`Quantity adjusted to available stock:\n${swiggyResult.clamped.map((c) => `• ${c.name} (${c.requestedQty} → ${c.exportedQty})`).join('\n')}`);
      }
      if (swiggyResult.missing.length > 0) {
        notices.push(`Skipped (Not found on Swiggy):\n${swiggyResult.missing.map((m) => `• ${m.name}`).join('\n')}`);
      }

      if (notices.length > 0) {
        Alert.alert(
          'Exporting to Swiggy',
          `${notices.join('\n\n')}\n\nProceeding to Swiggy cart with ${swiggyResult.items.length} in-stock item${swiggyResult.items.length === 1 ? '' : 's'}...`,
          [{ text: 'Continue', onPress: proceedToWebview }]
        );
      } else {
        proceedToWebview();
      }
    } catch (err: any) {
      console.error(err);
      Alert.alert('Export failed', err?.message || `Could not place the basket in ${display} right now. Please try again.`, [{ text: 'OK' }]);
    } finally {
      setExporting(null);
    }
  };

  // Per-line variant rows (one sub-row per app pricing this item, Blinkit always on top)
  const basketLines = cartItems.map(line => {
    const overall = getProductOverallMax(line.product, calculations);
    const variants: VariantRowItem[] = PLATFORM_ORDER
      .map(p => {
        const resolved = resolvePlatformProduct(line, p);
        if (!resolved) return null;
        const calc = calculations.find(c => c.platform === p);
        const isOos = calc ? (calc.outOfStockProductIds?.includes(line.product.id) ?? false) : (resolved.product.inStock === false);
        const platformLimit = p === 'blinkit' ? overall.blinkitLimit : overall.swiggyLimit;
        const billedQty = calc?.platformItemQuantities?.[line.product.id];
        const isCapped = !isOos && platformLimit !== undefined && line.quantity > platformLimit;
        const item: VariantRowItem = {
          platform: p,
          product: { ...resolved.product, platform: p },
          isOos,
          platformLimit,
          billedQty,
          isCapped
        };
        return item;
      })
      .filter((v): v is VariantRowItem => v !== null)
      .sort((a, b) => (a.platform === 'blinkit' ? -1 : 1));

    // Reference rule: trophy only on in-stock variants, strictly unique cheapest.
    const inStockVariants = variants.filter(v => !v.isOos);
    const inStockPrices = inStockVariants.map(v => Number(v.product.price) || Infinity);
    const cheapestPrice = inStockPrices.length > 0 ? Math.min(...inStockPrices) : Infinity;
    const uniqueCheapest = inStockVariants.length > 1 && inStockPrices.filter(pr => pr === cheapestPrice).length === 1;
    const cheapestVariantId = uniqueCheapest ? inStockVariants[inStockPrices.indexOf(cheapestPrice)].product.id : null;

    // Check single-variant line OOS
    const singleCalc = calculations.find(c => c.platform === line.product.platform);
    const isSingleOos = singleCalc ? (singleCalc.outOfStockProductIds?.includes(line.product.id) ?? false) : (line.product.inStock === false);
    const singleLimit = line.product.platform === 'blinkit' ? overall.blinkitLimit : overall.swiggyLimit;
    const isSingleCapped = !isSingleOos && singleLimit !== undefined && line.quantity > singleLimit;
    const isAtOverallMax = line.quantity >= overall.maxAllowed;

    return { id: line.product.id, line, variants, cheapestVariantId, isSingleOos, overall, isSingleCapped, singleLimit, isAtOverallMax };
  });

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={[styles.headerIconTile, { backgroundColor: 'rgba(99, 102, 241, 0.15)' }]}>
            <ShieldCheck size={19} color={colors.accentPrimary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Optimized Basket Comparison</Text>
            <Text style={styles.subtitle}>{cartItems.length} item{cartItems.length === 1 ? '' : 's'} · live checkout bills</Text>
          </View>
          <TouchableOpacity
            onPress={() => setListsOpen(true)}
            style={styles.listsBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Bookmark size={16} color={colors.accentPrimary} />
          </TouchableOpacity>
          {cartItems.length > 0 && (
            <TouchableOpacity
              onPress={handleClearCart}
              style={styles.clearBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Trash2 size={16} color={colors.rose} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loaded && cartItems.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyEmoji}>🛒</Text>
          <Text style={styles.emptyStateTitle}>Your basket is empty</Text>
          <Text style={styles.emptyStateSub}>Add products from Search — every item gets auto-matched across apps with live fees.</Text>
          <TouchableOpacity style={styles.emptyListsBtn} onPress={() => setListsOpen(true)}>
            <Bookmark size={14} color={colors.accentPrimary} />
            <Text style={styles.emptyListsText}>Saved lists & buy again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View>
          {/* Items in Basket */}
          <Text style={styles.sectionTitle}>Items in Basket ({cartItems.length})</Text>
          <View style={styles.panelCard}>
            {basketLines.map(({ id, line, variants, cheapestVariantId, isSingleOos, overall, isSingleCapped, singleLimit, isAtOverallMax }) => (
              <View key={id} style={styles.lineCard}>
                {variants.length > 1 ? (
                  <>
                    {/* Matched line — one full row per app, each showing ITS OWN
                        listing (image, title, unit) like the desktop optimizer */}
                    {variants.map(v => {
                      const t = platformThemes[v.platform];
                      const isCheapest = v.product.id === cheapestVariantId;
                      const billedUnits = v.billedQty ?? (v.isCapped ? v.platformLimit : line.quantity);
                      const displayPrice = v.isCapped && v.platformLimit !== undefined
                        ? v.product.price * (billedUnits ?? 1)
                        : v.product.price * line.quantity;

                      return (
                        <View key={v.platform} style={[styles.variantRow, isCheapest && styles.variantCheapest, v.isOos && styles.variantOos]}>
                          <Image source={{ uri: v.product.imageUrl }} style={[styles.variantImage, v.isOos && { opacity: 0.45 }]} />
                          <View style={{ flex: 1 }}>
                            <View style={s_row.nameRow}>
                              <Text style={[styles.variantApp, { color: v.isOos ? colors.textMuted : t.color }]}>{t.name}</Text>
                              {v.isOos ? (
                                <View style={styles.oosBadge}>
                                  <AlertCircle size={8.5} color={colors.rose} style={{ marginRight: 3 }} />
                                  <Text style={styles.oosBadgeText}>OUT OF STOCK</Text>
                                </View>
                              ) : v.isCapped ? (
                                <View style={styles.limitBadge}>
                                  <AlertTriangle size={8.5} color={colors.amber} style={{ marginRight: 3 }} />
                                  <Text style={styles.limitBadgeText}>Only {v.platformLimit} in stock</Text>
                                </View>
                              ) : v.platformLimit !== undefined && v.platformLimit <= 15 ? (
                                <View style={styles.stockInfoBadge}>
                                  <CheckCircle2 size={8.5} color={colors.emerald} style={{ marginRight: 3 }} />
                                  <Text style={styles.stockInfoBadgeText}>{v.platformLimit} in stock</Text>
                                </View>
                              ) : isCheapest ? (
                                <View style={styles.trophyBadge}>
                                  <Trophy size={8} color="#000" />
                                  <Text style={styles.trophyText}>CHEAPEST</Text>
                                </View>
                              ) : null}
                            </View>
                            <Text style={[styles.lineTitle, v.isOos && styles.lineTitleOos]} numberOfLines={2}>{v.product.title}</Text>
                            <Text style={styles.lineUnit}>{v.product.quantity}</Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', minWidth: 70 }}>
                            {v.isOos ? (
                              <>
                                <Text style={styles.variantPriceOos}>₹{v.product.price}</Text>
                                <Text style={styles.oosSubtext}>₹0 in bill (excluded)</Text>
                              </>
                            ) : v.isCapped ? (
                              <>
                                <Text style={styles.cappedPriceText}>₹{displayPrice.toFixed(0)}</Text>
                                <Text style={styles.cappedSubtext}>for {billedUnits} of {line.quantity} units</Text>
                              </>
                            ) : (
                              <>
                                <Text style={[
                                  styles.variantPrice,
                                  isCheapest && { color: colors.emerald }
                                ]}>
                                  ₹{displayPrice.toFixed(0)}
                                </Text>
                                {line.quantity > 1 ? (
                                  <Text style={styles.unitSubtext}>₹{v.product.price} × {line.quantity}</Text>
                                ) : isCheapest ? (
                                  <Text style={styles.cheapestCaption}>cheapest</Text>
                                ) : null}
                              </>
                            )}
                          </View>
                        </View>
                      );
                    })}
                    {/* Shared quantity drives every app row on this line */}
                    <View style={styles.lineQtyFooter}>
                      <View style={{ flex: 1, justifyContent: 'center' }}>
                        {isAtOverallMax && overall.maxAllowed < 99 ? (
                          <View style={styles.maxStockBanner}>
                            <AlertTriangle size={11} color={colors.amber} style={{ marginRight: 4 }} />
                            <Text style={styles.maxStockBannerText}>
                              Max available stock reached ({overall.maxAllowed} units)
                            </Text>
                          </View>
                        ) : overall.isAsymmetric ? (
                          <View style={styles.asymmetricStockNotice}>
                            <Info size={11} color={colors.textSecondary} style={{ marginRight: 4 }} />
                            <Text style={styles.asymmetricStockText}>
                              {overall.blinkitLimit !== undefined ? `Blinkit: ${overall.blinkitLimit}` : ''}
                              {overall.blinkitLimit !== undefined && overall.swiggyLimit !== undefined ? ' · ' : ''}
                              {overall.swiggyLimit !== undefined ? `Swiggy: ${overall.swiggyLimit}` : ''}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <View style={styles.qtyContainer}>
                        <TouchableOpacity style={styles.qtyBtn} onPress={() => handleUpdateQuantity(id, -1)}>
                          <Minus size={13} color="#FFF" />
                        </TouchableOpacity>
                        <Text style={styles.qtyText}>{line.quantity}</Text>
                        <TouchableOpacity
                          style={[styles.qtyBtn, isAtOverallMax && styles.qtyBtnDisabled]}
                          activeOpacity={isAtOverallMax ? 1 : 0.7}
                          onPress={() => {
                            if (isAtOverallMax) {
                              Alert.alert('Stock Limit Reached', `Maximum available stock of ${overall.maxAllowed} unit${overall.maxAllowed === 1 ? '' : 's'} reached across stores.`);
                              return;
                            }
                            handleUpdateQuantity(id, 1);
                          }}
                        >
                          <Plus size={13} color="#FFF" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </>
                ) : (
                  <View style={[styles.lineMainRow, isSingleOos && styles.variantOos]}>
                    <Image source={{ uri: line.product.imageUrl }} style={[styles.lineImage, isSingleOos && { opacity: 0.45 }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.lineTitle, isSingleOos && styles.lineTitleOos]} numberOfLines={2}>{line.product.title}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                        <Text style={styles.lineUnit}>{line.product.quantity}</Text>
                        {isSingleOos ? (
                          <View style={styles.oosBadge}>
                            <AlertCircle size={8.5} color={colors.rose} style={{ marginRight: 3 }} />
                            <Text style={styles.oosBadgeText}>OUT OF STOCK</Text>
                          </View>
                        ) : isSingleCapped ? (
                          <View style={styles.limitBadge}>
                            <AlertTriangle size={8.5} color={colors.amber} style={{ marginRight: 3 }} />
                            <Text style={styles.limitBadgeText}>Only {singleLimit} in stock</Text>
                          </View>
                        ) : singleLimit !== undefined && singleLimit <= 15 ? (
                          <View style={styles.stockInfoBadge}>
                            <CheckCircle2 size={8.5} color={colors.emerald} style={{ marginRight: 3 }} />
                            <Text style={styles.stockInfoBadgeText}>{singleLimit} in stock</Text>
                          </View>
                        ) : null}
                      </View>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <View style={styles.qtyContainer}>
                        <TouchableOpacity style={styles.qtyBtn} onPress={() => handleUpdateQuantity(id, -1)}>
                          <Minus size={13} color="#FFF" />
                        </TouchableOpacity>
                        <Text style={styles.qtyText}>{line.quantity}</Text>
                        <TouchableOpacity
                          style={[styles.qtyBtn, isAtOverallMax && styles.qtyBtnDisabled]}
                          activeOpacity={isAtOverallMax ? 1 : 0.7}
                          onPress={() => {
                            if (isAtOverallMax) {
                              Alert.alert('Stock Limit Reached', `Maximum available stock of ${overall.maxAllowed} unit${overall.maxAllowed === 1 ? '' : 's'} reached across stores.`);
                              return;
                            }
                            handleUpdateQuantity(id, 1);
                          }}
                        >
                          <Plus size={13} color="#FFF" />
                        </TouchableOpacity>
                      </View>
                      {isAtOverallMax && overall.maxAllowed < 99 && (
                        <Text style={styles.maxReachedText}>Max stock reached ({overall.maxAllowed})</Text>
                      )}
                    </View>
                  </View>
                )}
              </View>
            ))}
          </View>

          {/* Full Cost Breakdown by App (Blinkit always on top) */}
          <Text style={styles.sectionTitle}>Full Cost Breakdown by App</Text>
          {locationMismatch ? (
            <View style={styles.mismatchNoticeCard}>
              <View style={styles.mismatchIconWrap}>
                <AlertTriangle size={24} color={colors.amber} />
              </View>
              <Text style={styles.mismatchNoticeTitle}>Live Pricing Paused</Text>
              <Text style={styles.mismatchNoticeText}>
                Pricing of the selected searched items is exhausted for live checkout.
                {'\n\n'}Clear your basket to start fresh and search for items with updated pricing.
              </Text>
              <TouchableOpacity
                style={styles.mismatchActionBtn}
                onPress={handleClearAndSearchAgain}
                activeOpacity={0.8}
              >
                <Trash2 size={15} color="#FFF" style={{ marginRight: 6 }} />
                <Text style={styles.mismatchActionBtnText}>Clear Basket & Search Again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              {PLATFORM_ORDER.map(platform => {
                const calc = calculations.find(c => c.platform === platform);
                const isPending = pendingPlatforms.includes(platform);
                const t = platformThemes[platform];

                if (calc) {
                  const isWinner = !!winnerPlatform && calc.platform === winnerPlatform;
                  const isMostItems = mostCompleteKeys.includes(calc.platform);
                  const isLowestBill = verdict.lowestBillKey === calc.platform;
                  const inStockCount = calc.inStockProductIds ? calc.inStockProductIds.length : calc.items.length;
                  const hasItems = inStockCount > 0 || calc.items.length > 0 || calc.total > 0;
                  return (
                    <View key={calc.platform} style={[styles.breakdownCard, isWinner && styles.winnerCard]}>
                      <View style={styles.breakdownHead}>
                        <LogoTile platform={calc.platform} />
                        <Text style={[styles.breakdownName, { color: t.color }]}>{t.name}</Text>
                        {!calc.live && hasItems && !isPending && (
                          <View style={[styles.statusPill, { backgroundColor: 'rgba(245, 158, 11, 0.15)' }]}>
                            <Text style={[styles.statusText, { color: colors.amber }]}>Unverified</Text>
                          </View>
                        )}
                        {isPending && (
                          <View style={[styles.statusPill, { backgroundColor: 'rgba(96, 165, 250, 0.15)' }]}>
                            <ActivityIndicator size={9} color="#60A5FA" />
                            <Text style={[styles.statusText, { color: '#60A5FA' }]}>Fetching…</Text>
                          </View>
                        )}
                        <View style={{ flex: 1 }} />
                        {isLowestBill && !isWinner && (
                          <View style={styles.lowestBillBadge}>
                            <Text style={styles.mostItemsText}>LOWEST BILL</Text>
                          </View>
                        )}
                        {isMostItems && !isWinner && (
                          <View style={styles.mostItemsBadge}>
                            <Layers size={9} color="#FFF" />
                            <Text style={styles.mostItemsText}>MOST ITEMS</Text>
                          </View>
                        )}
                        {isWinner && (
                          <LinearGradient
                            colors={[colors.emerald, colors.emeraldDark]}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 1 }}
                            style={styles.bestValueBadge}
                          >
                            <Trophy size={9} color="#FFF" />
                            <Text style={styles.bestValueText}>{verdict.winnerIsPartial ? 'BEST VALUE · PARTIAL' : 'BEST VALUE'}</Text>
                          </LinearGradient>
                        )}
                        <TouchableOpacity
                          onPress={() => handleRefreshPlatform(calc.platform)}
                          disabled={isPending || !hasItems}
                          style={[
                            styles.reloadIconBtn,
                            (isPending || !hasItems) && { opacity: 0.5 }
                          ]}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          activeOpacity={0.7}
                        >
                          {isPending ? (
                            <ActivityIndicator size={12} color={colors.textSecondary} />
                          ) : (
                            <RefreshCw size={13} color={colors.textSecondary} />
                          )}
                        </TouchableOpacity>
                      </View>

                      {/* Store Stock & Inventory Breakdown */}
                      {(() => {
                        const fulfil = verdict.fulfillment[calc.platform] ?? getPlatformFulfillment(calc, cartItems, calculations);
                        const storeOosLines = fulfil.oos.map(o => o.line);
                        const storeCappedLines = fulfil.capped.map(c => ({ line: c.line, limit: c.limit ?? c.line.quantity }));
                        const inStockCount = fulfil.availableLineCount;
                        const fullyFulfilledCount = fulfil.fullLineCount;

                        return (
                          <View style={styles.inventoryStatusCard}>
                            {/* Stock Coverage Progress Bar */}
                            <View style={styles.coverageRow}>
                              <Text style={styles.coverageLabel}>Stock Availability</Text>
                              <Text style={[
                                styles.coverageValue,
                                storeOosLines.length === 0 && storeCappedLines.length === 0 ? { color: colors.emerald } : { color: colors.amber }
                              ]}>
                                {storeOosLines.length === 0 && storeCappedLines.length === 0
                                  ? `All ${cartItems.length} items in stock`
                                  : `${inStockCount} of ${cartItems.length} items available`}
                              </Text>
                            </View>

                            <View style={styles.coverageBarTrack}>
                              {fullyFulfilledCount > 0 && (
                                <View style={[styles.coverageBarFillGreen, { flex: fullyFulfilledCount }]} />
                              )}
                              {storeCappedLines.length > 0 && (
                                <View style={[styles.coverageBarFillAmber, { flex: storeCappedLines.length }]} />
                              )}
                              {storeOosLines.length > 0 && (
                                <View style={[styles.coverageBarFillRose, { flex: storeOosLines.length }]} />
                              )}
                            </View>

                            {/* OOS Itemized Box */}
                            {storeOosLines.length > 0 && (
                              <View style={styles.stockAlertOosBox}>
                                <View style={styles.stockAlertHeaderRow}>
                                  <AlertCircle size={12} color={colors.rose} />
                                  <Text style={styles.stockAlertOosTitle}>
                                    {storeOosLines.length} item{storeOosLines.length === 1 ? '' : 's'} out of stock
                                  </Text>
                                </View>
                                <Text style={styles.stockAlertOosDesc}>
                                  Excluded from bill and will not be exported to {t.name}
                                </Text>
                                <View style={styles.stockChipWrap}>
                                  {storeOosLines.map(item => (
                                    <View key={item.product.id} style={styles.chipOos}>
                                      <Text style={styles.chipTextOos} numberOfLines={1}>
                                        ✕ {item.product.title}
                                      </Text>
                                    </View>
                                  ))}
                                </View>
                              </View>
                            )}

                            {/* Capped Itemized Box */}
                            {storeCappedLines.length > 0 && (
                              <View style={styles.stockAlertCappedBox}>
                                <View style={styles.stockAlertHeaderRow}>
                                  <AlertTriangle size={12} color={colors.amber} />
                                  <Text style={styles.stockAlertCappedTitle}>
                                    {storeCappedLines.length} item{storeCappedLines.length === 1 ? '' : 's'} stock capped
                                  </Text>
                                </View>
                                <Text style={styles.stockAlertCappedDesc}>
                                  Priced for in-stock quantity only
                                </Text>
                                <View style={styles.stockChipWrap}>
                                  {storeCappedLines.map(({ line, limit }) => (
                                    <View key={line.product.id} style={styles.chipCapped}>
                                      <Text style={styles.chipTextCapped} numberOfLines={1}>
                                        ⚠ {line.product.title}: {limit} of {line.quantity} units
                                      </Text>
                                    </View>
                                  ))}
                                </View>
                              </View>
                            )}
                          </View>
                        );
                      })()}

                      {!calc.live ? (
                        <View style={{ marginTop: 2 }}>
                          <View style={styles.unfetchedWarningBox}>
                            <AlertTriangle size={15} color={colors.amber} style={{ marginTop: 1 }} />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.unfetchedWarningTitle}>Pricing Unavailable</Text>
                              <Text style={styles.unfetchedWarningText}>
                                Live pricing of the selected items is exhausted and cannot be verified.
                              </Text>
                            </View>
                          </View>
                          <View style={styles.feeRow}>
                            <Text style={styles.feeLabel}>Item subtotal (estimated)</Text>
                            <Text style={styles.feeValue}>~₹{calc.subtotal}</Text>
                          </View>
                          <View style={styles.feeRow}>
                            <Text style={styles.feeLabel}>Delivery & platform fees</Text>
                            <Text style={styles.feeMuted}>Uncalculated</Text>
                          </View>
                          <View style={styles.totalDashed} />
                          <View style={styles.totalRow}>
                            <Text style={styles.totalLabel}>Total to pay</Text>
                            <Text style={[styles.totalValue, { color: colors.textMuted, fontSize: 16 }]}>Unavailable</Text>
                          </View>
                          <Text style={styles.unfetchedNote}>
                            Live checkout pricing could not be verified
                          </Text>
                        </View>
                      ) : (
                        <>
                          <View style={styles.feeRow}>
                            <Text style={styles.feeLabel}>
                              Item subtotal {inStockCount < cartItems.length
                                ? `(${inStockCount} of ${cartItems.length} items)`
                                : ''}
                            </Text>
                            <Text style={styles.feeValue}>₹{calc.subtotal}</Text>
                          </View>
                          <View style={styles.feeRow}>
                            <Text style={styles.feeLabel}>Delivery fee</Text>
                            {calc.deliveryFee === 0 ? (
                              <View style={styles.freeTag}><Text style={styles.freeTagText}>FREE</Text></View>
                            ) : (
                              <Text style={styles.feeValue}>₹{calc.deliveryFee}</Text>
                            )}
                          </View>
                          {calc.freeDeliveryGap !== undefined && calc.freeDeliveryGap > 0 && calc.deliveryFee > 0 && (
                            <Text style={styles.freeDeliveryNudge}>
                              Add ₹{calc.freeDeliveryGap} more for free delivery
                            </Text>
                          )}
                          <View style={styles.feeRow}>
                            <Text style={styles.feeLabel}>Handling / packaging</Text>
                            <Text style={styles.feeValue}>₹{calc.handlingFee}</Text>
                          </View>
                          {calc.smallCartFee > 0 && (
                            <View style={styles.feeRow}>
                              <Text style={styles.feeWarnLabel}>Small-cart fee</Text>
                              <Text style={styles.feeWarnValue}>₹{calc.smallCartFee}</Text>
                            </View>
                          )}
                          {calc.surgeFee > 0 && (
                            <View style={styles.feeRow}>
                              <Text style={styles.feeWarnLabel}>{calc.surgeLabel || 'Surge fee'}</Text>
                              <Text style={styles.feeWarnValue}>₹{calc.surgeFee}</Text>
                            </View>
                          )}
                          {calc.tax > 0 && (
                            <View style={styles.feeRow}>
                              <Text style={styles.feeLabel}>GST</Text>
                              <Text style={styles.feeValue}>₹{calc.tax}</Text>
                            </View>
                          )}

                          <View style={styles.totalDashed} />
                          <View style={styles.totalRow}>
                            <Text style={styles.totalLabel}>To pay</Text>
                            <Text style={[styles.totalValue, isWinner && { color: colors.emerald }]}>₹{calc.total}</Text>
                          </View>
                          {calc.savings > 0 && (
                            <Text style={styles.savingsLine}>− ₹{calc.savings} saved off MRP on this basket</Text>
                          )}
                          {calc.outOfStockProductIds && calc.outOfStockProductIds.length > 0 && (
                            <Text style={styles.stockExclusionNote}>
                              * Bill excludes {calc.outOfStockProductIds.length} unavailable item{calc.outOfStockProductIds.length === 1 ? '' : 's'}
                            </Text>
                          )}
                        </>
                      )}

                      {!calc.live ? (
                        <TouchableOpacity
                          disabled={true}
                          style={[
                            styles.cardExportBtn,
                            { opacity: 0.6, backgroundColor: 'rgba(255, 255, 255, 0.04)', borderWidth: 1, borderColor: colors.border }
                          ]}
                        >
                          <View style={styles.cardExportBtnGradient}>
                            <MapPinOff size={13} color={colors.textMuted} />
                            <Text style={[styles.cardExportBtnText, { color: colors.textMuted }]}>
                              Unavailable at Current Location
                            </Text>
                          </View>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          onPress={() => handleExport(calc.platform)}
                          disabled={exporting !== null || !hasItems}
                          style={[
                            styles.cardExportBtn,
                            (exporting !== null || !hasItems) && { opacity: 0.55 }
                          ]}
                          activeOpacity={0.8}
                        >
                          <LinearGradient
                            colors={t.gradient}
                            start={{ x: 0, y: 0 }}
                            end={{ x: 1, y: 0 }}
                            style={styles.cardExportBtnGradient}
                          >
                            {exporting === calc.platform ? (
                              <ActivityIndicator size={14} color={t.textColor} />
                            ) : (
                              <Send size={14} color={t.textColor} />
                            )}
                            <View style={styles.cardExportBtnContent}>
                              <Text style={[styles.cardExportBtnText, { color: t.textColor }]}>
                                {exporting === calc.platform
                                  ? `Exporting to ${t.name}…`
                                  : !hasItems
                                  ? `No items available on ${t.name}`
                                  : (calc.outOfStockProductIds && calc.outOfStockProductIds.length > 0)
                                  ? `Export Available Items to ${t.name}`
                                  : `Export Basket to ${t.name}`}
                              </Text>
                              {hasItems && (calc.outOfStockProductIds && calc.outOfStockProductIds.length > 0) && (
                                <Text style={[styles.cardExportBtnSubtext, { color: t.textColor }]}>
                                  {calc.outOfStockProductIds.length} out-of-stock item{calc.outOfStockProductIds.length === 1 ? '' : 's'} will be skipped
                                </Text>
                              )}
                            </View>
                          </LinearGradient>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                }

                if (isPending) {
                  return (
                    <View key={`loading-${platform}`} style={styles.breakdownCard}>
                      <View style={styles.breakdownHead}>
                        <LogoTile platform={platform} />
                        <Text style={[styles.breakdownName, { color: t.color }]}>{t.name}</Text>
                        <View style={{ flex: 1 }} />
                        <View style={[styles.statusPill, { backgroundColor: 'rgba(96, 165, 250, 0.15)' }]}>
                          <ActivityIndicator size={9} color="#60A5FA" />
                          <Text style={[styles.statusText, { color: '#60A5FA' }]}>Fetching…</Text>
                        </View>
                      </View>
                      {[64, 52, 70].map((_, i) => (
                        <View key={i} style={[styles.skeletonBar, { width: `${100 - i * 18}%`, marginTop: 10 }]} />
                      ))}
                      <View style={[styles.skeletonBar, { width: '45%', height: 16, marginTop: 18 }]} />
                    </View>
                  );
                }

                return null;
              })}
            </View>
          )}
        </View>
      )}
      <SavedListsModal
        visible={listsOpen}
        onClose={() => setListsOpen(false)}
        cartItems={cartItems}
        onCartChanged={handleCartChangedByLists}
      />
    </ScrollView>
  );
}

const s_row = StyleSheet.create({
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});

// UTF-8-safe base64url encoder for passing the cart object through a route
// param (URL-safe so + / = can't corrupt the query string).
function btoaUnicode(str: string): string {
  let b = '';
  try {
    b = btoa(unescape(encodeURIComponent(str)));
  } catch {
    b = globalThis.btoa ? globalThis.btoa(str) : str;
  }
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDark,
  },
  content: {
    padding: 14,
    paddingTop: 54,
    paddingBottom: 40,
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
  header: {
    marginBottom: 18,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  headerIconTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: fonts.headingBold,
    fontSize: 17,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 1,
  },
  cardExportBtn: {
    marginTop: 14,
    borderRadius: 12,
    overflow: 'hidden',
  },
  cardExportBtnGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  cardExportBtnText: {
    fontFamily: fonts.bodyBold,
    fontSize: 12.5,
    letterSpacing: 0.2,
  },
  reloadIconBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: colors.border,
    marginLeft: 6,
  },
  listsBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
  },
  emptyListsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
  },
  emptyListsText: {
    fontFamily: fonts.heading,
    fontSize: 12.5,
    color: colors.accentPrimary,
  },
  clearBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(244, 63, 94, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.25)',
  },
  sectionTitle: {
    fontFamily: fonts.heading,
    fontSize: 13.5,
    color: colors.textSecondary,
    marginBottom: 10,
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  panelCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 10,
    marginBottom: 22,
  },
  lineCard: {
    backgroundColor: colors.bgTile,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  lineMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  lineImage: {
    width: 46,
    height: 46,
    borderRadius: 10,
    backgroundColor: colors.imageBg,
  },
  lineTitle: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12.5,
    color: colors.textPrimary,
    lineHeight: 16,
  },
  lineUnit: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    color: colors.textMuted,
    marginTop: 2,
  },
  qtyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.emeraldStepper,
    borderRadius: 15,
  },
  qtyBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyText: {
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    color: '#FFF',
    minWidth: 18,
    textAlign: 'center',
  },
  variantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 8,
    marginLeft: 4,
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  variantCheapest: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderColor: 'rgba(16, 185, 129, 0.35)',
  },
  variantImage: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: colors.bgCardSolid,
  },
  lineQtyFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 6,
  },
  variantApp: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
  },
  trophyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.emerald,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 5,
  },
  trophyText: {
    fontFamily: fonts.bodyBold,
    fontSize: 7,
    color: '#000',
    letterSpacing: 0.3,
  },
  variantName: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 1,
  },
  variantPrice: {
    fontFamily: fonts.bodyBold,
    fontSize: 13,
    color: colors.textPrimary,
  },
  cheapestCaption: {
    fontFamily: fonts.body,
    fontSize: 8.5,
    color: colors.emerald,
  },
  oosBadge: {
    backgroundColor: 'rgba(244, 63, 94, 0.15)',
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.35)',
  },
  oosBadgeText: {
    fontFamily: fonts.bodyBold,
    fontSize: 7.5,
    color: colors.rose,
    letterSpacing: 0.3,
  },
  variantOos: {
    opacity: 0.65,
    borderColor: 'rgba(244, 63, 94, 0.2)',
  },
  lineTitleOos: {
    color: colors.textMuted,
  },
  variantPriceOos: {
    color: colors.textMuted,
    textDecorationLine: 'line-through',
  },
  oosSubtext: {
    fontFamily: fonts.body,
    fontSize: 8.5,
    color: colors.rose,
    marginTop: 1,
  },
  cardOosNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(244, 63, 94, 0.08)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.2)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    marginTop: 4,
    marginBottom: 8,
  },
  cardOosNoticeText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.rose,
  },
  breakdownCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  winnerCard: {
    borderColor: 'rgba(16, 185, 129, 0.5)',
    backgroundColor: 'rgba(16, 185, 129, 0.05)',
  },
  breakdownHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginBottom: 12,
  },
  breakdownName: {
    fontFamily: fonts.heading,
    fontSize: 15,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderRadius: 999,
  },
  statusText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 9.5,
  },
  mostItemsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentPrimary,
    paddingHorizontal: 7,
    paddingVertical: 3.5,
    borderRadius: 999,
  },
  mostItemsText: {
    fontFamily: fonts.bodyBold,
    fontSize: 7.5,
    color: '#FFF',
    letterSpacing: 0.4,
  },
  lowestBillBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.amber,
    paddingHorizontal: 7,
    paddingVertical: 3.5,
    borderRadius: 999,
  },
  bestValueBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  bestValueText: {
    fontFamily: fonts.bodyBold,
    fontSize: 7.5,
    color: '#FFF',
    letterSpacing: 0.4,
  },
  feeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 7,
  },
  feeLabel: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    color: colors.textSecondary,
  },
  feeValue: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11.5,
    color: colors.textPrimary,
  },
  feeMuted: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  feeWarnLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.amber,
  },
  feeWarnValue: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.amber,
  },
  freeTag: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
  },
  freeTagText: {
    fontFamily: fonts.bodyBold,
    fontSize: 8.5,
    color: colors.emerald,
    letterSpacing: 0.4,
  },
  totalDashed: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.14)',
    borderStyle: 'dashed',
    marginTop: 4,
    marginBottom: 10,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    color: colors.textPrimary,
  },
  totalValue: {
    fontFamily: fonts.headingBold,
    fontSize: 19,
    color: colors.textPrimary,
  },
  freeDeliveryNudge: {
    fontFamily: fonts.bodyBold,
    fontSize: 10.5,
    color: colors.emerald,
    textAlign: 'right',
    marginTop: -2,
    marginBottom: 6,
  },
  savingsLine: {
    fontFamily: fonts.bodyMedium,
    fontSize: 10,
    color: colors.emerald,
    marginTop: 7,
  },
  skeletonBar: {
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 90,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: 14,
  },
  emptyStateTitle: {
    fontFamily: fonts.heading,
    fontSize: 17,
    color: colors.textPrimary,
    marginBottom: 6,
  },
  emptyStateSub: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 30,
  },
  unfetchedWarningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.2)',
    padding: 10,
    marginBottom: 12,
    gap: 8,
  },
  unfetchedWarningTitle: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11.5,
    color: colors.amber,
  },
  unfetchedWarningText: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    color: colors.textSecondary,
    lineHeight: 15,
    marginTop: 2,
  },
  unfetchedNote: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textMuted,
    fontStyle: 'italic',
    marginTop: 6,
    textAlign: 'center',
  },
  mismatchNoticeCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    padding: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  mismatchIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  mismatchNoticeTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.textPrimary,
    marginBottom: 6,
    textAlign: 'center',
  },
  mismatchNoticeText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
    paddingHorizontal: 12,
  },
  mismatchActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(244, 63, 94, 0.9)',
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 12,
    gap: 6,
  },
  mismatchActionBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12.5,
    color: '#FFF',
  },
  limitBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
  },
  limitBadgeText: {
    fontFamily: fonts.bodyBold,
    fontSize: 9,
    color: colors.amber,
  },
  cappedSubtext: {
    fontFamily: fonts.bodyMedium,
    fontSize: 9.5,
    color: colors.amber,
    marginTop: 2,
  },
  qtyBtnDisabled: {
    opacity: 0.35,
  },
  maxReachedText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 10,
    color: colors.amber,
    marginTop: 4,
  },
  stockInfoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    paddingHorizontal: 5.5,
    paddingVertical: 1.5,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  stockInfoBadgeText: {
    fontFamily: fonts.bodyBold,
    fontSize: 8.5,
    color: colors.emerald,
  },
  unitSubtext: {
    fontFamily: fonts.body,
    fontSize: 9,
    color: colors.textMuted,
    marginTop: 1,
  },
  cappedPriceText: {
    fontFamily: fonts.bodyBold,
    fontSize: 13,
    color: colors.amber,
  },
  maxStockBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.28)',
    alignSelf: 'flex-start',
  },
  maxStockBannerText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    color: colors.amber,
  },
  asymmetricStockNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    alignSelf: 'flex-start',
  },
  asymmetricStockText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 10,
    color: colors.textSecondary,
  },
  inventoryStatusCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.025)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.07)',
    padding: 10,
    marginBottom: 10,
    gap: 8,
  },
  coverageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  coverageLabel: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.textSecondary,
  },
  coverageValue: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
  },
  coverageBarTrack: {
    flexDirection: 'row',
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
    gap: 2,
  },
  coverageBarFillGreen: {
    backgroundColor: colors.emerald,
    borderRadius: 999,
  },
  coverageBarFillAmber: {
    backgroundColor: colors.amber,
    borderRadius: 999,
  },
  coverageBarFillRose: {
    backgroundColor: colors.rose,
    borderRadius: 999,
  },
  stockAlertOosBox: {
    backgroundColor: 'rgba(244, 63, 94, 0.08)',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.22)',
    padding: 8,
  },
  stockAlertCappedBox: {
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.22)',
    padding: 8,
  },
  stockAlertHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  stockAlertOosTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    color: colors.rose,
  },
  stockAlertOosDesc: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textSecondary,
    marginTop: 2,
    marginBottom: 4,
  },
  stockAlertCappedTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    color: colors.amber,
  },
  stockAlertCappedDesc: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textSecondary,
    marginTop: 2,
    marginBottom: 4,
  },
  stockChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 4,
  },
  chipOos: {
    backgroundColor: 'rgba(244, 63, 94, 0.16)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.3)',
  },
  chipTextOos: {
    fontFamily: fonts.bodyMedium,
    fontSize: 9.5,
    color: colors.rose,
  },
  chipCapped: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  chipTextCapped: {
    fontFamily: fonts.bodyMedium,
    fontSize: 9.5,
    color: colors.amber,
  },
  stockExclusionNote: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.rose,
    marginTop: 3,
  },
  stockCappedNote: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.amber,
    marginTop: 2,
  },
  cardExportBtnContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  cardExportBtnSubtext: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 9.5,
    opacity: 0.9,
  },
});
