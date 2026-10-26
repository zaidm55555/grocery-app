import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform as RNPlatform } from 'react-native';
import { Sparkles, X, Undo2, RotateCcw, KeyRound, PackageX, Check, AlertCircle } from 'lucide-react-native';
import { colors, fonts, platformThemes } from '../constants/theme';
import { aiProxy } from '../services/aiProxy';
import { buildAiBasket, searchAllStores, AiBasketResult, AiProgress } from '../services/aiMode';
import { GROQ_MODEL, GroqError } from '../services/groq';
import { applyPicks, undoApplied, AppliedLine, MAX_INPUT_CHARS } from '../utils/aiBasket';
import type { CartLine } from '../services/lists';

type Phase = 'input' | 'working' | 'review' | 'error';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Latest basket; read at apply/undo time so it is never a stale copy. */
  getCart: () => CartLine[];
  /** Persists a new basket (the search screen's commitCart). */
  onCommitCart: (cart: CartLine[]) => Promise<void>;
  /** Why AI mode cannot search right now (no location / no linked store), else null. */
  blockedReason?: string | null;
  onViewBasket: () => void;
}

const EXAMPLE = 'Ingredients for dal tadka for 4, a litre of milk, 2 dozen eggs';

function progressLabel(p: AiProgress | null): string {
  if (!p || p.stage === 'parsing') return 'Reading your request…';
  if (p.stage === 'searching') return `Searching stores for ${p.current} (${p.done + 1}/${p.total})…`;
  if (p.stage === 'linking') return `Finding ${p.current} on ${platformThemes[p.platform].name} (${p.done + 1}/${p.total})…`;
  return 'Choosing the best match for each item…';
}

const rupees = (n: number) => `₹${Math.round(n * 100) / 100}`;

export default function AiModeSheet({ visible, onClose, getCart, onCommitCart, blockedReason, onViewBasket }: Props) {
  const [phase, setPhase] = useState<Phase>('input');
  const [text, setText] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [result, setResult] = useState<AiBasketResult | null>(null);
  // applied[i] is what picks[i] put in the basket; null once the user removed it.
  const [applied, setApplied] = useState<(AppliedLine | null)[]>([]);
  const [error, setError] = useState<{ message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    aiProxy.get().then(p => { if (live) setConfigured(!!p); }).catch(() => { if (live) setConfigured(false); });
    return () => { live = false; };
  }, [visible]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setPhase('input');
    setProgress(null);
    setResult(null);
    setApplied([]);
    setError(null);
  };

  const handleClose = () => {
    reset();
    setText('');
    onClose();
  };

  const run = async () => {
    if (busyRef.current || !text.trim() || blockedReason) return;
    busyRef.current = true;
    const proxy = await aiProxy.get().catch(() => null);
    if (!proxy) {
      busyRef.current = false;
      setConfigured(false);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setProgress(null);
    setPhase('working');
    try {
      const res = await buildAiBasket(text, { proxy, search: searchAllStores, onProgress: setProgress, signal: ctrl.signal });
      if (abortRef.current !== ctrl) return;
      const next = applyPicks(getCart(), res.picks);
      if (res.picks.length > 0) await onCommitCart(next.cart);
      setResult(res);
      setApplied(next.applied);
      setPhase('review');
    } catch (e: any) {
      if (abortRef.current !== ctrl || (e instanceof GroqError && e.kind === 'aborted')) return;
      setError({ message: String(e?.message || 'Something went wrong.') });
      setPhase('error');
    } finally {
      // A cancelled run already released these; don't clobber a newer run's state.
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        busyRef.current = false;
      }
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setPhase('input');
  };

  const removeAt = async (i: number) => {
    const entry = applied[i];
    if (!entry || busyRef.current) return;
    busyRef.current = true;
    try {
      await onCommitCart(undoApplied(getCart(), [entry]));
      setApplied(prev => prev.map((a, j) => (j === i ? null : a)));
    } finally {
      busyRef.current = false;
    }
  };

  const addBackAt = async (i: number) => {
    const pick = result?.picks[i];
    if (!pick || applied[i] || busyRef.current) return;
    busyRef.current = true;
    try {
      const next = applyPicks(getCart(), [pick]);
      await onCommitCart(next.cart);
      setApplied(prev => prev.map((a, j) => (j === i ? next.applied[0] : a)));
    } finally {
      busyRef.current = false;
    }
  };

  const undoAll = async () => {
    const entries = applied.filter((a): a is AppliedLine => !!a);
    if (entries.length === 0 || busyRef.current) return;
    busyRef.current = true;
    try {
      await onCommitCart(undoApplied(getCart(), entries));
      setApplied(prev => prev.map(() => null));
    } finally {
      busyRef.current = false;
    }
  };

  const activeCount = applied.filter(a => a && a.added > 0).length;
  const addedValue = (result?.picks || []).reduce((sum, p, i) => sum + (applied[i] ? p.product.price * applied[i]!.added : 0), 0);
  const canRun = !!text.trim() && configured !== false && !blockedReason;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={phase === 'working' ? cancel : handleClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={RNPlatform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <View style={styles.titleRow}>
              <Sparkles size={18} color={colors.accentPrimary} />
              <Text style={styles.sheetTitle}>AI mode</Text>
            </View>
            <TouchableOpacity onPress={handleClose} accessibilityLabel="Close AI mode" hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
            {phase === 'input' && (
              <>
                <Text style={styles.lead}>Describe what you need. We search both stores and add the best match for each item.</Text>

                {configured === false && (
                  <View style={styles.noticeCard}>
                    <KeyRound size={16} color={colors.amber} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.noticeTitle}>AI mode is not configured</Text>
                      <Text style={styles.noticeText}>Set EXPO_PUBLIC_AI_PROXY_URL and EXPO_PUBLIC_AI_PROXY_TOKEN in .env.local and restart the bundler.</Text>
                    </View>
                  </View>
                )}

                {!!blockedReason && (
                  <View style={styles.noticeCard}>
                    <AlertCircle size={16} color={colors.amber} />
                    <Text style={[styles.noticeText, { flex: 1 }]}>{blockedReason}</Text>
                  </View>
                )}

                <TextInput
                  style={styles.input}
                  value={text}
                  onChangeText={setText}
                  placeholder={EXAMPLE}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  maxLength={MAX_INPUT_CHARS}
                  textAlignVertical="top"
                  accessibilityLabel="What do you need?"
                />
                {!text && (
                  <TouchableOpacity style={styles.exampleChip} onPress={() => setText(EXAMPLE)}>
                    <Text style={styles.exampleText} numberOfLines={1}>Try: {EXAMPLE}</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity style={[styles.primaryBtn, !canRun && { opacity: 0.4 }]} disabled={!canRun} onPress={run}>
                  <Sparkles size={16} color="#fff" />
                  <Text style={styles.primaryBtnText}>Build my basket</Text>
                </TouchableOpacity>
                <Text style={styles.footnote}>
                  Your request and the matching store listings are sent through the BasketBuddy AI proxy to Groq ({GROQ_MODEL}). Items are added straight to your basket; you can undo them on the next screen.
                </Text>
              </>
            )}

            {phase === 'working' && (
              <View style={styles.working}>
                <ActivityIndicator color={colors.accentPrimary} />
                <Text style={styles.workingText}>{progressLabel(progress)}</Text>
                <TouchableOpacity style={styles.secondaryBtn} onPress={cancel}>
                  <Text style={styles.secondaryBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}

            {phase === 'error' && error && (
              <View style={styles.working}>
                <AlertCircle size={22} color={colors.rose} />
                <Text style={styles.errorText}>{error.message}</Text>
                <View style={styles.footerRow}>
                  <TouchableOpacity style={styles.secondaryBtn} onPress={() => setPhase('input')}>
                    <Text style={styles.secondaryBtnText}>Try again</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {phase === 'review' && result && (
              <>
                <View style={styles.summaryCard}>
                  <Check size={16} color={colors.emerald} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.summaryTitle}>
                      {activeCount > 0 ? `Added ${activeCount} item${activeCount === 1 ? '' : 's'} to your basket` : 'Nothing added to your basket'}
                    </Text>
                    {activeCount > 0 && (
                      <Text style={styles.summarySub}>About {rupees(addedValue)} at listed prices. Remove anything you don&apos;t want.</Text>
                    )}
                  </View>
                </View>

                {result.picks.map((pick, i) => {
                  const entry = applied[i];
                  const theme = platformThemes[pick.product.platform];
                  const atLimit = !!entry && entry.added === 0;
                  return (
                    <View key={`${pick.index}-${pick.product.id}`} style={[styles.row, !entry && styles.rowRemoved]}>
                      <View style={{ flex: 1 }}>
                        <View style={styles.rowTop}>
                          <View style={[styles.storeChip, { backgroundColor: theme.bgLight, borderColor: theme.borderColor }]}>
                            <Text style={[styles.storeChipText, { color: theme.color }]}>{theme.name}</Text>
                          </View>
                          <Text style={styles.forText} numberOfLines={1}>for {pick.item.name}{pick.item.amount ? ` · ${pick.item.amount}` : ''}</Text>
                        </View>
                        <Text style={styles.rowTitle} numberOfLines={2}>{pick.product.title}</Text>
                        <Text style={styles.rowSub}>
                          {pick.product.quantity ? `${pick.product.quantity} · ` : ''}{rupees(pick.product.price)} × {entry ? entry.added : pick.units}
                        </Text>
                        {!!pick.reason && <Text style={styles.reason} numberOfLines={2}>{pick.reason}</Text>}
                        {atLimit && <Text style={styles.reason}>Already in your basket at its stock limit.</Text>}
                      </View>
                      {entry ? (
                        !atLimit && (
                          <TouchableOpacity style={styles.iconBtn} onPress={() => removeAt(i)} accessibilityLabel={`Remove ${pick.product.title}`}>
                            <Undo2 size={15} color={colors.rose} />
                            <Text style={styles.removeText}>Remove</Text>
                          </TouchableOpacity>
                        )
                      ) : (
                        <TouchableOpacity style={styles.iconBtn} onPress={() => addBackAt(i)} accessibilityLabel={`Add back ${pick.product.title}`}>
                          <RotateCcw size={15} color={colors.accentPrimary} />
                          <Text style={styles.addBackText}>Add back</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}

                {result.unmatched.length > 0 && (
                  <>
                    <View style={styles.sectionHead}>
                      <PackageX size={14} color={colors.textSecondary} />
                      <Text style={styles.sectionLabel}>Not added ({result.unmatched.length})</Text>
                    </View>
                    {result.unmatched.map(u => (
                      <View key={`u-${u.index}`} style={[styles.row, styles.rowMuted]}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.rowTitle} numberOfLines={1}>{u.item.name}{u.item.amount ? ` · ${u.item.amount}` : ''}</Text>
                          <Text style={styles.reason}>{u.reason}</Text>
                        </View>
                      </View>
                    ))}
                  </>
                )}
              </>
            )}
          </ScrollView>

          {phase === 'review' && (
            <View style={styles.footerRow}>
              {activeCount > 0 && (
                <TouchableOpacity style={styles.secondaryBtn} onPress={undoAll}>
                  <Undo2 size={14} color={colors.rose} />
                  <Text style={[styles.secondaryBtnText, { color: colors.rose }]}>Undo all</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.secondaryBtn} onPress={reset}>
                <Text style={styles.secondaryBtnText}>New request</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.primaryBtn, styles.footerPrimary]} onPress={() => { handleClose(); onViewBasket(); }}>
                <Text style={styles.primaryBtnText}>View basket</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
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
    maxHeight: '88%',
    borderWidth: 1,
    borderColor: colors.border,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetTitle: { fontFamily: fonts.headingBold, fontSize: 17, color: colors.textPrimary },
  lead: { fontFamily: fonts.body, fontSize: 12.5, color: colors.textSecondary, lineHeight: 18, marginBottom: 12 },
  noticeCard: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  noticeTitle: { fontFamily: fonts.heading, fontSize: 13, color: colors.textPrimary, marginBottom: 2 },
  noticeText: { fontFamily: fonts.body, fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  input: {
    minHeight: 96,
    fontFamily: fonts.body,
    fontSize: 13.5,
    color: colors.textPrimary,
    backgroundColor: colors.bgTile,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  exampleChip: { marginTop: 8, alignSelf: 'flex-start', maxWidth: '100%', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: colors.borderGlow },
  exampleText: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textSecondary },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.accentPrimary,
    borderRadius: 10,
    height: 44,
    marginTop: 14,
    paddingHorizontal: 14,
  },
  primaryBtnText: { fontFamily: fonts.heading, fontSize: 14, color: '#fff' },
  footnote: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: 10 },
  working: { alignItems: 'center', gap: 12, paddingVertical: 28 },
  workingText: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
  errorText: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.textPrimary, textAlign: 'center', lineHeight: 18 },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgTile,
  },
  secondaryBtnText: { fontFamily: fonts.bodySemiBold, fontSize: 12.5, color: colors.textPrimary },
  footerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingTop: 10 },
  footerPrimary: { flex: 1, marginTop: 0, height: 40 },
  summaryCard: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.25)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  summaryTitle: { fontFamily: fonts.heading, fontSize: 13.5, color: colors.textPrimary },
  summarySub: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textSecondary, marginTop: 2 },
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
  rowRemoved: { opacity: 0.5 },
  rowMuted: { backgroundColor: 'transparent' },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  storeChip: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  storeChipText: { fontFamily: fonts.bodySemiBold, fontSize: 10.5 },
  forText: { flex: 1, fontFamily: fonts.body, fontSize: 11, color: colors.textMuted },
  rowTitle: { fontFamily: fonts.heading, fontSize: 13.5, color: colors.textPrimary },
  rowSub: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  reason: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted, marginTop: 3, lineHeight: 16 },
  iconBtn: { alignItems: 'center', gap: 2, padding: 6 },
  removeText: { fontFamily: fonts.bodySemiBold, fontSize: 10.5, color: colors.rose },
  addBackText: { fontFamily: fonts.bodySemiBold, fontSize: 10.5, color: colors.accentPrimary },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, marginBottom: 8 },
  sectionLabel: { fontFamily: fonts.heading, fontSize: 12.5, color: colors.textSecondary },
});
