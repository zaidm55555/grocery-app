import React, { useState, useCallback } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { MapPin, Link2, Link2Off, Compass, Trash2, Key, Info, RefreshCw } from 'lucide-react-native';
import * as Location from 'expo-location';
import { storage, Platform, LocationData } from '../../services/storage';
import { colors, fonts, platformThemes } from '../../constants/theme';
import { api } from '../../services/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

  const loadData = async () => {
    const blinkitToken = await storage.getToken('blinkit');
    const swiggyToken = await storage.getToken('swiggy');
    const userLoc = await storage.getLocation();

    const savedName = await AsyncStorage.getItem('@blinkit_address_name');
    const savedId = await AsyncStorage.getItem('@blinkit_address_id');
    setBlinkitAddressName(savedName);
    setBlinkitAddressId(savedId);

    setTokens({
      blinkit: blinkitToken,
      swiggy: swiggyToken
    });
    setLocation(userLoc);
  };

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
        console.log('[Blinkit Address Object]', JSON.stringify(closest));
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
        setBlinkitAddressName('No Saved Addresses Found');
        setBlinkitAddressId(null);
      }
    } catch (e) {
      console.error(e);
      setBlinkitAddressName('Error Fetching Address');
    } finally {
      setAddrLoading(false);
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

      let loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      let geocode = await Location.reverseGeocodeAsync({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude
      });

      const city = geocode[0]?.city || geocode[0]?.subregion || 'Bengaluru';
      const area = geocode[0]?.street || geocode[0]?.district || 'Central Area';
      const addressString = `${area}, ${city}, ${geocode[0]?.region || ''}`;

      const newLoc = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        address: addressString
      };

      await storage.saveLocation(newLoc);
      setLocation(newLoc);
      
      const bToken = await storage.getToken('blinkit');
      if (bToken) {
        await refreshBlinkitAddress(loc.coords.latitude, loc.coords.longitude);
      }

      Alert.alert('Location Updated', `Coordinates synced for ${city}.`);
    } catch (error) {
      console.error(error);
      Alert.alert('Location Error', 'Failed to retrieve GPS location coordinates.');
    } finally {
      setLocLoading(false);
    }
  };

  const handleManualLocation = async (latStr: string, lngStr: string) => {
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (isNaN(lat) || isNaN(lng)) return;

    const newLoc: LocationData = {
      latitude: lat,
      longitude: lng,
      address: `Manual Coordinates (${lat.toFixed(4)}, ${lng.toFixed(4)})`
    };

    await storage.saveLocation(newLoc);
    setLocation(newLoc);
    
    const bToken = await storage.getToken('blinkit');
    if (bToken) {
      await refreshBlinkitAddress(lat, lng);
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
          <Text style={styles.cardTitle}>Coordinates & Delivery Address</Text>
        </View>
        <Text style={styles.cardDescription}>
          Inventories and pricing are location-dependent. Sync coordinates to get accurate catalog data.
        </Text>

        <View style={styles.locationDisplay}>
          <Text style={styles.locationText} numberOfLines={1}>
            {location?.address || 'No Location Synced'}
          </Text>
          {location && (
            <Text style={styles.coordText}>
              Lat: {location.latitude.toFixed(5)} | Lng: {location.longitude.toFixed(5)}
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

        {/* Manual coordinates inputs */}
        <View style={styles.manualInputs}>
          <View style={styles.inputCol}>
            <Text style={styles.inputLabel}>Latitude</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 12.9716"
              placeholderTextColor="#566079"
              keyboardType="numeric"
              defaultValue={location?.latitude ? String(location.latitude) : ''}
              onEndEditing={(e) => handleManualLocation(e.nativeEvent.text, String(location?.longitude || '77.5946'))}
            />
          </View>
          <View style={styles.inputCol}>
            <Text style={styles.inputLabel}>Longitude</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 77.5946"
              placeholderTextColor="#566079"
              keyboardType="numeric"
              defaultValue={location?.longitude ? String(location.longitude) : ''}
              onEndEditing={(e) => handleManualLocation(String(location?.latitude || '12.9716'), e.nativeEvent.text)}
            />
          </View>
        </View>
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
          <View style={styles.tokenContainer}>
            <View style={styles.row}>
              <Key size={14} color={platformThemes.blinkit.color} />
              <Text style={styles.tokenLabel}>Extracted Token:</Text>
            </View>
            <Text style={styles.tokenText}>{truncateToken(tokens.blinkit)}</Text>
            
            <View style={[styles.row, { marginTop: 8 }]}>
              <MapPin size={14} color={platformThemes.blinkit.color} />
              <Text style={styles.tokenLabel}>Saved Address (Closest):</Text>
            </View>
            <Text style={styles.addressDisplayVal}>
              {blinkitAddressName || 'No saved address found or synced'}
            </Text>
            {blinkitAddressId && (
              <Text style={styles.addressIdVal}>
                ID: {blinkitAddressId}
              </Text>
            )}

            <TouchableOpacity 
              style={[styles.refreshAddrButton, addrLoading && styles.disabledRefreshBtn]} 
              onPress={() => refreshBlinkitAddress(location?.latitude || 12.9716, location?.longitude || 77.5946)}
              disabled={addrLoading}
            >
              {addrLoading ? (
                <ActivityIndicator size="small" color={platformThemes.blinkit.color} />
              ) : (
                <>
                  <RefreshCw size={14} color={platformThemes.blinkit.color} style={{ marginRight: 6 }} />
                  <Text style={[styles.refreshBtnText, { color: platformThemes.blinkit.color }]}>Refresh Saved Address</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity style={[styles.unlinkButton, { marginTop: 16 }]} onPress={() => handleUnlink('blinkit')}>
              <Link2Off size={16} color="#EF4444" style={styles.btnIcon} />
              <Text style={styles.unlinkText}>Disconnect Session</Text>
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
          <View style={styles.tokenContainer}>
            <View style={styles.row}>
              <Key size={14} color={platformThemes.swiggy.color} />
              <Text style={styles.tokenLabel}>Extracted Cookies:</Text>
            </View>
            <Text style={styles.tokenText}>{truncateToken(tokens.swiggy)}</Text>
            <TouchableOpacity style={styles.unlinkButton} onPress={() => handleUnlink('swiggy')}>
              <Link2Off size={16} color="#EF4444" style={styles.btnIcon} />
              <Text style={styles.unlinkText}>Disconnect Session</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.linkButton} onPress={() => handleLink('swiggy')}>
            <Link2 size={16} color="#FFF" style={styles.btnIcon} />
            <Text style={styles.buttonText}>Login to Link Swiggy</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Info Card */}
      <View style={styles.infoCard}>
        <Info size={16} color="#9CA3AF" style={styles.infoIcon} />
        <Text style={styles.infoText}>
          If session keys are missing, the search engine will automatically query high-fidelity simulated listings for testing purposes.
        </Text>
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
    color: colors.textMuted,
    fontFamily: fonts.bodyMedium,
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
  manualInputs: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    gap: 12,
  },
  inputCol: {
    flex: 1,
  },
  inputLabel: {
    fontSize: 11,
    fontFamily: fonts.bodySemiBold,
    color: colors.textMuted,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.bgDark,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 8,
    height: 40,
    paddingHorizontal: 12,
    color: '#FFF',
    fontSize: 13,
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
  infoCard: {
    flexDirection: 'row',
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.25)',
    borderRadius: 8,
    padding: 12,
    marginTop: 16,
    marginBottom: 24,
  },
  infoIcon: {
    marginRight: 10,
    marginTop: 2,
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    color: '#d4af5e',
    lineHeight: 18,
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
