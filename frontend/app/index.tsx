import { SymbolView } from 'expo-symbols';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { providerColors, providerLabels } from '@/data/messages';
import { connectProvider, errorMessage, getConversations, getProviders } from '@/services/api';
import {
  getCachedMutedConversationIds,
  getMutedConversationIds,
  subscribeToMutedConversations,
} from '@/services/muted-conversations';
import { subscribeToRealtimeEvents } from '@/services/realtime';
import type { Conversation, ProviderName, ProviderStatus } from '@/types/messaging';

const INK = '#242320';
const MUTED = '#7B776F';
const PAPER = '#F6F3EC';
const ACCENT = '#B44D32';
const DISCORD_NOTIFICATION = '#DA373C';
const INSTAGRAM_NOTIFICATION = '#0095F6';
const FALLBACK_POLL_INTERVAL_MS = 60_000;

function ConversationNotificationIndicator({ conversation, muted }: { conversation: Conversation; muted: boolean }) {
  if (!conversation.unread || muted) return null;
  if (conversation.provider === 'instagram') {
    return <View accessibilityLabel="Unread Instagram messages" style={styles.instagramUnreadDot} />;
  }

  const count = conversation.notification?.count;
  const accessibilityLabel = conversation.provider === 'merged'
    ? count ? `${count} unread mentions across merged profile` : 'Unread messages across merged profile'
    : count ? `${count} Discord mentions` : 'Unread Discord messages';
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.discordUnreadBadge,
        conversation.provider === 'merged' && styles.mergedUnreadBadge,
        !count && styles.discordUnreadDot,
      ]}>
      {count ? <Text style={styles.discordUnreadCount}>{count > 99 ? '99+' : count}</Text> : null}
    </View>
  );
}

function ConversationRow({ conversation, muted }: { conversation: Conversation; muted: boolean }) {
  const notificationLabel = conversation.unread && !muted
    ? conversation.notification?.count
      ? `, ${conversation.notification.count} unread mentions`
      : ', unread messages'
    : '';
  const mutedLabel = muted ? ', muted' : '';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open conversation with ${conversation.title}${notificationLabel}${mutedLabel}`}
      onPress={() => router.push({ pathname: '/conversation/[id]', params: { id: conversation.id } })}
      style={({ pressed }) => [styles.conversationRow, pressed && styles.rowPressed]}>
      <View>
        <Avatar name={conversation.title} imageUrl={conversation.avatarUrl} size={52} />
        <View style={[styles.providerDot, { backgroundColor: providerColors[conversation.provider] }]} />
      </View>

      <View style={styles.conversationCopy}>
        <View style={styles.rowTopLine}>
          <Text numberOfLines={1} style={[styles.conversationTitle, conversation.unread && !muted && styles.unreadText]}>
            {conversation.title}
          </Text>
          {muted ? (
            <SymbolView name={{ ios: 'bell.slash.fill', android: 'notifications_off', web: 'notifications_off' }} size={15} tintColor={MUTED} />
          ) : null}
          <Text style={[styles.providerName, conversation.unread && !muted && styles.unreadTime]}>
            {conversation.sources?.length
              ? `${conversation.sources.length} sources`
              : providerLabels[conversation.provider]}
          </Text>
        </View>

        <View style={styles.rowBottomLine}>
          <Text numberOfLines={1} style={[styles.preview, conversation.unread && !muted && styles.unreadPreview]}>
            {conversation.preview ?? (conversation.kind === 'group' ? 'Group conversation' : 'Direct message')}
          </Text>
          <ConversationNotificationIndicator conversation={conversation} muted={muted} />
        </View>
      </View>
    </Pressable>
  );
}

function SourceStatus({ status, onConnect }: { status: ProviderStatus; onConnect: (name: ProviderName) => void }) {
  const canConnect = status.state === 'error' || status.state === 'disconnected';
  return (
    <Pressable
      accessibilityRole={canConnect ? 'button' : undefined}
      disabled={!canConnect}
      onPress={() => onConnect(status.name)}
      style={styles.sourceStatus}>
      <View
        style={[
          styles.sourceDot,
          { backgroundColor: status.state === 'connected' ? '#47835D' : status.state === 'error' ? ACCENT : '#A39D93' },
        ]}
      />
      <Text style={styles.sourceText}>
        {providerLabels[status.name]} · {status.state}{canConnect ? ' — tap to connect' : ''}
      </Text>
    </Pressable>
  );
}

export default function InboxScreen() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread' | 'muted'>('all');
  const [mutedConversationIds, setMutedConversationIds] = useState<ReadonlySet<string>>(
    getCachedMutedConversationIds,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState<ProviderName>();
  const [loadError, setLoadError] = useState<string>();
  const requestInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const mounted = useRef(true);
  const { width } = useWindowDimensions();

  useFocusEffect(useCallback(() => {
    let active = true;
    const unsubscribe = subscribeToMutedConversations((conversationIds) => {
      if (active) setMutedConversationIds(conversationIds);
    });
    void getMutedConversationIds().then((conversationIds) => {
      if (active) setMutedConversationIds(conversationIds);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []));

  const loadData = useCallback(async (showRefresh = false) => {
    if (requestInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    requestInFlight.current = true;
    if (showRefresh) setRefreshing(true);

    try {
      do {
        refreshQueued.current = false;
        try {
          const [nextProviders, nextConversations] = await Promise.all([getProviders(), getConversations()]);
          if (!mounted.current) return;
          setProviders(nextProviders);
          setConversations(nextConversations);
          setLoadError(undefined);
        } catch (error) {
          if (mounted.current) setLoadError(errorMessage(error));
        }
      } while (mounted.current && refreshQueued.current);
    } finally {
      requestInFlight.current = false;
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useFocusEffect(useCallback(() => {
    mounted.current = true;
    const initialLoad = setTimeout(() => void loadData(), 0);
    const unsubscribe = subscribeToRealtimeEvents(() => void loadData());
    const poller = setInterval(() => void loadData(), FALLBACK_POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearTimeout(initialLoad);
      clearInterval(poller);
      unsubscribe();
    };
  }, [loadData]));

  const handleConnect = useCallback(async (provider: ProviderName) => {
    setConnecting(provider);
    setLoadError(undefined);
    try {
      await connectProvider(provider);
      await loadData();
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      if (mounted.current) setConnecting(undefined);
    }
  }, [loadData]);

  const visibleConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return conversations.filter((conversation) => {
      const muted = mutedConversationIds.has(conversation.id);
      const matchesFilter = filter === 'all'
        || (filter === 'unread' && conversation.unread && !muted)
        || (filter === 'muted' && muted);
      const matchesQuery = !normalizedQuery
        || conversation.title.toLowerCase().includes(normalizedQuery)
        || conversation.preview?.toLowerCase().includes(normalizedQuery)
        || providerLabels[conversation.provider].toLowerCase().includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [conversations, filter, mutedConversationIds, query]);

  const emptyCopy = loadError
    ? 'Check that the backend is running and that EXPO_PUBLIC_API_URL points to it.'
    : providers.length === 0
      ? 'Add Discord or Instagram credentials to backend/.env, then restart Providence.'
      : 'No conversations match this view yet.';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View style={[styles.page, width > 760 && styles.pageWide]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>PROVIDENCE</Text>
            <Text style={styles.heading}>Messages</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Merge profiles"
              onPress={() => router.push('/merge' as Href)}
              style={({ pressed }) => [styles.mergeButton, pressed && styles.buttonPressed]}>
              <SymbolView name={{ ios: 'person.2', android: 'group_add', web: 'group_add' }} size={20} tintColor={INK} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh conversations"
              onPress={() => void loadData(true)}
              style={({ pressed }) => [styles.refreshButton, pressed && styles.buttonPressed]}>
              <SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} size={20} tintColor={PAPER} />
            </Pressable>
          </View>
        </View>

        {providers.length ? (
          <View style={styles.sources}>
            {providers.map((provider) => <SourceStatus key={provider.name} status={provider} onConnect={handleConnect} />)}
            {connecting ? <ActivityIndicator color={ACCENT} size="small" /> : null}
          </View>
        ) : null}

        {loadError ? (
          <Pressable accessibilityRole="button" onPress={() => void loadData(true)} style={styles.errorBanner}>
            <Text numberOfLines={2} style={styles.errorText}>{loadError}</Text>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}

        <View style={styles.searchWrap}>
          <SymbolView name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }} size={18} tintColor={MUTED} />
          <TextInput
            accessibilityLabel="Search messages"
            onChangeText={setQuery}
            placeholder="Search people and conversations"
            placeholderTextColor="#9A958C"
            returnKeyType="search"
            style={styles.searchInput}
            value={query}
          />
        </View>

        <View style={styles.filters}>
          {(['all', 'unread', 'muted'] as const).map((item) => {
            const active = item === filter;
            return (
              <Pressable key={item} onPress={() => setFilter(item)} style={[styles.filterChip, active && styles.filterChipActive]}>
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {item === 'all' ? 'All messages' : item === 'unread' ? 'Unread' : 'Muted'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.listHeadingRow}>
          <Text style={styles.listHeading}>{filter === 'all' ? 'Conversations' : filter === 'unread' ? 'Unread' : 'Muted'}</Text>
          <Text style={styles.count}>{visibleConversations.length}</Text>
        </View>

        <FlatList
          contentContainerStyle={styles.listContent}
          data={visibleConversations}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void loadData(true)} tintColor={ACCENT} />}
          renderItem={({ item }) => (
            <ConversationRow conversation={item} muted={mutedConversationIds.has(item.id)} />
          )}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              {loading ? <ActivityIndicator color={ACCENT} /> : <Text style={styles.emptyTitle}>All quiet here</Text>}
              {!loading ? <Text style={styles.emptyBody}>{emptyCopy}</Text> : null}
            </View>
          }
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PAPER },
  page: { flex: 1, width: '100%', alignSelf: 'center' },
  pageWide: { maxWidth: 680 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 22, paddingBottom: 16 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mergeButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D5CFC5', backgroundColor: '#FFFCF6' },
  eyebrow: { color: ACCENT, fontSize: 11, fontWeight: '800', letterSpacing: 2.1, marginBottom: 6 },
  heading: { color: INK, fontSize: 34, fontWeight: '700', letterSpacing: -1.2 },
  refreshButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: INK },
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  sources: { minHeight: 28, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, paddingHorizontal: 24, paddingBottom: 14 },
  sourceStatus: { flexDirection: 'row', alignItems: 'center' },
  sourceDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  sourceText: { color: MUTED, fontSize: 11, fontWeight: '600' },
  errorBanner: { marginHorizontal: 24, marginBottom: 12, paddingHorizontal: 13, paddingVertical: 10, borderRadius: 10, backgroundColor: '#F3DDD5', flexDirection: 'row', alignItems: 'center', gap: 10 },
  errorText: { flex: 1, color: '#733520', fontSize: 12, lineHeight: 17 },
  retryText: { color: '#733520', fontSize: 12, fontWeight: '800' },
  searchWrap: { height: 50, marginHorizontal: 24, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#DED9CF', borderRadius: 15, backgroundColor: '#FFFCF6' },
  searchInput: { flex: 1, height: '100%', marginLeft: 10, color: INK, fontSize: 15 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 24, paddingTop: 16 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#EAE5DC' },
  filterChipActive: { backgroundColor: '#D7C0B4' },
  filterText: { color: MUTED, fontSize: 13, fontWeight: '600' },
  filterTextActive: { color: '#733520' },
  listHeadingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 28, paddingBottom: 10 },
  listHeading: { color: MUTED, fontSize: 12, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase' },
  count: { color: MUTED, fontSize: 12, fontWeight: '700' },
  listContent: { paddingHorizontal: 16, paddingBottom: 30, flexGrow: 1 },
  conversationRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 14, borderRadius: 14 },
  rowPressed: { backgroundColor: '#ECE7DE' },
  providerDot: { position: 'absolute', right: -1, bottom: -1, width: 15, height: 15, borderRadius: 8, borderWidth: 3, borderColor: PAPER },
  conversationCopy: { flex: 1, marginLeft: 14, gap: 7 },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBottomLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  conversationTitle: { flex: 1, color: INK, fontSize: 16, fontWeight: '600', letterSpacing: -0.25 },
  unreadText: { fontWeight: '800' },
  providerName: { color: MUTED, fontSize: 12 },
  unreadTime: { color: ACCENT, fontWeight: '700' },
  preview: { flex: 1, color: MUTED, fontSize: 14, lineHeight: 18 },
  unreadPreview: { color: '#4E4B46', fontWeight: '500' },
  instagramUnreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: INSTAGRAM_NOTIFICATION, marginRight: 3 },
  discordUnreadBadge: { minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: DISCORD_NOTIFICATION, marginRight: 1 },
  mergedUnreadBadge: { backgroundColor: ACCENT },
  discordUnreadDot: { minWidth: 10, width: 10, height: 10, paddingHorizontal: 0, borderRadius: 5, marginRight: 3 },
  discordUnreadCount: { color: '#FFFFFF', fontSize: 10, lineHeight: 13, fontWeight: '800' },
  separator: { height: 1, marginLeft: 74, backgroundColor: '#E3DED5' },
  emptyState: { flex: 1, minHeight: 260, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { color: INK, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  emptyBody: { color: MUTED, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
