import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert } from 'react-native';
import { Bookmark, History, Trash2, X, Plus } from 'lucide-react-native';
import { lists, SavedList, RecentOrder, CartLine } from '../services/lists';
import { colors, fonts } from '../constants/theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Current basket, used by "Save current basket". */
  cartItems: CartLine[];
  /** Called with the new cart after a list/order is loaded into it. */
  onCartChanged: (cart: CartLine[]) => void;
}

const unitCount = (items: CartLine[]) => items.reduce((n, i) => n + i.quantity, 0);

const ago = (ts: number) => {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

export default function SavedListsModal({ visible, onClose, cartItems, onCartChanged }: Props) {
  const [saved, setSaved] = useState<SavedList[]>([]);
  const [recent, setRecent] = useState<RecentOrder[]>([]);
  const [name, setName] = useState('');

  const refresh = useCallback(async () => {
    const [l, r] = await Promise.all([lists.getAll(), lists.getRecent()]);
    setSaved(l);
    setRecent(r);
  }, []);

  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the draft each time the sheet opens
      setName('');
      refresh();
    }
  }, [visible, refresh]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || cartItems.length === 0) return;
    const overwrite = saved.some(l => l.name.toLowerCase() === trimmed.toLowerCase());
    const doSave = async () => {
      await lists.save(trimmed, cartItems);
      setName('');
      await refresh();
    };
    if (overwrite) {
      Alert.alert('Replace list?', `"${trimmed}" already exists. Replace it with the current basket?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', onPress: doSave },
      ]);
    } else {
      await doSave();
    }
  };

  const load = (items: CartLine[], label: string) => {
    const apply = async (replace: boolean) => {
      const next = replace ? await lists.replaceCart(items) : await lists.addToCart(items);
      onCartChanged(next);
      onClose();
    };
    if (cartItems.length === 0) {
      apply(true);
      return;
    }
    Alert.alert(`Load ${label}`, 'Add these items to your current basket, or replace it?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Add to basket', onPress: () => apply(false) },
      { text: 'Replace', style: 'destructive', onPress: () => apply(true) },
    ]);
  };

  const confirmDelete = (l: SavedList) => {
    Alert.alert('Delete list', `Delete "${l.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await lists.remove(l.id); await refresh(); } },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Lists & Buy Again</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
            {cartItems.length > 0 && (
              <View style={styles.saveRow}>
                <TextInput
                  style={styles.input}
                  value={name}
                  onChangeText={setName}
                  placeholder="Name this basket, e.g. Weekly staples"
                  placeholderTextColor={colors.textMuted}
                  maxLength={40}
                  returnKeyType="done"
                  onSubmitEditing={handleSave}
                />
                <TouchableOpacity
                  style={[styles.saveBtn, !name.trim() && { opacity: 0.4 }]}
                  disabled={!name.trim()}
                  onPress={handleSave}
                >
                  <Plus size={16} color="#fff" />
                  <Text style={styles.saveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.sectionHead}>
              <Bookmark size={14} color={colors.textSecondary} />
              <Text style={styles.sectionLabel}>Saved lists</Text>
            </View>
            {saved.length === 0 ? (
              <Text style={styles.empty}>No saved lists yet. Build a basket, name it above and save it for next time.</Text>
            ) : saved.map(l => (
              <View key={l.id} style={styles.row}>
                <TouchableOpacity style={{ flex: 1 }} onPress={() => load(l.items, `"${l.name}"`)}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{l.name}</Text>
                  <Text style={styles.rowSub}>
                    {l.items.length} item{l.items.length === 1 ? '' : 's'} · {unitCount(l.items)} units · {ago(l.updatedAt)}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => confirmDelete(l)} style={styles.iconBtn}>
                  <Trash2 size={15} color={colors.rose} />
                </TouchableOpacity>
              </View>
            ))}

            <View style={[styles.sectionHead, { marginTop: 18 }]}>
              <History size={14} color={colors.textSecondary} />
              <Text style={styles.sectionLabel}>Recently ordered</Text>
            </View>
            {recent.length === 0 ? (
              <Text style={styles.empty}>Baskets you export to Blinkit or Instamart show up here for one-tap reorder.</Text>
            ) : recent.map(r => (
              <TouchableOpacity key={r.id} style={styles.row} onPress={() => load(r.items, 'order')}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {r.items.slice(0, 3).map(i => i.product.title).join(', ')}{r.items.length > 3 ? ` +${r.items.length - 3}` : ''}
                  </Text>
                  <Text style={styles.rowSub}>
                    {r.items.length} item{r.items.length === 1 ? '' : 's'} · {r.platform === 'swiggy' ? 'Instamart' : 'Blinkit'} · {ago(r.orderedAt)}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bgCardSolid,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 18,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: colors.border,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  sheetTitle: { fontFamily: fonts.headingBold, fontSize: 17, color: colors.textPrimary },
  saveRow: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  input: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textPrimary,
    backgroundColor: colors.bgTile,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accentPrimary,
    borderRadius: 10,
    paddingHorizontal: 14,
  },
  saveBtnText: { fontFamily: fonts.heading, fontSize: 13, color: '#fff' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  sectionLabel: { fontFamily: fonts.heading, fontSize: 12.5, color: colors.textSecondary },
  empty: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgTile,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    gap: 8,
  },
  rowTitle: { fontFamily: fonts.heading, fontSize: 13.5, color: colors.textPrimary },
  rowSub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textSecondary, marginTop: 2 },
  iconBtn: { padding: 6 },
});
