import { SymbolView } from 'expo-symbols';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import {
  conversations,
  getLatestMessage,
  providerColors,
  providerLabels,
} from '@/data/messages';
import type { Conversation } from '@/types/messaging';

const INK = '#242320';
const MUTED = '#7B776F';
const PAPER = '#F6F3EC';
const ACCENT = '#B44D32';

function formatTimestamp(value?: string) {
  if (!value) return '';

  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();

  return sameDay
    ? new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat('en', { weekday: 'short' }).format(date);
}

function ConversationRow({ conversation }: { conversation: Conversation }) {
  const latestMessage = getLatestMessage(conversation.id);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open conversation with ${conversation.title}`}
      onPress={() => router.push({ pathname: '/conversation/[id]', params: { id: conversation.id } })}
      style={({ pressed }) => [styles.conversationRow, pressed && styles.rowPressed]}>
      <View>
        <Avatar name={conversation.title} imageUrl={conversation.avatarUrl} size={52} />
        <View
          style={[
            styles.providerDot,
            { backgroundColor: providerColors[conversation.provider] },
          ]}
        />
      </View>

      <View style={styles.conversationCopy}>
        <View style={styles.rowTopLine}>
          <Text numberOfLines={1} style={[styles.conversationTitle, conversation.unread && styles.unreadText]}>
            {conversation.kind === 'channel' ? '# ' : ''}
            {conversation.title}
          </Text>
          <Text style={[styles.time, conversation.unread && styles.unreadTime]}>
            {formatTimestamp(latestMessage?.sentAt)}
          </Text>
        </View>

        <View style={styles.rowBottomLine}>
          <Text numberOfLines={1} style={[styles.preview, conversation.unread && styles.unreadPreview]}>
            {latestMessage?.author.id === 'me' ? 'You: ' : ''}
            {latestMessage?.content ?? 'No messages yet'}
          </Text>
          {conversation.unread ? <View style={styles.unreadDot} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

export default function InboxScreen() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const { width } = useWindowDimensions();

  const visibleConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return conversations.filter((conversation) => {
      const matchesFilter = filter === 'all' || conversation.unread;
      const matchesQuery =
        !normalizedQuery ||
        conversation.title.toLowerCase().includes(normalizedQuery) ||
        providerLabels[conversation.provider].toLowerCase().includes(normalizedQuery) ||
        conversation.guild?.toLowerCase().includes(normalizedQuery);

      return matchesFilter && matchesQuery;
    });
  }, [filter, query]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View style={[styles.page, width > 760 && styles.pageWide]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>PROVIDENCE</Text>
            <Text style={styles.heading}>Messages</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start a new message"
            style={({ pressed }) => [styles.composeButton, pressed && styles.buttonPressed]}>
            <SymbolView
              name={{ ios: 'square.and.pencil', android: 'edit_square', web: 'edit_square' }}
              size={20}
              tintColor={PAPER}
            />
          </Pressable>
        </View>

        <View style={styles.searchWrap}>
          <SymbolView
            name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
            size={18}
            tintColor={MUTED}
          />
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
          {(['all', 'unread'] as const).map((item) => {
            const active = item === filter;
            return (
              <Pressable
                key={item}
                onPress={() => setFilter(item)}
                style={[styles.filterChip, active && styles.filterChipActive]}>
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {item === 'all' ? 'All messages' : 'Unread'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.listHeadingRow}>
          <Text style={styles.listHeading}>{filter === 'all' ? 'Recent' : 'Unread'}</Text>
          <Text style={styles.count}>{visibleConversations.length}</Text>
        </View>

        <FlatList
          contentContainerStyle={styles.listContent}
          data={visibleConversations}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => <ConversationRow conversation={item} />}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>All quiet here</Text>
              <Text style={styles.emptyBody}>Try another search or switch back to all messages.</Text>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 22,
  },
  eyebrow: { color: ACCENT, fontSize: 11, fontWeight: '800', letterSpacing: 2.1, marginBottom: 6 },
  heading: { color: INK, fontSize: 34, fontWeight: '700', letterSpacing: -1.2 },
  composeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: INK,
  },
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  searchWrap: {
    height: 50,
    marginHorizontal: 24,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DED9CF',
    borderRadius: 15,
    backgroundColor: '#FFFCF6',
  },
  searchInput: { flex: 1, height: '100%', marginLeft: 10, color: INK, fontSize: 15 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 24, paddingTop: 16 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#EAE5DC',
  },
  filterChipActive: { backgroundColor: '#D7C0B4' },
  filterText: { color: MUTED, fontSize: 13, fontWeight: '600' },
  filterTextActive: { color: '#733520' },
  listHeadingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 10,
  },
  listHeading: { color: MUTED, fontSize: 12, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase' },
  count: { color: MUTED, fontSize: 12, fontWeight: '700' },
  listContent: { paddingHorizontal: 16, paddingBottom: 30, flexGrow: 1 },
  conversationRow: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  rowPressed: { backgroundColor: '#ECE7DE' },
  providerDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 15,
    height: 15,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: PAPER,
  },
  conversationCopy: { flex: 1, marginLeft: 14, gap: 7 },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBottomLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  conversationTitle: { flex: 1, color: INK, fontSize: 16, fontWeight: '600', letterSpacing: -0.25 },
  unreadText: { fontWeight: '800' },
  time: { color: MUTED, fontSize: 12 },
  unreadTime: { color: ACCENT, fontWeight: '700' },
  preview: { flex: 1, color: MUTED, fontSize: 14, lineHeight: 18 },
  unreadPreview: { color: '#4E4B46', fontWeight: '500' },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: ACCENT, marginRight: 3 },
  separator: { height: 1, marginLeft: 74, backgroundColor: '#E3DED5' },
  emptyState: { flex: 1, minHeight: 260, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { color: INK, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  emptyBody: { color: MUTED, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
