import React, { useState, useCallback, useEffect } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { MapPin, Link2, Link2Off, Compass, Trash2, Key, RefreshCw, CheckCircle2 } from 'lucide-react-native';
import * as Location from 'expo-location';
import { storage, Platform, LocationData } from '../../services/storage';
import { colors, fonts, platformThemes } from '../../constants/theme';
import { api } from '../../services/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveAreaName, getFastLocation } from '../../utils/location';
import { syncDeliveryAddresses, subscribeAddressSync, notifyLocationReset } from '../../services/addressSync';

export default function ProfileScreen() {
  const router = useRouter();
  const [tokens, setTokens] = useState<Record<Platform, string | null>>({
    blinkit: null,
    swiggy: null
  });
  const [location, setLocation] = useState<LocationData | null>(null);
  const [locLoading, setLocLoading] = useState(false);
  const [blinkitAddressName, setBlinkitAddressName] = useState<string | null>(null);
  const [blinkitAddressId, setBlinkitAddressId] = useState<string | null>(null);
  const [addrLoading, setAddrLoading] = useState(false);
  const [swiggyAddressName, setSwiggyAddressName] = useState<string | null>(null);
  const [swiggyAddressId, setSwiggyAddressId] = useState<string | null>(null);
  const [swiggyAddressLocation, setSwiggyAddressLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [swiggyAddrLoading, setSwiggyAddrLoading] = useState(false);

  const loadData = async () => {
    const blinkitToken = await storage.getToken('blinkit');
    const swiggyToken = await storage.getToken('swiggy');
    const userLoc = await storage.getLocation();

    const savedName = await AsyncStorage.getItem('@blinkit_address_name');
    const savedId = await AsyncStorage.getItem('@blinkit_address_id');
    setBlinkitAddressName(savedName);
    setBlinkitAddressId(savedId);

    setSwiggyAddressName(null);
    setSwiggyAddressId(null);
    setSwiggyAddressLocation(null);
    try {
      const swiggyAddrJson = await AsyncStorage.getItem('@swiggy_address');
      if (swiggyAddrJson) {
        const parsed = JSON.parse(swiggyAddrJson);
        setSwiggyAddressName(parsed?.name || null);
        setSwiggyAddressId(parsed?.id || null);
        setSwiggyAddressLocation(parsed?.location || null);
      }
    } catch {}

    setTokens({
      blinkit: blinkitToken,
      swiggy: swiggyToken
    });
    setLocation(userLoc);
    if (userLoc) {

      // Auto-resolve human-readable area name if current address is empty or "Manual: ..."
      if (!userLoc.address || userLoc.address.startsWith('Manual:')) {
        resolveAreaName(userLoc.latitude, userLoc.longitude).then(async (resolvedArea) => {
          if (resolvedArea && !resolvedArea.startsWith('Manual:')) {
            const updatedLoc = { ...userLoc, address: resolvedArea };
            await storage.saveLocation(updatedLoc);
            setLocation(updatedLoc);
          }
        }).catch(() => {});
      }
    }
  };

  useEffect(() => {
    const unsub = subscribeAddressSync((syncing) => {
      if (!syncing) {
        loadData();
      }
    });
    return () => unsub();
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
      // Re-check after a short delay to catch tokens saved during navigation transitions
      const timer = setTimeout(loadData, 500);
      return () => clearTimeout(timer);
    }, [])
  );

  const refreshBlinkitAddress = async (lat: number, lng: number) => {
    const hasToken = await storage.getToken('blinkit');
    if (!hasToken) return;
    setAddrLoading(true);
    try {
      const closest = await api.getClosestBlinkitAddress(lat, lng);
      if (closest) {
        const addrText = closest.display_address 
          || closest.address_string 
          || closest.address 
          || closest.line1 
          || closest.text 
          || closest.display_text 
          || (closest.house_number ? `${closest.house_number}, ${closest.line2 || ''}` : '')
          || 'Unnamed Address';
        const aLat = closest.latitude || closest.lat;
        const aLng = closest.longitude || closest.lon || closest.lng;
        
        setBlinkitAddressName(addrText);
        setBlinkitAddressId(String(closest.id));
        await AsyncStorage.setItem('@blinkit_address_id', String(closest.id));
        await AsyncStorage.setItem('@blinkit_address_name', addrText);
        if (aLat && aLng) {
          await AsyncStorage.setItem('@blinkit_lat', String(aLat));
          await AsyncStorage.setItem('@blinkit_lng', String(aLng));
        }
      } else {
        setBlinkitAddressName('No Saved Address in this Area');
        setBlinkitAddressId(null);
        await AsyncStorage.removeItem('@blinkit_address_id');
        await AsyncStorage.removeItem('@blinkit_address_name');
        await AsyncStorage.removeItem('@blinkit_lat');
        await AsyncStorage.removeItem('@blinkit_lng');
      }
    } catch (e) {
      console.error(e);
      setBlinkitAddressName('Error Fetching Address');
    } finally {
      setAddrLoading(false);
    }
  };

  const refreshSwiggyAddress = async (lat: number, lng: number) => {
    const hasToken = await storage.getToken('swiggy');
    if (!hasToken) return;
    setSwiggyAddrLoading(true);
    try {
      const resolved = await api.resolveSwiggyDeliveryAddress(lat, lng, true);
      if (resolved?.id) {
        setSwiggyAddressName(resolved.name);
        setSwiggyAddressId(resolved.id);
        setSwiggyAddressLocation(resolved.location);
      } else {
        setSwiggyAddressName('No Saved Address in this Area');
        setSwiggyAddressId(null);
        setSwiggyAddressLocation(null);
      }
    } catch (e) {
      console.error(e);
      setSwiggyAddressName('Error Fetching Address');
      setSwiggyAddressId(null);
      setSwiggyAddressLocation(null);
    } finally {
      setSwiggyAddrLoading(false);
    }
  };

  const handleLink = (platform: Platform) => {
    router.push({
      pathname: '/webview',
      params: { platform }
    });
  };

  const handleUnlink = async (platform: Platform) => {
    Alert.alert(
      'Unlink Account',
      `Are you sure you want to disconnect your ${platform.toUpperCase()} account?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await storage.removeToken(platform);
            loadData();
          }
        }
      ]
    );
  };

  const fetchGPSLocation = async () => {
    setLocLoading(true);
    try {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Allow location access to sync store inventories near you.');
        setLocLoading(false);
        return;
      }

      const coords = await getFastLocation();
      if (!coords) {
        Alert.alert('Location Error', 'Unable to retrieve GPS coordinates. Please ensure GPS is enabled.');
        setLocLoading(false);
        return;
      }

      const areaName = await resolveAreaName(coords.latitude, coords.longitude);

      const newLoc = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        address: areaName
      };

      await storage.saveLocation(newLoc);
      setLocation(newLoc);
      notifyLocationReset();

      // Force fresh address pull for the newly fetched GPS coordinates
      await syncDeliveryAddresses(coords.latitude, coords.longitude, true);
      await loadData();
      setLocLoading(false);

      Alert.alert('Location & Addresses Synced', `Location and delivery addresses synced for ${areaName}.`);
    } catch (error) {
      console.error(error);
      Alert.alert('Location Error', 'Failed to retrieve GPS location.');
      setLocLoading(false);
    }
  };

  const clearAllData = async () => {
    Alert.alert(
      'Reset Application',
      'This will erase all extracted session tokens and stored configurations.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset Everything',
          style: 'destructive',
          onPress: async () => {
            await storage.clearAll();
            loadData();
          }
        }
      ]
    );
  };

  const truncateToken = (token: string | null) => {
    if (!token) return '';
    if (token.length < 20) return token;
    return `${token.substring(0, 10)}...${token.substring(token.length - 10)}`;
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Account Integration</Text>
        <Text style={styles.subtitle}>Link sessions to extract tokens and run raw JSON fetches</Text>
      </View>

      {/* Location card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <MapPin size={20} color={colors.accentSecondary} />
          <Text style={styles.cardTitle}>Delivery Location</Text>
        </View>
        <Text style={styles.cardDescription}>
          Inventories and pricing are location-dependent. Sync your location to get accurate catalog data.
        </Text>

        <View style={styles.locationDisplay}>
          <Text style={styles.locationText} numberOfLines={1}>
            {location?.address || 'No Location Synced'}
          </Text>
          {location && (
            <Text style={styles.coordText}>
              GPS: {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
            </Text>
          )}
        </View>

        <TouchableOpacity 
          style={[styles.primaryButton, locLoading && styles.disabledButton]} 
          onPress={fetchGPSLocation}
          disabled={locLoading}
        >
          {locLoading ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Compass size={18} color="#FFF" style={styles.btnIcon} />
              <Text style={styles.buttonText}>Fetch Current GPS Location</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Platform Cards */}
      <Text style={styles.sectionTitle}>Link Platform Accounts</Text>


      {/* Blinkit */}
      <View style={[styles.card, styles.platformCard]}>
        <View style={styles.platformHeader}>
          <View style={styles.row}>
            <View style={[styles.colorBadge, { backgroundColor: platformThemes.blinkit.color }]} />
            <Text style={styles.platformName}>Blinkit</Text>
          </View>
          {tokens.blinkit ? (
            <View style={styles.statusBadge}>
              <Text style={styles.statusTextActive}>ACTIVE SESSION</Text>
            </View>
          ) : (
            <View style={[styles.statusBadge, styles.inactiveBadge]}>
              <Text style={styles.statusTextInactive}>NOT LINKED</Text>
            </View>
          )}
        </View>
        
        {tokens.blinkit ? (
          <View style={styles.connectedCard}>
            <View style={styles.connectedHeader}>
              <View style={styles.statusIndicatorRow}>
                <View style={styles.onlineDot} />
                <Text style={styles.connectedTitle}>Connected & Active</Text>
              </View>
              <View style={styles.statusBadge}>
                <CheckCircle2 size={11} color="#10B981" style={{ marginRight: 4 }} />
                <Text style={styles.statusTextActive}>LOGGED IN</Text>
              </View>
            </View>

            <Text style={styles.connectedDesc}>
              Blinkit session is linked. Live store inventory, catalog pricing, and 1-click cart export are active.
            </Text>

            <TouchableOpacity style={styles.unlinkButton} onPress={() => handleUnlink('blinkit')}>
              <Link2Off size={15} color="#EF4444" style={styles.btnIcon} />
              <Text style={styles.unlinkText}>Disconnect Account</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.linkButton} onPress={() => handleLink('blinkit')}>
            <Link2 size={16} color="#FFF" style={styles.btnIcon} />
            <Text style={styles.buttonText}>Login to Link Blinkit</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Swiggy Instamart */}
      <View style={[styles.card, styles.platformCard]}>
        <View style={styles.platformHeader}>
          <View style={styles.row}>
            <View style={[styles.colorBadge, { backgroundColor: '#FC8019' }]} />
            <Text style={styles.platformName}>Swiggy Instamart</Text>
          </View>
          {tokens.swiggy ? (
            <View style={styles.statusBadge}>
              <Text style={styles.statusTextActive}>ACTIVE SESSION</Text>
            </View>
          ) : (
            <View style={[styles.statusBadge, styles.inactiveBadge]}>
              <Text style={styles.statusTextInactive}>NOT LINKED</Text>
            </View>
          )}
        </View>
        
        {tokens.swiggy ? (
          <View style={styles.connectedCard}>
            <View style={styles.connectedHeader}>
              <View style={styles.statusIndicatorRow}>
                <View style={styles.onlineDot} />
                <Text style={styles.connectedTitle}>Connected & Active</Text>
              </View>
              <View style={styles.statusBadge}>
                <CheckCircle2 size={11} color="#10B981" style={{ marginRight: 4 }} />
                <Text style={styles.statusTextActive}>LOGGED IN</Text>
              </View>
            </View>

            <Text style={styles.connectedDesc}>
              Swiggy Instamart session is linked. Live store inventory, catalog pricing, and 1-click cart export are active.
            </Text>

            <TouchableOpacity style={styles.unlinkButton} onPress={() => handleUnlink('swiggy')}>
              <Link2Off size={15} color="#EF4444" style={styles.btnIcon} />
              <Text style={styles.unlinkText}>Disconnect Account</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.linkButton} onPress={() => handleLink('swiggy')}>
            <Link2 size={16} color="#FFF" style={styles.btnIcon} />
            <Text style={styles.buttonText}>Login to Link Swiggy</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Clear configuration */}
      <TouchableOpacity style={styles.clearAllBtn} onPress={clearAllData}>
        <Trash2 size={16} color="#EF4444" style={styles.btnIcon} />
        <Text style={styles.clearText}>Reset App Data</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDark,
  },
  content: {
    padding: 16,
    paddingTop: 48,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontFamily: fonts.headingBold,
    color: colors.textPrimary,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13.5,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  card: {
    backgroundColor: 'rgba(18,26,44,0.85)',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    marginBottom: 20,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardTitle: {
    fontSize: 15,
    fontFamily: fonts.heading,
    color: colors.textPrimary,
    marginLeft: 8,
  },
  cardDescription: {
    fontSize: 12.5,
    fontFamily: fonts.body,
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: 16,
  },
  locationDisplay: {
    backgroundColor: colors.bgDark,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    marginBottom: 12,
  },
  locationText: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
    color: colors.textPrimary,
    marginBottom: 4,
  },
  coordText: {
    fontSize: 11,
    fontFamily: fonts.body,
    color: colors.textMuted,
  },
  primaryButton: {
    backgroundColor: colors.accentSecondary,
    flexDirection: 'row',
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledButton: {
    backgroundColor: '#3f3366',
  },
  btnIcon: {
    marginRight: 8,
  },
  buttonText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontFamily: fonts.bodySemiBold,
  },
  sectionTitle: {
    fontSize: 16,
    fontFamily: fonts.heading,
    color: colors.textPrimary,
    marginBottom: 12,
    marginTop: 8,
  },
  platformCard: {
    marginBottom: 12,
  },
  platformHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  colorBadge: {
    width: 6,
    height: 18,
    borderRadius: 3,
    marginRight: 10,
  },
  platformName: {
    fontSize: 15,
    fontFamily: fonts.heading,
    color: colors.textPrimary,
  },
  statusBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  inactiveBadge: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.2)',
  },
  statusTextActive: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#10B981',
  },
  statusTextInactive: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#EF4444',
  },
  linkButton: {
    backgroundColor: 'rgba(139,92,246,0.14)',
    flexDirection: 'row',
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(139,92,246,0.35)',
  },
  connectedCard: {
    backgroundColor: colors.bgDark,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  connectedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
    marginRight: 8,
  },
  connectedTitle: {
    fontSize: 13.5,
    fontFamily: fonts.bodySemiBold,
    color: colors.textPrimary,
  },
  connectedDesc: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.textSecondary,
    lineHeight: 17,
    marginBottom: 14,
  },
  tokenContainer: {
    backgroundColor: colors.bgDark,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  tokenLabel: {
    fontSize: 11,
    color: colors.textMuted,
    marginLeft: 6,
  },
  tokenText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontFamily: fonts.bodyMedium,
    marginTop: 6,
    marginBottom: 12,
  },
  unlinkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  unlinkText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '600',
  },
  clearAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: 20,
  },
  clearText: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '600',
  },
  addressDisplayVal: {
    fontSize: 13,
    color: colors.textPrimary,
    fontFamily: fonts.bodyMedium,
    marginTop: 6,
    lineHeight: 18,
  },
  addressIdVal: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: fonts.body,
    marginTop: 4,
  },
  refreshAddrButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 36,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 192, 0, 0.3)',
    backgroundColor: 'rgba(255, 192, 0, 0.05)',
    marginTop: 12,
    marginBottom: 6,
  },
  refreshBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  disabledRefreshBtn: {
    opacity: 0.5,
  },
});
