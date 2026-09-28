import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import { storage } from './storage';

export interface AddressSyncState {
  isSyncing: boolean;
  lastSyncedAt?: number;
}

type SyncListener = (isSyncing: boolean) => void;

let isSyncingState = false;
let currentSyncPromise: Promise<void> | null = null;
let lastSyncedLat: number | null = null;
let lastSyncedLng: number | null = null;
let lastSyncedAt = 0;
const listeners = new Set<SyncListener>();

type LocationResetListener = () => void;
const resetListeners = new Set<LocationResetListener>();

export function isAddressSyncing(): boolean {
  return isSyncingState;
}

export function subscribeAddressSync(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeLocationReset(listener: LocationResetListener): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

export function notifyLocationReset() {
  resetListeners.forEach(fn => {
    try {
      fn();
    } catch (e) {
      console.error('[AddressSync] Location reset listener error:', e);
    }
  });
}

function setSyncing(syncing: boolean) {
  isSyncingState = syncing;
  listeners.forEach(fn => {
    try {
      fn(syncing);
    } catch (e) {
      console.error('[AddressSync] Listener error:', e);
    }
  });
}

/**
 * Returns a promise that resolves once any in-flight address sync is completed.
 * If no sync is currently running, resolves immediately.
 */
export async function waitForAddressSync(): Promise<void> {
  if (!isSyncingState || !currentSyncPromise) {
    return Promise.resolve();
  }
  return currentSyncPromise;
}

/**
 * Pulls the latest delivery address details for both Blinkit and Swiggy
 * matching the given GPS coordinates.
 * Ensures search and pricing wait until both platforms finish resolving.
 */
export async function syncDeliveryAddresses(lat: number, lng: number, force = false): Promise<void> {
  // If an address sync is already in flight, return the active promise (prevents duplicate runs)
  if (currentSyncPromise) {
    return currentSyncPromise;
  }

  // Deduplicate calls for the same coordinates unless force is true
  if (
    !force &&
    lastSyncedLat !== null &&
    lastSyncedLng !== null &&
    Math.abs(lat - lastSyncedLat) < 0.005 &&
    Math.abs(lng - lastSyncedLng) < 0.005 &&
    Date.now() - lastSyncedAt < 24 * 3600 * 1000
  ) {
    return Promise.resolve();
  }

  const syncOp = async () => {
    setSyncing(true);
    if (force) {
      notifyLocationReset();
    }
    console.log(`[AddressSync] >>> START pulling address details for GPS (${lat.toFixed(5)}, ${lng.toFixed(5)})${force ? ' [FORCE FRESH]' : ''}`);

    try {
      const [blinkitToken, swiggyToken] = await Promise.all([
        storage.getToken('blinkit'),
        storage.getToken('swiggy')
      ]);

      const tasks: Promise<any>[] = [];

      if (blinkitToken) {
        tasks.push(
          (async () => {
            try {
              console.log('[AddressSync] Fetching Blinkit addresses for location...');
              const closest = await api.getClosestBlinkitAddress(lat, lng, force);
              if (closest && closest.id) {
                const addrText =
                  closest.display_address ||
                  closest.address_string ||
                  closest.address ||
                  closest.line1 ||
                  closest.text ||
                  closest.display_text ||
                  (closest.house_number ? `${closest.house_number}, ${closest.line2 || ''}` : '') ||
                  'Unnamed Address';
                const aLat = closest.latitude || closest.lat;
                const aLng = closest.longitude || closest.lon || closest.lng;

                await AsyncStorage.setItem('@blinkit_address_id', String(closest.id));
                await AsyncStorage.setItem('@blinkit_address_name', addrText);
                if (aLat && aLng) {
                  await AsyncStorage.setItem('@blinkit_lat', String(aLat));
                  await AsyncStorage.setItem('@blinkit_lng', String(aLng));
                }
                console.log(`[AddressSync] Blinkit address resolved: ID ${closest.id} - "${addrText}"`);
              } else {
                console.log('[AddressSync] Blinkit: No saved address found within 35km.');
                await AsyncStorage.removeItem('@blinkit_address_id');
                await AsyncStorage.removeItem('@blinkit_address_name');
                await AsyncStorage.removeItem('@blinkit_lat');
                await AsyncStorage.removeItem('@blinkit_lng');
              }
            } catch (err) {
              console.error('[AddressSync] Error fetching Blinkit address:', err);
            }
          })()
        );
      } else {
        console.log('[AddressSync] Blinkit not logged in, skipping address pull.');
      }

      if (swiggyToken) {
        tasks.push(
          (async () => {
            try {
              console.log('[AddressSync] Fetching Swiggy addresses for location...');
              const resolved = await api.resolveSwiggyDeliveryAddress(lat, lng, force);
              if (resolved?.id) {
                console.log(
                  `[AddressSync] Swiggy address resolved: ID ${resolved.id} - "${resolved.name || 'Unnamed'}" (${resolved.distanceKm ?? 0} km away)`
                );
              } else {
                console.log('[AddressSync] Swiggy: No saved address found within 35km.');
              }
            } catch (err) {
              console.error('[AddressSync] Error fetching Swiggy address:', err);
            }
          })()
        );
      } else {
        console.log('[AddressSync] Swiggy not logged in, skipping address pull.');
      }

      // Add a safety timeout of 12 seconds so sync cannot block the app indefinitely
      const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 12000));
      await Promise.race([Promise.allSettled(tasks), timeoutPromise]);

      lastSyncedLat = lat;
      lastSyncedLng = lng;
      lastSyncedAt = Date.now();

      console.log(`[AddressSync] <<< COMPLETED pulling address details. Search is now unblocked.`);
    } catch (err) {
      console.error('[AddressSync] Unexpected sync error:', err);
    } finally {
      setSyncing(false);
      currentSyncPromise = null;
    }
  };

  currentSyncPromise = syncOp();
  return currentSyncPromise;
}
