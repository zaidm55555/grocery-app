import React from 'react';
import { Modal, View, Text, Image, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Minus, Plus, X } from 'lucide-react-native';
import { UnifiedProduct } from '../services/api';
import { colors, fonts, platformThemes } from '../constants/theme';

export interface SharedLine {
  /** Basket line id (the line's own product id). */
  id: string;
  title: string;
  quantity: string;
  imageUrl: string;
  platform: UnifiedProduct['platform'];
  /** Units of the shared listing this line contributes. */
  qty: number;
}

interface Props {
  visible: boolean;
  listing: UnifiedProduct | null;
  lines: SharedLine[];
  total: number;
  onStep: (lineId: string, delta: number) => void;
  onClose: () => void;
}

// One listing on an app can be the auto-match for several basket lines. The
// card can't say which line a tap on +/− means, so this sheet lists each
// line with its own stepper; the card keeps showing the combined total.
export default function SharedListingSheet({ visible, listing, lines, total, onStep, onClose }: Props) {
  if (!listing) return null;
  const theme = platformThemes[listing.platform];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet} onPress={() => {}} testID="shared-listing-sheet">
          <View style={styles.grabber} />
          <View style={styles.headRow}>
            <Image source={{ uri: listing.imageUrl }} style={styles.headImage} resizeMode="contain" />
            <View style={styles.headText}>
              <Text style={styles.title} numberOfLines={2}>{listing.title}</Text>
              <Text style={[styles.subtitle, { color: theme.color }]}>{theme.name} · {total} in basket</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <X size={15} color="#9CA3AF" />
            </TouchableOpacity>
          </View>

          <Text style={styles.heading}>Shared by {lines.length} basket items</Text>
          <Text style={styles.hint}>Each of these was matched to this {theme.name} product. Adjust how many you want for each.</Text>

          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 18 }}>
            {lines.map(l => {
              const lt = platformThemes[l.platform];
              return (
                <View key={l.id} style={styles.row}>
                  <Image source={{ uri: l.imageUrl }} style={styles.rowImage} resizeMode="contain" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={2}>{l.title}</Text>
                    <Text style={[styles.rowSub, { color: lt.color }]}>{lt.name} · {l.quantity}</Text>
                  </View>
                  <View style={styles.stepper}>
                    <TouchableOpacity testID={`shared-minus-${l.id}`} onPress={() => onStep(l.id, -1)} style={styles.stepBtn}>
                      <Minus size={13} color="#FFF" />
                    </TouchableOpacity>
                    <Text style={styles.stepQty}>{l.qty}</Text>
                    <TouchableOpacity testID={`shared-plus-${l.id}`} onPress={() => onStep(l.id, 1)} style={styles.stepBtn}>
                      <Plus size={13} color="#FFF" />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(4, 6, 12, 0.74)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bgCardSolid,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.glassBorder,
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', marginBottom: 12 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  headImage: { width: 44, height: 44, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.05)' },
  headText: { flex: 1 },
  title: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.textPrimary },
  subtitle: { fontFamily: fonts.bodyMedium, fontSize: 11, marginTop: 2 },
  closeBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)' },
  heading: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.textPrimary, marginTop: 14 },
  hint: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.textSecondary, marginTop: 3, marginBottom: 6 },
  list: { maxHeight: 340 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  rowImage: { width: 38, height: 38, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)' },
  rowTitle: { fontFamily: fonts.bodySemiBold, fontSize: 12.5, color: colors.textPrimary },
  rowSub: { fontFamily: fonts.bodyMedium, fontSize: 10.5, marginTop: 2 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 14, paddingHorizontal: 4, paddingVertical: 3 },
  stepBtn: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  stepQty: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.textPrimary, minWidth: 16, textAlign: 'center' },
});
