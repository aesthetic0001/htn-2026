import { SymbolView } from 'expo-symbols';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { providerColors, providerLabels } from '@/data/messages';
import { createProfileMerge, errorMessage, getProfileMergeCandidates } from '@/services/api';
import type { ProfileMergeCandidate } from '@/types/messaging';

const INK = '#242320';
const MUTED = '#7B776F';
const PAPER = '#F6F3EC';
const ACCENT = '#B44D32';

export default function MergeProfilesScreen() {
  const [conversations, setConversations] = useState<ProfileMergeCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const { width } = useWindowDimensions();

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    try {
      setConversations(await getProfileMergeCandidates());
      setLoadError(undefined);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void loadCandidates();
  }, [loadCandidates]));

  const toggle = useCallback((conversation: ProfileMergeCandidate) => {
    if (conversation.assignedToProfileId) return;
    setSelected((current) => current.includes(conversation.id)
      ? current.filter((id) => id !== conversation.id)
      : [...current, conversation.id]);
  }, []);

  const merge = useCallback(async () => {
    if (selected.length < 2 || saving) return;
    setSaving(true);
    setLoadError(undefined);
    try {
      const profile = await createProfileMerge(selected);
      router.replace({ pathname: '/conversation/[id]', params: { id: profile.id } });
    } catch (error) {
      setLoadError(errorMessage(error));
      setSaving(false);
    }
  }, [saving, selected]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <View style={[styles.page, width > 760 && styles.pageWide]}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back to messages"
            hitSlop={10}
            onPress={() => router.back()}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={22} tintColor={INK} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.heading}>Merge profiles</Text>
            <Text style={styles.subheading}>Choose direct messages for the same person</Text>
          </View>
        </View>

        {loadError ? (
          <Pressable onPress={() => void loadCandidates()} style={styles.errorBanner}>
            <Text numberOfLines={2} style={styles.errorText}>{loadError}</Text>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}

        <FlatList
          contentContainerStyle={styles.listContent}
          data={conversations}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const isSelected = selected.includes(item.id);
            const unavailable = Boolean(item.assignedToProfileId);
            return (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected, disabled: unavailable }}
                disabled={unavailable}
                onPress={() => toggle(item)}
                style={({ pressed }) => [styles.row, unavailable && styles.rowUnavailable, pressed && styles.pressed]}>
                <View>
                  <Avatar name={item.title} imageUrl={item.avatarUrl} size={48} />
                  <View style={[styles.providerDot, { backgroundColor: providerColors[item.provider] }]} />
                </View>
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.title}>{item.title}</Text>
                  <Text style={styles.provider}>
                    {providerLabels[item.provider]}{unavailable ? ' · already merged' : ''}
                  </Text>
                </View>
                <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                  {isSelected ? <Text style={styles.checkmark}>✓</Text> : null}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              {loading ? <ActivityIndicator color={ACCENT} /> : <Text style={styles.emptyTitle}>No direct messages available</Text>}
              {!loading ? <Text style={styles.emptyBody}>Connect a provider and load its direct messages first.</Text> : null}
            </View>
          }
        />

        <View style={styles.footer}>
          <Text style={styles.selectionHelp}>
            {selected.length < 2 ? 'Select at least two conversations' : `${selected.length} conversations selected`}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={selected.length < 2 || saving}
            onPress={() => void merge()}
            style={({ pressed }) => [
              styles.mergeButton,
              (selected.length < 2 || saving) && styles.mergeButtonDisabled,
              pressed && styles.pressed,
            ]}>
            {saving ? <ActivityIndicator color="#FFF9F2" /> : <Text style={styles.mergeButtonText}>Merge profiles</Text>}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PAPER },
  page: { flex: 1, width: '100%', alignSelf: 'center' },
  pageWide: { maxWidth: 680, borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#E3DED5' },
  header: { minHeight: 76, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#DED9CF' },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerCopy: { flex: 1, marginLeft: 8 },
  heading: { color: INK, fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  subheading: { color: MUTED, fontSize: 12, marginTop: 3 },
  pressed: { opacity: 0.62, transform: [{ scale: 0.98 }] },
  errorBanner: { marginHorizontal: 18, marginTop: 12, paddingHorizontal: 13, paddingVertical: 10, borderRadius: 10, backgroundColor: '#F3DDD5', flexDirection: 'row', alignItems: 'center', gap: 10 },
  errorText: { flex: 1, color: '#733520', fontSize: 12, lineHeight: 17 },
  retryText: { color: '#733520', fontSize: 12, fontWeight: '800' },
  listContent: { flexGrow: 1, paddingHorizontal: 18, paddingVertical: 12 },
  row: { minHeight: 76, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12, borderRadius: 14 },
  rowUnavailable: { opacity: 0.48 },
  providerDot: { position: 'absolute', right: -1, bottom: -1, width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: PAPER },
  rowCopy: { flex: 1, minWidth: 0, marginLeft: 14 },
  title: { color: INK, fontSize: 16, fontWeight: '600' },
  provider: { color: MUTED, fontSize: 12, marginTop: 5 },
  checkbox: { width: 25, height: 25, borderRadius: 8, borderWidth: 1.5, borderColor: '#BDB7AD', alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { borderColor: ACCENT, backgroundColor: ACCENT },
  checkmark: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  separator: { height: 1, marginLeft: 70, backgroundColor: '#E3DED5' },
  empty: { flex: 1, minHeight: 300, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyTitle: { color: INK, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyBody: { color: MUTED, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 7 },
  footer: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 8, borderTopWidth: 1, borderTopColor: '#DED9CF' },
  selectionHelp: { color: MUTED, fontSize: 12, textAlign: 'center', marginBottom: 8 },
  mergeButton: { minHeight: 50, borderRadius: 15, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  mergeButtonDisabled: { backgroundColor: '#C8C2B9' },
  mergeButtonText: { color: '#FFF9F2', fontSize: 15, fontWeight: '800' },
});
