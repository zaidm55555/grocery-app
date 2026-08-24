import React, { useState } from 'react';
import { Modal, View, Text, Image, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Check, AlertTriangle, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react-native';
import { Platform } from '../services/storage';
import { UnifiedProduct } from '../services/api';
import { matchScore } from '../utils/matcher';
import { colors, fonts, platformThemes } from '../constants/theme';

export interface MatchTarget {
  id: string;
  name: string;
  unit: string;
  price: number;
  mrp?: number;
  image: string;
}

export interface MatchCell {
  status: 'pending' | 'ok' | 'empty' | 'error';
  candidates: UnifiedProduct[];
  best: UnifiedProduct | null;
  score: number | null;
  error?: string;
}

export interface MatchFlowState {
  step: 'searching' | 'candidates';
  targets: MatchTarget[];
  sourcePlatform: Platform;
  otherPlatforms: Platform[];
  results: Record<string, Partial<Record<Platform, MatchCell>>>;
  // pid -> chosen candidate, 'skip', or undefined (not yet confirmed/default)
  chosen: Record<string, Partial<Record<Platform, { product: UnifiedProduct; score: number } | 'skip'>>>;
}

interface Props {
  flow: MatchFlowState;
  onChoose: (targetId: string, platform: Platform, pick: { product: UnifiedProduct; score: number } | 'skip') => void;
  onRetry: (targetId: string, platform: Platform) => void;
  onSkip: () => void;
  onConfirm: () => void;
}

const LogoTile = ({ platform, size = 30 }: { platform: Platform; size?: number }) => {
  const t = platformThemes[platform];
  return (
    <View style={[logoStyles.tile, {
      width: size,
      height: size,
      borderRadius: size * 0.28,
      backgroundColor: t.bgLight,
      borderColor: t.borderColor,
    }]}>
      <Text style={[logoStyles.letter, { color: t.color, fontSize: size * 0.5 }]}>{t.name[0]}</Text>
    </View>
  );
};

const logoStyles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    backgroundColor: colors.bgCardSolid,
  },
  letter: {
    fontFamily: fonts.headingBold,
  },
});

export default function MatchModal({ flow, onChoose, onRetry, onSkip, onConfirm }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const sourceTheme = platformThemes[flow.sourcePlatform];

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const confirmCount = flow.targets.reduce((n, t) => {
    for (const pid of flow.otherPlatforms) {
      const pick = flow.chosen[t.id]?.[pid];
      if (pick === 'skip') continue;
      // Counts explicit picks AND untouched auto-matches (the best candidate
      // is applied by default when confirming).
      if (pick || flow.results[t.id]?.[pid]?.best) n++;
    }
    return n;
  }, 0);

  const cellStatusSlot = (cell: MatchCell | undefined, tid: string, pid: Platform) => {
    if (!cell || cell.status === 'pending') return <ActivityIndicator size="small" color={colors.accentPrimary} />;
    if (cell.status === 'ok') return <Check size={16} color={colors.emerald} />;
    if (cell.status === 'empty') return <Text style={s.noMatchText}>no match</Text>;
    return (
      <TouchableOpacity style={s.retryPill} onPress={() => onRetry(tid, pid)}>
        <AlertTriangle size={12} color={colors.rose} />
        <Text style={s.retryText}>Retry</Text>
      </TouchableOpacity>
    );
  };

  const candidateRow = (tid: string, pid: Platform, c: { product: UnifiedProduct; score: number }, active: boolean, isAuto: boolean) => (
    <TouchableOpacity
      key={`${c.product.id}-${active}`}
      style={[s.candidateRow, active && s.candidateRowActive]}
      onPress={() => !isAuto && onChoose(tid, pid, c)}
    >
      <Image source={{ uri: c.product.imageUrl }} style={s.candidateImage} />
      <View style={{ flex: 1 }}>
        <Text style={s.candidateName} numberOfLines={2}>{c.product.title}</Text>
        <Text style={s.candidateUnit}>{c.product.quantity}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={s.candidatePrice}>₹{c.product.price}</Text>
        {!!c.score && <Text style={s.scoreText}>{Math.round(c.score * 100)}%</Text>}
      </View>
      {active && <Check size={16} color={colors.emerald} />}
    </TouchableOpacity>
  );

  const resultCard = (t: MatchTarget, pid: Platform) => {
    const cell = flow.results[t.id]?.[pid];
    const chosenPick = flow.chosen[t.id]?.[pid];
    const activeId = typeof chosenPick === 'object' ? chosenPick.product.id : cell?.best?.id;
    const key = `${t.id}:${pid}`;
    const isOpen = !!expanded[key];
    const alternatives = (cell?.candidates || [])
      .filter(c => c.id !== activeId)
      .slice(0, 8)
      .map(c => ({ product: c, score: matchScore(t, c) }));

    return (
      <View key={pid} style={s.resultCard}>
        <View style={s.resultCardHead}>
          <LogoTile platform={pid} />
          <Text style={[s.resultAppName, { color: platformThemes[pid].color }]}>{platformThemes[pid].name}</Text>
          {cell?.status === 'ok' && (
            <View style={s.autoBadge}>
              <Check size={9} color="#000" />
              <Text style={s.autoBadgeText}>
                auto-matched{typeof chosenPick === 'object' && chosenPick.score ? ` · ${Math.round(chosenPick.score * 100)}%` : ''}
              </Text>
            </View>
          )}
          {cell?.status === 'empty' && (
            <View style={[s.autoBadge, { backgroundColor: 'rgba(245, 158, 11, 0.15)' }]}>
              <Text style={[s.autoBadgeText, { color: colors.amber }]}>no close match</Text>
            </View>
          )}
          {cell?.status === 'error' && (
            <View style={[s.autoBadge, { backgroundColor: 'rgba(244, 63, 94, 0.15)' }]}>
              <AlertTriangle size={9} color={colors.rose} />
              <Text style={[s.autoBadgeText, { color: colors.rose }]}>error</Text>
            </View>
          )}
        </View>

        {cell?.status === 'ok' && cell.best && (
          <>
            {candidateRow(t.id, pid, { product: cell.best, score: cell.score || 0 }, true, true)}
            <TouchableOpacity style={s.alternatesToggle} onPress={() => toggle(key)}>
              <Text style={s.alternatesToggleText}>Other matches · {(cell.candidates || []).length - 1 >= 0 ? (cell.candidates || []).length - 1 : 0}</Text>
              {isOpen ? <ChevronUp size={13} color={colors.textMuted} /> : <ChevronDown size={13} color={colors.textMuted} />}
            </TouchableOpacity>
            {isOpen && (
              <View style={s.alternatesList}>
                {alternatives.map(alt => candidateRow(t.id, pid, alt, false, false))}
                <TouchableOpacity style={s.skipAppRow} onPress={() => onChoose(t.id, pid, 'skip')}>
                  <X size={13} color={colors.textSecondary} />
                  <Text style={s.skipAppText}>None of these match — skip this app</Text>
                </TouchableOpacity>
              </View>
            )}
            {chosenPick === 'skip' && (
              <Text style={s.skippedNote}>Skipped — this app won’t be priced for this item.</Text>
            )}
          </>
        )}

        {cell?.status === 'empty' && (
          <>
            <Text style={s.emptyText}>No close match found on {platformThemes[pid].name}.</Text>
            {!isOpen && (
              <TouchableOpacity style={s.pickManuallyPill} onPress={() => toggle(key)}>
                <Text style={s.pickManuallyText}>Pick manually</Text>
              </TouchableOpacity>
            )}
            {isOpen && (
              <View style={s.alternatesList}>
                {(cell.candidates || []).slice(0, 8).map(c => candidateRow(t.id, pid, { product: c, score: matchScore(t, c) }, false, false))}
                <TouchableOpacity style={s.skipAppRow} onPress={() => onChoose(t.id, pid, 'skip')}>
                  <X size={13} color={colors.textSecondary} />
                  <Text style={s.skipAppText}>None of these match — skip this app</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        {cell?.status === 'error' && (
          <View style={s.errorBanner}>
            <AlertTriangle size={14} color={colors.rose} />
            <Text style={s.errorText} numberOfLines={2}>{cell.error || 'Search failed.'} Make sure you’re logged in to {platformThemes[pid].name}, then retry.</Text>
            <TouchableOpacity style={s.retryPill} onPress={() => onRetry(t.id, pid)}>
              <RotateCcw size={12} color={colors.accentPrimary} />
              <Text style={[s.retryText, { color: colors.accentPrimary }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={onSkip}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.header}>
            <View style={[s.headerIcon, { backgroundColor: 'rgba(16, 185, 129, 0.18)' }]}>
              <Check size={18} color={colors.emerald} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>
                {flow.step === 'searching' ? 'Matching on other apps…' : 'Confirm the matches'}
              </Text>
              <Text style={s.subtitle} numberOfLines={1}>
                {flow.targets.length === 1
                  ? `“${flow.targets[0].name}” — ${flow.step === 'searching' ? 'searching the other apps in the background…' : 'review what we found'}`
                  : `${flow.targets.length} items ${flow.step === 'searching' ? 'searching in the background…' : 'ready to confirm'}`}
              </Text>
            </View>
            <TouchableOpacity style={s.closeBtn} onPress={onSkip} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
            {flow.targets.map((t, idx) => (
              <View key={t.id} style={s.targetBlock}>
                <View style={s.targetHead}>
                  <View style={s.indexBubble}><Text style={s.indexText}>{idx + 1}</Text></View>
                  <Image source={{ uri: t.image }} style={s.targetImage} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.targetName} numberOfLines={1}>{t.name}</Text>
                    <Text style={s.targetUnit}>{t.unit} · ₹{t.price}</Text>
                  </View>
                </View>

                {flow.step === 'searching'
                  ? flow.otherPlatforms.map(pid => (
                    <View key={pid} style={s.progressRow}>
                      <LogoTile platform={pid} size={26} />
                      <Text style={s.progressLabel}>Searching {platformThemes[pid].name}…</Text>
                      {cellStatusSlot(flow.results[t.id]?.[pid], t.id, pid)}
                    </View>
                  ))
                  : flow.otherPlatforms.map(pid => resultCard(t, pid))}
              </View>
            ))}
          </ScrollView>

          {flow.step === 'candidates' && (
            <View style={s.footer}>
              <TouchableOpacity style={s.skipBtn} onPress={onSkip}>
                <Text style={s.skipBtnText}>Skip</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onConfirm} disabled={confirmCount === 0} style={{ borderRadius: 12, overflow: 'hidden', opacity: confirmCount === 0 ? 0.5 : 1 }}>
                <LinearGradient
                  colors={sourceTheme.gradient}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={s.confirmBtn}
                >
                  <Text style={[s.confirmBtnText, { color: sourceTheme.textColor }]}>
                    Confirm · {confirmCount} match{confirmCount === 1 ? '' : 'es'}
                  </Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 560,
    backgroundColor: '#0f172a',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: 18,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 14,
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 17,
    color: colors.textPrimary,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  targetBlock: {
    marginBottom: 16,
    backgroundColor: colors.bgTile,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  targetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  indexBubble: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accentPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indexText: {
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    color: '#FFF',
  },
  targetImage: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: colors.imageBg,
  },
  targetName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.textPrimary,
  },
  targetUnit: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
  },
  progressLabel: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textSecondary,
  },
  noMatchText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.amber,
  },
  retryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
  },
  retryText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    color: colors.accentPrimary,
  },
  resultCard: {
    marginTop: 8,
  },
  resultCardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  resultAppName: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 12,
    flex: 1,
  },
  autoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  autoBadgeText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 9,
    color: colors.emerald,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 9,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 6,
  },
  candidateRowActive: {
    borderColor: 'rgba(16, 185, 129, 0.45)',
    backgroundColor: 'rgba(16, 185, 129, 0.07)',
  },
  candidateImage: {
    width: 44,
    height: 44,
    borderRadius: 9,
    backgroundColor: colors.imageBg,
  },
  candidateName: {
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
    color: colors.textPrimary,
  },
  candidateUnit: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 1,
  },
  candidatePrice: {
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    color: colors.textPrimary,
  },
  scoreText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 10,
    color: colors.emerald,
  },
  alternatesToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  alternatesToggleText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.textMuted,
  },
  alternatesList: {
    marginTop: 4,
  },
  skipAppRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 9,
    paddingHorizontal: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(244, 63, 94, 0.25)',
    marginBottom: 6,
  },
  skipAppText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    color: colors.textSecondary,
  },
  skippedNote: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  pickManuallyPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
  },
  pickManuallyText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    color: colors.amber,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(244, 63, 94, 0.08)',
    borderColor: 'rgba(244, 63, 94, 0.3)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 9,
  },
  errorText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.rose,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  skipBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  skipBtnText: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 13,
    color: colors.textSecondary,
  },
  confirmBtn: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  confirmBtnText: {
    fontFamily: fonts.heading,
    fontSize: 13,
  },
});
