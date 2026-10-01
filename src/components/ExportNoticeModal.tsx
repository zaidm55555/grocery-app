import React from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react-native';
import { Platform } from '../services/storage';
import { colors, fonts, platformThemes } from '../constants/theme';

export interface ExportNotice {
  platform: Platform;
  outOfStock: { name: string }[];
  clamped: { name: string; requestedQty: number; exportedQty: number }[];
  missing: { name: string }[];
  itemCount: number;
  onContinue: () => void;
}

interface Props {
  notice: ExportNotice | null;
  onCancel: () => void;
}

// Shown before exporting a basket when some lines can't go through as-is
// (out of stock, quantity trimmed to stock, not found on the app).
export default function ExportNoticeModal({ notice, onCancel }: Props) {
  if (!notice) return null;
  const theme = platformThemes[notice.platform];
  const n = notice.itemCount;

  const Section = ({ icon, color, title, children }: { icon: React.ReactNode; color: string; title: string; children: React.ReactNode }) => (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        {icon}
        <Text style={[styles.sectionTitle, { color }]}>{title}</Text>
      </View>
      {children}
    </View>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet} onPress={() => {}}>
          <View style={styles.grabber} />
          <Text style={styles.title}>Before opening {theme.name}</Text>
          <Text style={styles.subtitle}>Some items can’t be added exactly as they are in your basket.</Text>

          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 6 }}>
            {notice.outOfStock.length > 0 && (
              <Section icon={<AlertCircle size={14} color={colors.rose} />} color={colors.rose} title={`Out of stock · skipped (${notice.outOfStock.length})`}>
                {notice.outOfStock.map((o, i) => <Text key={i} style={styles.row} numberOfLines={2}>{o.name}</Text>)}
              </Section>
            )}
            {notice.clamped.length > 0 && (
              <Section icon={<AlertTriangle size={14} color={colors.amber} />} color={colors.amber} title={`Quantity reduced to stock (${notice.clamped.length})`}>
                {notice.clamped.map((c, i) => (
                  <View key={i} style={styles.rowSplit}>
                    <Text style={[styles.row, { flex: 1 }]} numberOfLines={2}>{c.name}</Text>
                    <Text style={styles.qtyChange}>{c.requestedQty} → {c.exportedQty}</Text>
                  </View>
                ))}
              </Section>
            )}
            {notice.missing.length > 0 && (
              <Section icon={<AlertCircle size={14} color={colors.textMuted} />} color={colors.textSecondary} title={`Not found on ${theme.name} · skipped (${notice.missing.length})`}>
                {notice.missing.map((m, i) => <Text key={i} style={styles.row} numberOfLines={2}>{m.name}</Text>)}
              </Section>
            )}
          </ScrollView>

          <View style={styles.summary}>
            <CheckCircle2 size={14} color={colors.emerald} />
            <Text style={styles.summaryText}>{n} in-stock item{n === 1 ? '' : 's'} will be added</Text>
          </View>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel} activeOpacity={0.8}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.continueBtn, { backgroundColor: theme.color }]}
              activeOpacity={0.85}
              onPress={() => { const go = notice.onContinue; onCancel(); go(); }}
            >
              <Text style={[styles.continueText, { color: theme.textColor }]}>Continue to {theme.name}</Text>
            </TouchableOpacity>
          </View>
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
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 22,
    maxHeight: '78%',
  },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', marginBottom: 12 },
  title: { fontSize: 17, fontFamily: fonts.heading, color: colors.textPrimary },
  subtitle: { fontSize: 12.5, fontFamily: fonts.body, color: colors.textSecondary, marginTop: 4, marginBottom: 12 },
  list: { flexGrow: 0 },
  section: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 12,
    padding: 11,
    marginBottom: 9,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  sectionTitle: { fontSize: 12.5, fontFamily: fonts.bodySemiBold },
  row: { fontSize: 13, fontFamily: fonts.body, color: colors.textPrimary, paddingVertical: 3 },
  rowSplit: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  qtyChange: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.amber },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 12 },
  summaryText: { fontSize: 12.5, fontFamily: fonts.bodyMedium, color: colors.textSecondary },
  actions: { flexDirection: 'row', gap: 10 },
  cancelBtn: {
    flex: 1, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: 'rgba(255,255,255,0.04)',
  },
  cancelText: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.textSecondary },
  continueBtn: { flex: 2, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  continueText: { fontSize: 14, fontFamily: fonts.bodySemiBold },
});
