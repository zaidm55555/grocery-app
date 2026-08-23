import React, { useState, useCallback } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, Image, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Plus, Minus, Trash2, Zap, ArrowRight, TrendingDown, Layers, RefreshCw } from 'lucide-react-native';
import { storage, Platform } from '../../services/storage';
import { api, UnifiedProduct, CartCalculation } from '../../services/api';

export default function CartScreen() {
  const [cartItems, setCartItems] = useState<{ product: UnifiedProduct; quantity: number }[]>([]);
  const [calculations, setCalculations] = useState<CartCalculation[]>([]);
  const [cheapestPlatform, setCheapestPlatform] = useState<Platform | null>(null);
  const [splitSuggestion, setSplitSuggestion] = useState<any>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadCartData = async () => {
    const cart = await storage.getCart();
    setCartItems(cart);
    await runCalculations(cart);
  };

  useFocusEffect(
    useCallback(() => {
      loadCartData();
    }, [])
  );

  const runCalculations = async (items: { product: UnifiedProduct; quantity: number }[]) => {
    if (items.length === 0) {
      setCalculations([]);
      setCheapestPlatform(null);
      setSplitSuggestion(null);
      return;
    }

    const calcs = await api.calculateCart(items);
    setCalculations(calcs);

    // Determine cheapest single platform
    const cheapest = calcs.reduce((min, curr) => curr.total < min.total ? curr : min, calcs[0]);
    setCheapestPlatform(cheapest.platform);

    // Calculate smart order split
    await calculateSmartSplit(items, cheapest.total);
  };

  const calculateSmartSplit = async (items: { product: UnifiedProduct; quantity: number }[], cheapestSingleTotal: number) => {
    if (items.length <= 1) {
      setSplitSuggestion(null);
      return;
    }

    const blinkitItems: typeof items = [];
    const swiggyItems: typeof items = [];

    // Allocate each item to the cheapest store for that item
    const allocationPromises = items.map(async (item) => {
      const singleItemCalcs = (await api.calculateCart([item], true)).filter(c => c.items.length > 0);
      if (singleItemCalcs.length === 0) return;

      const cheapestOption = singleItemCalcs.reduce((min, curr) => curr.total < min.total ? curr : min, singleItemCalcs[0]);
      
      const allocatedPlatform = cheapestOption.platform;
      const matchedItem = cheapestOption.items[0]; // item representation on the target platform

      if (allocatedPlatform === 'blinkit') blinkitItems.push(allocatedItemDetail(matchedItem, 'blinkit'));
      else if (allocatedPlatform === 'swiggy') swiggyItems.push(allocatedItemDetail(matchedItem, 'swiggy'));
    });

    await Promise.all(allocationPromises);

    let splitTotal = 0;
    const buckets: any[] = [];

    // Price each bucket through the platform's own cart/bill APIs so every
    // charge (delivery, packaging/convenience, small-cart, tax) is live.
    const addBucket = async (platform: Platform, bucketItems: typeof items) => {
      if (bucketItems.length === 0) return;
      const bucketCalcs = await api.calculateCart(bucketItems);
      const calc = bucketCalcs.find(c => c.platform === platform);
      if (!calc) return;
      splitTotal += calc.total;
      buckets.push({
        platform,
        items: bucketItems,
        total: calc.total,
        delivery: calc.deliveryFee,
        handling: calc.handlingFee,
        smallCart: calc.smallCartFee,
        tax: calc.tax
      });
    };

    await addBucket('blinkit', blinkitItems);
    await addBucket('swiggy', swiggyItems);

    const activeBucketsCount = buckets.filter(b => b.items.length > 0).length;

    // Show suggestion if splitting actually saves money AND we are utilizing more than one store
    if (splitTotal < cheapestSingleTotal && activeBucketsCount > 1) {
      setSplitSuggestion({
        buckets,
        total: splitTotal,
        savings: cheapestSingleTotal - splitTotal
      });
    } else {
      setSplitSuggestion(null);
    }
  };

  // Helper to ensure product platform matches key
  const allocatedItemDetail = (item: { product: UnifiedProduct; quantity: number }, platform: Platform) => {
    return {
      product: {
        ...item.product,
        platform
      },
      quantity: item.quantity
    };
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
    Alert.alert('Clear Cart', 'Empty the comparative optimizer list?', [
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

  const getPlatformMeta = (platform: Platform) => {
    switch (platform) {
      case 'blinkit':
        return { name: 'Blinkit', color: '#F7EC13', bg: '#F7EC13' };
      case 'swiggy':
        return { name: 'Swiggy', color: '#FC8019', bg: '#FC8019' };
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Text style={styles.title}>Cart Optimizer</Text>
          <View style={styles.headerActions}>
            {cartItems.length > 0 && (
              <TouchableOpacity
                onPress={handleRefreshPrices}
                disabled={isRefreshing}
                style={[styles.refreshBtn, isRefreshing && styles.refreshBtnDisabled]}
              >
                {isRefreshing ? (
                  <ActivityIndicator size={14} color="#A78BFA" />
                ) : (
                  <RefreshCw size={14} color="#A78BFA" />
                )}
                <Text style={styles.refreshBtnText}>
                  {isRefreshing ? 'Fetching…' : 'Refresh Prices'}
                </Text>
              </TouchableOpacity>
            )}
            {cartItems.length > 0 && (
              <TouchableOpacity onPress={handleClearCart} style={{ marginLeft: 12 }}>
                <Trash2 size={20} color="#EF4444" />
              </TouchableOpacity>
            )}
          </View>
        </View>
        <Text style={styles.subtitle}>Optimize checking out by comparing subtotals, delivery, and split options</Text>
      </View>

      {cartItems.length === 0 ? (
        <View style={styles.emptyState}>
          <Layers size={48} color="#27273A" style={{ marginBottom: 16 }} />
          <Text style={styles.emptyStateTitle}>Optimizer is Empty</Text>
          <Text style={styles.emptyStateSub}>Add products from the Search tab to compare order checkout calculations.</Text>
        </View>
      ) : (
        <View>
          {/* Cart List */}
          <Text style={styles.sectionTitle}>Selected Items Bundle</Text>
          <View style={styles.cartList}>
            {cartItems.map(({ product, quantity }) => {
              const meta = getPlatformMeta(product.platform);
              return (
                <View key={product.id} style={styles.cartItem}>
                  <Image source={{ uri: product.imageUrl }} style={styles.itemImage} />
                  <View style={styles.itemInfo}>
                    <Text style={styles.itemTitle} numberOfLines={1}>{product.title}</Text>
                    <Text style={styles.itemQuantity}>{product.brand} • {product.quantity}</Text>
                    
                    {/* Platform Tag */}
                    <View style={styles.row}>
                      <View style={[styles.platformDot, { backgroundColor: meta.color }]} />
                      <Text style={styles.platformTagText}>Source: {meta.name}</Text>
                    </View>
                  </View>
                  
                  <View style={styles.qtyContainer}>
                    <TouchableOpacity style={styles.qtyBtn} onPress={() => handleUpdateQuantity(product.id, -1)}>
                      <Minus size={14} color="#FFF" />
                    </TouchableOpacity>
                    <Text style={styles.qtyText}>{quantity}</Text>
                    <TouchableOpacity style={styles.qtyBtn} onPress={() => handleUpdateQuantity(product.id, 1)}>
                      <Plus size={14} color="#FFF" />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>

          {/* Checkout Comparison Cards */}
          <Text style={styles.sectionTitle}>Side-by-Side checkout comparison</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.compareCardsScroll}>
            {calculations.map((calc) => {
              const meta = getPlatformMeta(calc.platform);
              const isCheapest = calc.platform === cheapestPlatform;
              return (
                <View key={calc.platform} style={[styles.compareCard, isCheapest && styles.cheapestCard]}>
                  {isCheapest && (
                    <View style={styles.recommendBadge}>
                      <Zap size={10} color="#000" style={{ marginRight: 4 }} />
                      <Text style={styles.recommendText}>CHEAPEST SINGLE STORE</Text>
                    </View>
                  )}
                  
                  <Text style={[styles.comparePlatform, { color: isCheapest ? '#FFF' : meta.color }]}>
                    {meta.name}
                  </Text>
                  
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLabel}>Subtotal</Text>
                    <Text style={styles.feeValue}>₹{calc.subtotal}</Text>
                  </View>
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLabel}>Delivery Fee</Text>
                    <Text style={[styles.feeValue, calc.deliveryFee === 0 && { color: '#10B981' }]}>
                      {calc.deliveryFee === 0 ? 'FREE' : `₹${calc.deliveryFee}`}
                    </Text>
                  </View>
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLabel}>Packaging/Conv.</Text>
                    <Text style={styles.feeValue}>₹{calc.handlingFee}</Text>
                  </View>
                  {calc.smallCartFee > 0 && (
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLabel}>Small Cart Fee</Text>
                      <Text style={styles.feeValue}>₹{calc.smallCartFee}</Text>
                    </View>
                  )}
                  {calc.surgeFee > 0 && (
                    <View style={styles.feeRow}>
                      <Text style={styles.feeLabel}>Rain Surge</Text>
                      <Text style={[styles.feeValue, { color: '#F59E0B' }]}>₹{calc.surgeFee}</Text>
                    </View>
                  )}
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLabel}>Tax (GST)</Text>
                    {calc.tax > 0 ? (
                      <Text style={styles.feeValue}>₹{calc.tax}</Text>
                    ) : (
                      <Text style={[styles.feeValue, { color: '#6B7280', fontStyle: 'italic', fontSize: 11 }]}>Incl. in price</Text>
                    )}
                  </View>
                  
                  <View style={styles.divider} />
                  
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>Total Checkout</Text>
                    <Text style={[styles.totalValue, { color: isCheapest ? '#10B981' : '#FFF' }]}>
                      ₹{calc.total}
                    </Text>
                  </View>
                  
                  {calc.savings > 0 && (
                    <Text style={styles.savingsText}>Saved ₹{calc.savings} off MRP</Text>
                  )}
                </View>
              );
            })}
          </ScrollView>

          {/* Smart Order Split Suggestion */}
          {splitSuggestion && (
            <View style={styles.splitCard}>
              <View style={styles.splitHeader}>
                <TrendingDown size={20} color="#10B981" />
                <Text style={styles.splitTitle}>💡 Smart Split Recommendation</Text>
              </View>
              <Text style={styles.splitDescription}>
                Splitting this order across multiple stores will save you more money, even after counting delivery fees.
              </Text>
              
              <View style={styles.splitRoute}>
                {splitSuggestion.buckets.map((b: any, index: number) => {
                  const meta = getPlatformMeta(b.platform);
                  return (
                    <View key={b.platform} style={styles.splitBucketItem}>
                      <View style={styles.row}>
                        <View style={[styles.platformDot, { backgroundColor: meta.color }]} />
                        <Text style={styles.bucketName}>{meta.name}</Text>
                      </View>
                      <Text style={styles.bucketDetails}>{b.items.length} items • ₹{b.total}</Text>
                    </View>
                  );
                })}
              </View>
              
              <View style={styles.splitTotalRow}>
                <View>
                  <Text style={styles.splitTotalLabel}>Split Combined Total</Text>
                  <Text style={styles.splitTotalVal}>₹{splitSuggestion.total}</Text>
                </View>
                <View style={styles.savingsBigBadge}>
                  <Text style={styles.savingsBigLabel}>EXTRA SAVINGS</Text>
                  <Text style={styles.savingsBigVal}>- ₹{splitSuggestion.savings}</Text>
                </View>
              </View>
            </View>
          )}

          {/* Direct API order submit warning */}
          <View style={styles.footerNote}>
            <Text style={styles.noteText}>
              Note: Comparify.pro recommends ordering through the respective native quick commerce apps once matching optimization values are generated.
            </Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F12',
  },
  content: {
    padding: 16,
    paddingTop: 48,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 24,
  },
  headerTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#A78BFA',
    backgroundColor: 'rgba(167, 139, 250, 0.1)',
  },
  refreshBtnDisabled: {
    opacity: 0.6,
  },
  refreshBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#A78BFA',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFF',
  },
  subtitle: {
    fontSize: 14,
    color: '#9CA3AF',
    lineHeight: 20,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
  },
  emptyStateTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
    marginBottom: 6,
  },
  emptyStateSub: {
    fontSize: 13,
    color: '#71717A',
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#FFF',
    marginBottom: 12,
    marginTop: 8,
  },
  cartList: {
    backgroundColor: '#16161D',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#22222E',
    padding: 12,
    gap: 12,
    marginBottom: 24,
  },
  cartItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#22222E',
  },
  itemImage: {
    width: 50,
    height: 50,
    borderRadius: 6,
    backgroundColor: '#0F0F12',
  },
  itemInfo: {
    flex: 1,
    marginLeft: 12,
  },
  itemTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#FFF',
    marginBottom: 2,
  },
  itemQuantity: {
    fontSize: 11,
    color: '#71717A',
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  platformDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  platformTagText: {
    fontSize: 10,
    color: '#71717A',
    fontWeight: '500',
  },
  qtyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F0F14',
    borderWidth: 1,
    borderColor: '#2D2D3E',
    borderRadius: 8,
    height: 32,
    paddingHorizontal: 6,
  },
  qtyBtn: {
    padding: 4,
  },
  qtyText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: 'bold',
    paddingHorizontal: 10,
  },
  compareCardsScroll: {
    gap: 12,
    paddingBottom: 10,
    marginBottom: 20,
  },
  compareCard: {
    width: 170,
    backgroundColor: '#16161D',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#22222E',
    padding: 14,
  },
  cheapestCard: {
    borderColor: '#8C31FF',
    borderWidth: 2,
    backgroundColor: '#19132B',
  },
  recommendBadge: {
    backgroundColor: '#F7EC13',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginBottom: 10,
  },
  recommendText: {
    color: '#000',
    fontSize: 7,
    fontWeight: 'bold',
  },
  comparePlatform: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  feeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  feeLabel: {
    fontSize: 11,
    color: '#71717A',
  },
  feeValue: {
    fontSize: 11,
    color: '#E2E8F0',
    fontWeight: '500',
  },
  divider: {
    height: 1,
    backgroundColor: '#22222E',
    marginVertical: 10,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  totalLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#FFF',
  },
  totalValue: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  savingsText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#10B981',
    marginTop: 6,
  },
  splitCard: {
    backgroundColor: '#0F261D',
    borderWidth: 1,
    borderColor: '#194D36',
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  splitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  splitTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#10B981',
    marginLeft: 8,
  },
  splitDescription: {
    fontSize: 12,
    color: '#A7F3D0',
    lineHeight: 18,
    marginBottom: 16,
  },
  splitRoute: {
    backgroundColor: '#061710',
    borderRadius: 8,
    padding: 12,
    gap: 10,
    marginBottom: 16,
  },
  splitBucketItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bucketName: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#FFF',
  },
  bucketDetails: {
    fontSize: 11,
    color: '#A7F3D0',
  },
  splitTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#194D36',
    paddingTop: 14,
  },
  splitTotalLabel: {
    fontSize: 11,
    color: '#A7F3D0',
    marginBottom: 2,
  },
  splitTotalVal: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFF',
  },
  savingsBigBadge: {
    backgroundColor: '#10B981',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignItems: 'center',
  },
  savingsBigLabel: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#000',
  },
  savingsBigVal: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#000',
  },
  footerNote: {
    paddingHorizontal: 8,
    marginBottom: 20,
  },
  noteText: {
    fontSize: 10,
    color: '#4A5568',
    textAlign: 'center',
    lineHeight: 14,
  },
});
