import React from 'react';
import { Modal, View, Text, Image, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Plus, X } from 'lucide-react-native';
import { Platform } from '../services/storage';
import { UnifiedProduct } from '../services/api';
import { colors, fonts, platformThemes } from '../constants/theme';

interface Props {
  visible: boolean;
  base: UnifiedProduct | null;
  options: UnifiedProduct[];
  qtyFor: (p: UnifiedProduct) => number;
  onPick: (p: UnifiedProduct) => void;
  onClose: () => void;
}

// Pack-size / listing picker — tap a search card to see every listing of the
// same product for that app and add exactly the one you want.
export default function VariantPickerModal({ visible, base, options, qtyFor, onPick, onClose }: Props) {
  if (!base) return null;

  const theme = platformThemes[base.platform];
  const multiApp = new Set(options.map(o => o.platform)).size > 1;
  const orderedApps: Platform[] = multiApp
    ? [base.platform, ...(['blinkit', 'swiggy'] as Platform[]).filter(pl => pl !== base.platform)]
    : [base.platform];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet} onPress={() => {}}>
          <View style={styles.grabber} />

          {/* Header */}
          <View style={styles.headRow}>
            <Image source={{ uri: base.imageUrl }} style={styles.headImage} resizeMode="contain" />
            <View style={styles.headText}>
              <Text style={styles.title} numberOfLines={2}>{base.title}</Text>
              <Text style={[styles.subtitle, { color: theme.color }]}>
                {theme.name} · {options.length} size{options.length === 1 ? '' : 's'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <X size={15} color="#9CA3AF" />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.list}
            contentContainerStyle={{ paddingBottom: 18 }}
            keyboardShouldPersistTaps="handled"
          >
            {orderedApps.filter(pl => options.some(o => o.platform === pl)).map(pl => {
              const tt = platformThemes[pl];
              const rows = options.filter(o => o.platform === pl);
              return (
                <View key={pl}>
                  {multiApp && (
                    <View style={styles.sectionHead}>
                      <View style={[styles.sectionDot, { backgroundColor: tt.color }]} />
                      <Text style={[styles.sectionTitle, { color: tt.color }]}>{tt.name}</Text>
                    </View>
                  )}
                  {rows.map(opt => {
                    const qty = qtyFor(opt);
                    const discount = opt.originalPrice && opt.originalPrice > opt.price
                      ? Math.round(((opt.originalPrice - opt.price) / opt.originalPrice) * 100)
                      : 0;
                    const isBase = opt.id === base.id;
                    return (
                      <TouchableOpacity
                        key={opt.id}
                        style={[styles.optRow, isBase && styles.optRowBase]}
                        onPress={() => onPick(opt)}
                        activeOpacity={0.75}
                      >
                        <View>
                          <Image source={{ uri: opt.imageUrl }} style={styles.optImage} resizeMode="contain" />
                          {qty > 0 && (
                            <View style={styles.qtyBadge}>
                              <Text style={styles.qtyBadgeText}>×{qty}</Text>
                            </View>
                          )}
                        </View>

                        <View style={styles.optInfo}>
                          <Text style={styles.optName} numberOfLines={2}>{opt.title}</Text>
                          <Text style={styles.optUnit} numberOfLines={1}>{opt.quantity}</Text>
                        </View>

                        <View style={styles.priceCol}>
                          <Text style={styles.optPrice}>₹{opt.price}</Text>
                          {(!!opt.originalPrice && opt.originalPrice > opt.price) || discount > 0 ? (
                            <View style={styles.mrpRow}>
                              {!!opt.originalPrice && opt.originalPrice > opt.price && (
                                <Text style={styles.optMrp}>₹{opt.originalPrice}</Text>
                              )}
                              {discount > 0 && <Text style={styles.optDisc}>{discount}%</Text>}
                            </View>
                          ) : (
                            <View style={styles.mrpSpacer} />
                          )}
                          <View style={[styles.addChip, { backgroundColor: tt.bgLight, borderColor: tt.borderColor }]}>
                            <Plus size={11} color={tt.color} strokeWidth={2.6} />
                            <Text style={[styles.addChipText, { color: tt.color }]}>ADD</Text>
                          </View>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
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
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(4, 6, 12, 0.74)',
    justifyContent: 'flex-end',
  },
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
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginBottom: 12,
  },

  // Header
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  headImage: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  headText: {
    flex: 1,
    flexShrink: 1,
  },
  title: {
    color: '#FFF',
    fontFamily: fonts.headingBold,
    fontSize: 14.5,
    lineHeight: 19,
  },
  subtitle: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    marginTop: 3,
    letterSpacing: 0.2,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  list: {
    maxHeight: 430,
    marginTop: 12,
  },

  // Sections (only rendered when options span multiple apps)
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    marginBottom: 8,
  },
  sectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  sectionTitle: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    letterSpacing: 0.6,
  },

  // Option rows — image | info | price column
  optRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    marginBottom: 8,
    minHeight: 72,
  },
  optRowBase: {
    borderColor: 'rgba(99, 102, 241, 0.55)',
    backgroundColor: 'rgba(99, 102, 241, 0.09)',
  },
  optImage: {
    width: 52,
    height: 52,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  qtyBadge: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    minWidth: 20,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: colors.emerald,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.bgCardSolid,
  },
  qtyBadgeText: {
    color: '#04140d',
    fontFamily: fonts.bodyBold,
    fontSize: 9.5,
  },
  optInfo: {
    flex: 1,
    flexShrink: 1,
    justifyContent: 'center',
  },
  optName: {
    color: '#E7EBF3',
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    lineHeight: 17,
  },
  optUnit: {
    color: '#8B93A7',
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    marginTop: 3,
  },
  priceCol: {
    width: 82,
    alignItems: 'flex-end',
    justifyContent: 'center',
    flexShrink: 0,
  },
  optPrice: {
    color: '#FFF',
    fontFamily: fonts.headingBold,
    fontSize: 14.5,
  },
  mrpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
    height: 13,
  },
  mrpSpacer: {
    height: 13,
    marginTop: 2,
  },
  optMrp: {
    color: '#6B7280',
    fontFamily: fonts.bodyMedium,
    fontSize: 10.5,
    textDecorationLine: 'line-through',
  },
  optDisc: {
    color: colors.emerald,
    fontFamily: fonts.bodySemiBold,
    fontSize: 9.5,
  },
  addChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 4.5,
    borderRadius: 9,
    borderWidth: 1,
    marginTop: 5,
  },
  addChipText: {
    fontFamily: fonts.bodyBold,
    fontSize: 10,
    letterSpacing: 0.4,
  },
});
