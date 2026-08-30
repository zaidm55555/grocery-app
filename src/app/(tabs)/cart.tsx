import React, { useState, useCallback, useRef } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, Image, Alert, ActivityIndicator, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { Plus, Minus, Trophy, ShieldCheck, Layers, RefreshCw, Trash2, Send } from 'lucide-react-native';
import { storage, Platform } from '../../services/storage';
import { api, UnifiedProduct, CartCalculation, resolvePlatformProduct } from '../../services/api';
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

export default function CartScreen() {
  const router = useRouter();
  const [cartItems, setCartItems] = useState<{ product: UnifiedProduct; quantity: number }[]>([]);
  const [calculations, setCalculations] = useState<CartCalculation[]>([]);
  const [winnerPlatform, setWinnerPlatform] = useState<Platform | null>(null);
  const [mostCompleteKeys, setMostCompleteKeys] = useState<Platform[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Platforms whose live bill is still being fetched — rendered as skeleton
  // cards so an already-arrived platform shows up immediately.
  const [pendingPlatforms, setPendingPlatforms] = useState<Platform[]>([]);
  const [exporting, setExporting] = useState<Platform | 'blinkit' | 'swiggy' | null>(null);
  const [loaded, setLoaded] = useState(false);
  const calcRunIdRef = useRef(0);

  // Ported from the Grocery Order Optimizer's optimizer.js badge logic:
  // verdicts use REAL bills only, prefer full basket coverage, and stay
  // silent on ties/noise.
  const computeVerdict = (calcs: CartCalculation[], totalLines: number) => {
    const real = calcs.filter(c => c.live && c.items.length > 0);
    let winnerKey: Platform | null = null;
    let lowestTotal = Infinity;
    // First pass: cheapest platform that stocks every item (real bills only).
    for (const c of real) {
      if (c.items.length === totalLines && c.total < lowestTotal) {
        lowestTotal = c.total;
        winnerKey = c.platform;
      }
    }
    // Fallback: nobody stocks everything — score coverage vs price so a
    // cheaper-but-incomplete platform can't beat a fuller basket at a
    // slightly higher price.
    if (!winnerKey) {
      let bestScore = -Infinity;
      for (const c of real) {
        const coverage = totalLines > 0 ? c.items.length / totalLines : 0;
        const missingItems = totalLines - c.items.length;
        const perItemPenalty = totalLines > 0 ? c.total / totalLines : 0;
        const score = (coverage * 1000) - (missingItems * perItemPenalty) - (c.total * 0.001);
        if (score > bestScore || (score === bestScore && c.total < lowestTotal)) {
          bestScore = score;
          lowestTotal = c.total;
          winnerKey = c.platform;
        }
      }
    }
    // Most Items: only meaningful when at least one platform is actually
    // missing items — and every platform tied at the max gets the badge.
    let maxStock = -1;
    let minStock = Infinity;
    for (const c of real) {
      if (c.items.length > maxStock) maxStock = c.items.length;
      if (c.items.length < minStock) minStock = c.items.length;
    }
    const mostComplete = maxStock > minStock
      ? real.filter(c => c.items.length === maxStock).map(c => c.platform)
      : [];
    return { winnerKey, mostCompleteKeys: mostComplete };
  };

  const loadCartData = async () => {
    const cart = await storage.getCart();
    setLoaded(true);
    setCartItems(cart);
    await runCalculations(cart);
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
      setWinnerPlatform(null);
      setMostCompleteKeys([]);
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

    setWinnerPlatform(null);
    setMostCompleteKeys([]);
    setCalculations([]);
    setPendingPlatforms(platformsWithItems);

    const arrivedCalcs: CartCalculation[] = [];
    try {
      await api.calculateCart(items, (calc) => {
        if (isStale()) return;
        arrivedCalcs.push(calc);
        setCalculations(prev => [...prev.filter(c => c.platform !== calc.platform), calc]);
        setPendingPlatforms(prev => prev.filter(p => p !== calc.platform));

        // Finalize the winner badge only once every priced platform is in,
        // so a fast-but-expensive result never flashes as "Best Value".
        if (platformsWithItems.length > 0 && arrivedCalcs.length === platformsWithItems.length) {
          const verdict = computeVerdict(arrivedCalcs, items.length);
          setWinnerPlatform(verdict.winnerKey);
          setMostCompleteKeys(verdict.mostCompleteKeys);
        }
      });
    } catch (err) {
      console.error(err);
      setPendingPlatforms([]);
    }
    if (isStale()) return;
  };

  const handleUpdateQuantity = async (productId: string, delta: number) => {
    let updatedCart = [...cartItems];
    const index = updatedCart.findIndex(item => item.product.id === productId);
    if (index === -1) return;

    updatedCart[index].quantity += delta;
    if (updatedCart[index].quantity <= 0) {
      updatedCart.splice(index, 1);
    }

    setCartItems(updatedCart);
    await storage.saveCart(updatedCart);
    await runCalculations(updatedCart);
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
          await runCalculations([]);
        }
      }
    ]);
  };

  const handleRefreshPrices = async () => {
    if (isRefreshing || cartItems.length === 0) return;
    setIsRefreshing(true);
    try {
      await runCalculations(cartItems);
    } finally {
      setIsRefreshing(false);
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
        const share = await createBlinkitShareLink(cartItems);
        if (!share) {
          Alert.alert('Could not create a share link', 'None of the basket items could be resolved to Blinkit products. Try removing unmatched items.', [
            { text: 'OK' }
          ]);
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
        if (share.missing.length > 0) {
          Alert.alert(
            `${share.missing.length} item${share.missing.length === 1 ? '' : 's'} skipped`,
            `${share.missing.map((m) => m.name).join(', ')} could not be matched on Blinkit and was left out of the share link.`,
            [{ text: 'OK' }]
          );
        }
        try {
          await Linking.openURL(share.url);
        } catch (e) {
          console.warn('[BlinkitShare] open failed', e);
          Alert.alert('Could not open the link', 'Copy the basket link and open it in Blinkit manually.', [
            { text: 'OK' }
          ]);
        }
        return;
      }

      // Swiggy
      const swiggyResult = await exportCartToSwiggy(cartItems);
      if (!swiggyResult) {
        Alert.alert('Swiggy not linked', 'Link your Swiggy account in the Accounts tab first, then export your basket.', [
          { text: 'OK' }
        ]);
        return;
      }
      const swiggyCartB64 = swiggyResult.writePayload ? btoaUnicode(JSON.stringify(swiggyResult.writePayload)) : '';
      router.push({
        pathname: '/webview',
        params: { platform: 'swiggy', mode: 'export', url: swiggyResult.cartUrl, cartId: swiggyResult.cartId || '', oldCartId: swiggyResult.oldCartId || '', cart: swiggyCartB64 }
      });
    } catch (err) {
      console.error(err);
      Alert.alert('Export failed', `Could not place the basket in ${display} right now. Please try again.`, [{ text: 'OK' }]);
    } finally {
      setExporting(null);
    }
  };

  // Per-line variant rows (one sub-row per app pricing this item)
  const basketLines = cartItems.map(line => {
    const variants = PLATFORM_ORDER
      .map(p => resolvePlatformProduct(line, p))
      .filter((v): v is { product: UnifiedProduct; quantity: number } => v !== null)
      .map(v => ({ platform: v.product.platform as Platform, product: v.product }));
    // Reference rule: trophy only when the cheapest price is strictly unique.
    const prices = variants.map(v => Number(v.product.price) || Infinity);
    const cheapestPrice = Math.min(...prices);
    const uniqueCheapest = variants.length > 1 && prices.filter(pr => pr === cheapestPrice).length === 1;
    const cheapestVariantId = uniqueCheapest ? variants[prices.indexOf(cheapestPrice)].product.id : null;
    return { id: line.product.id, line, variants, cheapestVariantId };
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
        </View>
        {cartItems.length > 0 && (
          <View style={styles.headerActions}>
            <TouchableOpacity
              onPress={() => handleExport('blinkit')}
              disabled={exporting !== null}
              style={[styles.exportBtn, exporting !== null && { opacity: 0.6 }]}
            >
              {exporting === 'blinkit'
                ? <ActivityIndicator size={12} color="#F8CB46" />
                : <Send size={12} color="#F8CB46" />}
              <Text style={styles.exportBtnText}>{exporting === 'blinkit' ? 'Exporting…' : 'Export Blinkit'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleExport('swiggy')}
              disabled={exporting !== null}
              style={[styles.swiggyBtn, exporting !== null && { opacity: 0.6 }]}
            >
              {exporting === 'swiggy'
                ? <ActivityIndicator size={12} color="#FC8019" />
                : <Send size={12} color="#FC8019" />}
              <Text style={styles.swiggyBtnText}>{exporting === 'swiggy' ? 'Exporting…' : 'Export Swiggy'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleRefreshPrices} disabled={isRefreshing} style={styles.fetchBtn}>
              {isRefreshing
                ? <ActivityIndicator size={12} color="#60A5FA" />
                : <RefreshCw size={12} color="#60A5FA" />}
              <Text style={styles.fetchBtnText}>{isRefreshing ? 'Fetching…' : 'Fetch Real Charges'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleClearCart} style={styles.clearBtn}>
              <Trash2 size={16} color={colors.rose} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {loaded && cartItems.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyEmoji}>🛒</Text>
          <Text style={styles.emptyStateTitle}>Your basket is empty</Text>
          <Text style={styles.emptyStateSub}>Add products from Search — every item gets auto-matched across apps with live fees.</Text>
        </View>
      ) : (
        <View>
          {/* Items in Basket */}
          <Text style={styles.sectionTitle}>Items in Basket ({cartItems.length})</Text>
          <View style={styles.panelCard}>
            {basketLines.map(({ id, line, variants, cheapestVariantId }) => (
              <View key={id} style={styles.lineCard}>
                {variants.length > 1 ? (
                  <>
                    {/* Matched line — one full row per app, each showing ITS OWN
                        listing (image, title, unit) like the desktop optimizer */}
                    {variants.map(v => {
                      const t = platformThemes[v.platform];
                      const isCheapest = v.product.id === cheapestVariantId;
                      return (
                        <View key={v.platform} style={[styles.variantRow, isCheapest && styles.variantCheapest]}>
                          <Image source={{ uri: v.product.imageUrl }} style={styles.variantImage} />
                          <View style={{ flex: 1 }}>
                            <View style={s_row.nameRow}>
                              <Text style={[styles.variantApp, { color: t.color }]}>{t.name}</Text>
                              {isCheapest && (
                                <View style={styles.trophyBadge}>
                                  <Trophy size={8} color="#000" />
                                  <Text style={styles.trophyText}>CHEAPEST</Text>
                                </View>
                              )}
                            </View>
                            <Text style={styles.lineTitle} numberOfLines={2}>{v.product.title}</Text>
                            <Text style={styles.lineUnit}>{v.product.quantity}</Text>
                          </View>
                          <View style={{ alignItems: 'flex-end' }}>
                            <Text style={[styles.variantPrice, isCheapest && { color: colors.emerald }]}>₹{v.product.price}</Text>
                            {isCheapest && <Text style={styles.cheapestCaption}>cheapest</Text>}
                          </View>
                        </View>
                      );
                    })}
                    {/* Shared quantity drives every app row on this line */}
                    <View style={styles.lineQtyFooter}>
                      <View style={styles.qtyContainer}>
                        <TouchableOpacity style={styles.qtyBtn} onPress={() => handleUpdateQuantity(id, -1)}>
                          <Minus size={13} color="#FFF" />
                        </TouchableOpacity>
                        <Text style={styles.qtyText}>{line.quantity}</Text>
                        <TouchableOpacity style={styles.qtyBtn} onPress={() => handleUpdateQuantity(id, 1)}>
                          <Plus size={13} color="#FFF" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </>
                ) : (
                  <View style={styles.lineMainRow}>
                    <Image source={{ uri: line.product.imageUrl }} style={styles.lineImage} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.lineTitle} numberOfLines={2}>{line.product.title}</Text>
                      <Text style={styles.lineUnit}>{line.product.quantity}</Text>
                    </View>
                    <View style={styles.qtyContainer}>
                      <TouchableOpacity style={styles.qtyBtn} onPress={() => handleUpdateQuantity(id, -1)}>
                        <Minus size={13} color="#FFF" />
                      </TouchableOpacity>
                      <Text style={styles.qtyText}>{line.quantity}</Text>
                      <TouchableOpacity style={styles.qtyBtn} onPress={() => handleUpdateQuantity(id, 1)}>
                        <Plus size={13} color="#FFF" />
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            ))}
          </View>

          {/* Full Cost Breakdown by App */}
          <Text style={styles.sectionTitle}>Full Cost Breakdown by App</Text>
          <View style={{ gap: 12 }}>
            {calculations.map((calc) => {
              const t = platformThemes[calc.platform];
              const isWinner = !!winnerPlatform && calc.platform === winnerPlatform;
              const isMostItems = mostCompleteKeys.includes(calc.platform);
              const hasItems = calc.items.length > 0;
              return (
                <View key={calc.platform} style={[styles.breakdownCard, isWinner && styles.winnerCard]}>
                  <View style={styles.breakdownHead}>
                    <LogoTile platform={calc.platform} />
                    <Text style={[styles.breakdownName, { color: t.color }]}>{t.name}</Text>
                    {!calc.live && hasItems && !pendingPlatforms.includes(calc.platform) && (
                      <View style={[styles.statusPill, { backgroundColor: 'rgba(244, 63, 94, 0.15)' }]}>
                        <Text style={[styles.statusText, { color: colors.rose }]}>Not Fetched</Text>
                      </View>
                    )}
                    {pendingPlatforms.includes(calc.platform) && (
                      <View style={[styles.statusPill, { backgroundColor: 'rgba(96, 165, 250, 0.15)' }]}>
                        <ActivityIndicator size={9} color="#60A5FA" />
                        <Text style={[styles.statusText, { color: '#60A5FA' }]}>Fetching…</Text>
                      </View>
                    )}
                    <View style={{ flex: 1 }} />
                    {isMostItems && (
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
                        <Text style={styles.bestValueText}>BEST VALUE</Text>
                      </LinearGradient>
                    )}
                  </View>

                  <View style={styles.feeRow}>
                    <Text style={styles.feeLabel}>Item subtotal</Text>
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
                </View>
              );
            })}

            {/* Skeleton while an app's live bill is being fetched */}
            {pendingPlatforms.map(platform => {
              const t = platformThemes[platform];
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
            })}
          </View>

          <View style={styles.footerNote}>
            <Text style={styles.noteText}>
              Compare & optimize here — place the final order in the respective apps once you’ve picked the cheapest checkout.
            </Text>
          </View>
        </View>
      )}
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(248, 203, 70, 0.4)',
    backgroundColor: 'rgba(248, 203, 70, 0.12)',
  },
  exportBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10.5,
    color: '#F8CB46',
  },
  swiggyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(252, 128, 25, 0.4)',
    backgroundColor: 'rgba(252, 128, 25, 0.12)',
  },
  swiggyBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10.5,
    color: '#FC8019',
  },
  fetchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.4)',
    backgroundColor: 'rgba(96, 165, 250, 0.12)',
  },
  fetchBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10.5,
    color: '#60A5FA',
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
  footerNote: {
    paddingHorizontal: 10,
    marginTop: 22,
  },
  noteText: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 15,
  },
});
