import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, Text, TextInput, FlatList, TouchableOpacity, ActivityIndicator, Image, Keyboard, KeyboardAvoidingView, Platform as RNPlatform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Search, MapPin, X, Plus, Filter, ShieldCheck, HelpCircle } from 'lucide-react-native';
import { api, UnifiedProduct } from '../../services/api';
import { storage, Platform, LocationData } from '../../services/storage';

const QUICK_SEARCHES = ['Milk', 'Bread', 'Eggs', 'Butter', 'Cheese'];

export default function SearchScreen() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [products, setProducts] = useState<UnifiedProduct[]>([]);
  const [location, setLocation] = useState<LocationData | null>(null);
  const [cartItems, setCartItems] = useState<{ product: UnifiedProduct; quantity: number }[]>([]);
  
  // Filtering & Sorting
  const [activePlatform, setActivePlatform] = useState<Platform | 'all'>('all');
  const [sortBy, setSortBy] = useState<'price_asc' | 'price_desc'>('price_asc');

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
    try {
      const results = await api.search(searchTerm);
      setProducts(results);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
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

  const handleAddToCart = async (product: UnifiedProduct) => {
    const existingIndex = cartItems.findIndex(item => item.product.id === product.id);
    let updatedCart = [...cartItems];

    if (existingIndex > -1) {
      updatedCart[existingIndex].quantity += 1;
    } else {
      updatedCart.push({ product, quantity: 1 });
    }

    setCartItems(updatedCart);
    await storage.saveCart(updatedCart);
    
    // Call the direct api add hook
    await api.addToCart(product.platform, product.originalId || product.id, 1);
  };

  // Filter & Sort products
  const processedProducts = products
    .filter(p => activePlatform === 'all' || p.platform === activePlatform)
    .sort((a, b) => {
      if (sortBy === 'price_asc') return a.price - b.price;
      return b.price - a.price;
    });

  const getPlatformStyle = (platform: Platform) => {
    switch (platform) {
      case 'blinkit':
        return { color: '#F7EC13', bg: 'rgba(247, 236, 19, 0.08)', border: '#A3990A' };
      case 'swiggy':
        return { color: '#FC8019', bg: 'rgba(252, 128, 25, 0.1)', border: '#FC8019' };
    }
  };

  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={RNPlatform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Top Location Bar */}
      <View style={styles.locationBar}>
        <MapPin size={16} color="#8C31FF" />
        <Text style={styles.locationText} numberOfLines={1}>
          {location?.address || 'Pin delivery location in Accounts Tab'}
        </Text>
      </View>

      {/* Search Header */}
      <View style={styles.searchSection}>
        <View style={styles.searchBox}>
          <Search size={20} color="#71717A" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search groceries (e.g. Milk, Bread)"
            placeholderTextColor="#71717A"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => performSearch(query)}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={handleClear} style={styles.clearBtn}>
              <X size={18} color="#71717A" />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={styles.searchBtn} onPress={() => performSearch(query)}>
          <Text style={styles.searchBtnText}>Search</Text>
        </TouchableOpacity>
      </View>

      {/* Main Content */}
      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#8C31FF" />
          <Text style={styles.loadingText}>Fetching comparative catalog prices...</Text>
          <Text style={styles.loadingSubtext}>Querying Blinkit & Swiggy APIs directly</Text>
        </View>
      ) : products.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>Order Price Optimizer</Text>
          <Text style={styles.emptySubtitle}>Compare items side-by-side and optimize your shopping cart</Text>
          
          <Text style={styles.quickSearchLabel}>Quick Search:</Text>
          <View style={styles.quickSearchContainer}>
            {QUICK_SEARCHES.map((term) => (
              <TouchableOpacity
                key={term}
                style={styles.quickSearchChip}
                onPress={() => handleQuickSearch(term)}
              >
                <Text style={styles.quickSearchText}>{term}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {/* Controls Bar */}
          <View style={styles.controlsBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}>
              <TouchableOpacity 
                style={[styles.filterChip, activePlatform === 'all' && styles.filterChipActive]}
                onPress={() => setActivePlatform('all')}
              >
                <Text style={[styles.filterChipText, activePlatform === 'all' && styles.filterChipTextActive]}>All Stores</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.filterChip, activePlatform === 'blinkit' && styles.filterChipActive]}
                onPress={() => setActivePlatform('blinkit')}
              >
                <Text style={[styles.filterChipText, activePlatform === 'blinkit' && styles.filterChipTextActive]}>Blinkit</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.filterChip, activePlatform === 'swiggy' && styles.filterChipActive]}
                onPress={() => setActivePlatform('swiggy')}
              >
                <Text style={[styles.filterChipText, activePlatform === 'swiggy' && styles.filterChipTextActive]}>Swiggy</Text>
              </TouchableOpacity>
            </ScrollView>

            <TouchableOpacity 
              style={styles.sortToggle}
              onPress={() => setSortBy(sortBy === 'price_asc' ? 'price_desc' : 'price_asc')}
            >
              <Filter size={14} color="#A0AEC0" style={{ marginRight: 6 }} />
              <Text style={styles.sortText}>
                {sortBy === 'price_asc' ? 'Price: Low to High' : 'Price: High to Low'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Results List */}
          <FlatList
            data={processedProducts}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const theme = getPlatformStyle(item.platform);
              return (
                <View style={styles.productCard}>
                  <Image source={{ uri: item.imageUrl }} style={styles.productImage} />
                  
                  <View style={styles.productInfo}>
                    <View style={styles.row}>
                      <View style={[styles.platformPill, { backgroundColor: theme.bg, borderColor: theme.border }]}>
                        <Text style={[styles.platformPillText, { color: theme.color }]}>
                          {item.platform.toUpperCase()}
                        </Text>
                      </View>
                      
                      {item.isSimulated ? (
                        <View style={styles.badgeContainer}>
                          <HelpCircle size={12} color="#A0AEC0" />
                          <Text style={styles.simulatedText}>Simulated</Text>
                        </View>
                      ) : (
                        <View style={styles.badgeContainer}>
                          <ShieldCheck size={12} color="#10B981" />
                          <Text style={[styles.simulatedText, { color: '#10B981' }]}>Direct API</Text>
                        </View>
                      )}
                    </View>

                    <Text style={styles.productTitle} numberOfLines={2}>{item.title}</Text>
                    <Text style={styles.productQuantity}>{item.brand} • {item.quantity}</Text>

                    <View style={styles.priceRow}>
                      <Text style={styles.priceText}>₹{item.price}</Text>
                      {item.originalPrice && item.originalPrice > item.price && (
                        <Text style={styles.mrpText}>₹{item.originalPrice}</Text>
                      )}
                    </View>
                  </View>

                  <TouchableOpacity 
                    style={styles.addBtn}
                    onPress={() => handleAddToCart(item)}
                  >
                    <Plus size={18} color="#FFF" />
                  </TouchableOpacity>
                </View>
              );
            }}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

// Reusable horizontal ScrollView wrapper for filters in styles
import { ScrollView } from 'react-native';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F12',
    paddingTop: 48,
  },
  locationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#16161D',
    borderBottomWidth: 1,
    borderBottomColor: '#22222E',
  },
  locationText: {
    color: '#E2E8F0',
    fontSize: 12,
    fontWeight: '500',
    marginLeft: 8,
    flex: 1,
  },
  searchSection: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161D',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#22222E',
    paddingHorizontal: 12,
    height: 46,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#FFF',
    fontSize: 14,
    height: '100%',
  },
  clearBtn: {
    padding: 4,
  },
  searchBtn: {
    backgroundColor: '#8C31FF',
    borderRadius: 10,
    height: 46,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBtnText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
  },
  loadingSubtext: {
    color: '#71717A',
    fontSize: 12,
    marginTop: 6,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 80,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#FFF',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#71717A',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
  },
  quickSearchLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#718096',
    marginBottom: 12,
  },
  quickSearchContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickSearchChip: {
    backgroundColor: '#1E1E2A',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#2D2D3F',
  },
  quickSearchText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '500',
  },
  controlsBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#22222E',
  },
  filterScroll: {
    flexDirection: 'row',
    flexGrow: 0,
    marginRight: 10,
  },
  filterChip: {
    backgroundColor: '#16161D',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#22222E',
  },
  filterChipActive: {
    backgroundColor: '#8C31FF',
    borderColor: '#8C31FF',
  },
  filterChipText: {
    color: '#A0AEC0',
    fontSize: 11,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#FFF',
  },
  sortToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161D',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#22222E',
  },
  sortText: {
    color: '#A0AEC0',
    fontSize: 11,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  productCard: {
    backgroundColor: '#16161D',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#22222E',
    flexDirection: 'row',
    padding: 12,
    alignItems: 'center',
  },
  productImage: {
    width: 76,
    height: 76,
    borderRadius: 8,
    backgroundColor: '#0F0F12',
  },
  productInfo: {
    flex: 1,
    marginLeft: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  platformPill: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  platformPillText: {
    fontSize: 8,
    fontWeight: 'bold',
  },
  badgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  simulatedText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#A0AEC0',
  },
  productTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#FFF',
    marginBottom: 4,
  },
  productQuantity: {
    fontSize: 11,
    color: '#71717A',
    marginBottom: 6,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  priceText: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#FFF',
  },
  mrpText: {
    fontSize: 12,
    color: '#71717A',
    textDecorationLine: 'line-through',
    marginLeft: 8,
  },
  addBtn: {
    backgroundColor: '#8C31FF',
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
});
