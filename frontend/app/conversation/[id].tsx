import { SymbolView } from 'expo-symbols';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
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
import { currentUser, providerColors, providerLabels } from '@/data/messages';
import {
  addReaction,
  deleteMessage,
  deleteProfileMerge,
  errorMessage,
  getConversations,
  getMessages,
  sendMessage,
  setProfileSendOverride,
} from '@/services/api';
import {
  realtimeConversationId,
  subscribeToRealtimeEvents,
} from '@/services/realtime';
import {
  getCachedMutedConversationIds,
  getMutedConversationIds,
  setConversationMuted,
  subscribeToMutedConversations,
} from '@/services/muted-conversations';
import type { Conversation, Message, SendMessageInput } from '@/types/messaging';

const INK = '#242320';
const MUTED = '#7B776F';
const PAPER = '#F6F3EC';
const ACCENT = '#B44D32';
const FALLBACK_POLL_INTERVAL_MS = 60_000;

function messageTime(value: string) {
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function MessageItem({
  deleting,
  message,
  onDelete,
  onReact,
  showProvider,
}: {
  deleting: boolean;
  message: Message;
  onDelete: (message: Message) => void;
  onReact: (messageId: string, emoji: string) => void;
  showProvider: boolean;
}) {
  const mine = message.author.id === currentUser.id || message.author.displayName === currentUser.displayName;
  const metadata = [message.sentAt ? messageTime(message.sentAt) : undefined, message.edited ? 'edited' : undefined]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.messageRow, mine && styles.messageRowMine]}>
      {!mine ? <Avatar name={message.author.displayName} imageUrl={message.author.avatarUrl} size={34} /> : null}
      <View style={[styles.messageColumn, mine && styles.messageColumnMine]}>
        {!mine ? <Text style={styles.author}>{message.author.displayName}</Text> : null}
        {showProvider ? <Text style={[styles.messageProvider, mine && styles.messageProviderMine]}>{providerLabels[message.provider]}</Text> : null}
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
          {message.content ? <Text style={[styles.messageText, mine && styles.messageTextMine]}>{message.content}</Text> : null}

          {message.attachments.map((attachment) => (
            <Pressable
              accessibilityRole="link"
              key={attachment.url}
              onPress={() => void Linking.openURL(attachment.url)}
              style={({ pressed }) => [styles.attachment, mine && styles.attachmentMine, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'doc', android: 'draft', web: 'draft' }} size={17} tintColor={mine ? '#F9E9E2' : ACCENT} />
              <View style={styles.attachmentText}>
                <Text numberOfLines={1} style={[styles.attachmentName, mine && styles.messageTextMine]}>{attachment.name}</Text>
                <Text style={[styles.attachmentType, mine && styles.attachmentTypeMine]}>Open attachment</Text>
              </View>
            </Pressable>
          ))}

          {metadata || mine ? (
            <View style={styles.bubbleFooter}>
              {metadata ? (
                <Text style={[styles.messageTime, mine && styles.messageTimeMine]}>{metadata}</Text>
              ) : null}
              {mine ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Delete message"
                  disabled={deleting}
                  hitSlop={7}
                  onPress={() => onDelete(message)}
                  style={({ pressed }) => [styles.deleteButton, pressed && styles.deleteButtonPressed]}>
                  {deleting
                    ? <ActivityIndicator color="#E8C5BB" size="small" />
                    : <SymbolView name={{ ios: 'trash', android: 'delete', web: 'delete' }} size={14} tintColor="#E8C5BB" />}
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>

        {message.reactions.length ? (
          <View style={[styles.reactions, mine && styles.reactionsMine]}>
            {message.reactions.map((reaction) => (
              <Pressable
                key={reaction.emoji}
                accessibilityLabel={`React with ${reaction.emoji}`}
                onPress={() => onReact(message.id, reaction.emoji)}
                style={({ pressed }) => [styles.reaction, pressed && styles.reactionPressed]}>
                <Text style={styles.reactionText}>{reaction.emoji} {reaction.count ?? 1}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export default function ConversationScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const conversationId = Array.isArray(params.id) ? params.id[0] : params.id;
  const [conversation, setConversation] = useState<Conversation>();
  const [thread, setThread] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [deletingMessageIds, setDeletingMessageIds] = useState<ReadonlySet<string>>(new Set());
  const [updatingRoute, setUpdatingRoute] = useState(false);
  const [updatingMute, setUpdatingMute] = useState(false);
  const [showRouteSettings, setShowRouteSettings] = useState(false);
  const [mutedConversationIds, setMutedConversationIds] = useState<ReadonlySet<string>>(
    getCachedMutedConversationIds,
  );
  const [loadError, setLoadError] = useState<string>();
  const requestInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const mounted = useRef(true);
  const { width } = useWindowDimensions();
  const muted = conversationId ? mutedConversationIds.has(conversationId) : false;

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

  const refreshThread = useCallback(async (showRefresh = false) => {
    if (!conversationId) return;
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
          const messages = await getMessages(conversationId, 100, true);
          if (!mounted.current) return;
          setThread(messages);
          setLoadError(undefined);
        } catch (error) {
          if (mounted.current) setLoadError(errorMessage(error));
        }
      } while (mounted.current && refreshQueued.current);
    } finally {
      requestInFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, [conversationId]);

  const loadConversation = useCallback(async () => {
    if (!conversationId) {
      setLoading(false);
      return;
    }
    if (requestInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    requestInFlight.current = true;
    setLoading(true);
    try {
      do {
        refreshQueued.current = false;
        try {
          const [conversations, messages] = await Promise.all([
            getConversations(),
            getMessages(conversationId, 100, true),
          ]);
          if (!mounted.current) return;
          setConversation(conversations.find((item) => item.id === conversationId));
          setThread(messages);
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
  }, [conversationId]);

  useFocusEffect(useCallback(() => {
    mounted.current = true;
    const initialLoad = setTimeout(() => void loadConversation(), 0);
    const unsubscribe = subscribeToRealtimeEvents((event) => {
      if (event.type === 'ready') {
        void loadConversation();
      } else if (conversationId?.startsWith('profile:') || realtimeConversationId(event) === conversationId) {
        void refreshThread();
      }
    });
    const poller = setInterval(() => void loadConversation(), FALLBACK_POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearTimeout(initialLoad);
      clearInterval(poller);
      unsubscribe();
    };
  }, [conversationId, loadConversation, refreshThread]));

  const subtitle = useMemo(() => {
    if (!conversation) return '';
    if (!conversation.sources?.length) return providerLabels[conversation.provider];
    return conversation.sources.map(({ provider }) => providerLabels[provider]).join(' + ');
  }, [conversation]);

  const sendRouteLabel = useMemo(() => {
    if (!conversation?.sources?.length) return conversation ? providerLabels[conversation.provider] : '';
    const override = conversation.sources.find(({ conversationId: id }) => id === conversation.sendConversationId);
    return override ? providerLabels[override.provider] : 'most frequented source';
  }, [conversation]);

  const handleSend = useCallback(async () => {
    const input: SendMessageInput = { content: draft.trim() };
    if (!conversationId || !input.content || sending) return;

    setSending(true);
    setLoadError(undefined);
    try {
      const sent = await sendMessage(conversationId, input);
      setThread((current) => current.some((message) => message.id === sent.id) ? current : [...current, sent]);
      setDraft('');
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      if (mounted.current) setSending(false);
    }
  }, [conversationId, draft, sending]);

  const handleReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!conversationId) return;
    setThread((current) => current.map((message) => message.id !== messageId ? message : {
      ...message,
      reactions: message.reactions.map((reaction) => reaction.emoji === emoji
        ? { ...reaction, count: (reaction.count ?? 1) + 1 }
        : reaction),
    }));
    try {
      const sourceConversationId = thread.find(({ id }) => id === messageId)?.conversationId ?? conversationId;
      await addReaction(sourceConversationId, messageId, emoji);
    } catch (error) {
      setLoadError(errorMessage(error));
      await refreshThread();
    }
  }, [conversationId, refreshThread, thread]);

  const performDelete = useCallback(async (message: Message) => {
    if (!conversationId || deletingMessageIds.has(message.id)) return;
    setDeletingMessageIds((current) => new Set(current).add(message.id));
    setLoadError(undefined);
    try {
      await deleteMessage(conversationId, message.id);
      setThread((current) => current.filter(({ id }) => id !== message.id));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      if (mounted.current) {
        setDeletingMessageIds((current) => {
          const next = new Set(current);
          next.delete(message.id);
          return next;
        });
      }
    }
  }, [conversationId, deletingMessageIds]);

  const confirmDelete = useCallback((message: Message) => {
    const detail = `This will unsend it from ${providerLabels[message.provider]} for everyone.`;
    if (Platform.OS === 'web') {
      if (globalThis.confirm(`Delete this message?\n\n${detail}`)) void performDelete(message);
      return;
    }
    Alert.alert(
      'Delete this message?',
      detail,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void performDelete(message),
        },
      ],
    );
  }, [performDelete]);

  const updateSendRoute = useCallback(async (sendConversationId: string | null) => {
    if (!conversation || conversation.provider !== 'merged' || updatingRoute) return;
    setUpdatingRoute(true);
    setLoadError(undefined);
    try {
      await setProfileSendOverride(conversation.id, sendConversationId);
      setConversation((current) => current ? {
        ...current,
        sendConversationId: sendConversationId ?? undefined,
        sendRoute: sendConversationId ? 'override' : 'most_frequent',
      } : current);
      setShowRouteSettings(false);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      if (mounted.current) setUpdatingRoute(false);
    }
  }, [conversation, updatingRoute]);

  const toggleMuted = useCallback(async () => {
    if (!conversationId || updatingMute) return;
    setUpdatingMute(true);
    setLoadError(undefined);
    try {
      await setConversationMuted(conversationId, !muted);
    } catch (error) {
      setLoadError(`Unable to ${muted ? 'unmute' : 'mute'} this conversation. ${errorMessage(error)}`);
    } finally {
      if (mounted.current) setUpdatingMute(false);
    }
  }, [conversationId, muted, updatingMute]);

  const confirmUnmerge = useCallback(() => {
    if (!conversation || conversation.provider !== 'merged') return;
    const performUnmerge = () => void deleteProfileMerge(conversation.id)
      .then(() => router.replace('/'))
      .catch((error) => setLoadError(errorMessage(error)));
    if (Platform.OS === 'web') {
      if (globalThis.confirm('Unmerge this profile?\n\nThe original direct messages will reappear separately. No messages will be deleted.')) {
        performUnmerge();
      }
      return;
    }
    Alert.alert(
      'Unmerge this profile?',
      'The original direct messages will reappear separately. No messages will be deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unmerge',
          style: 'destructive',
          onPress: performUnmerge,
        },
      ],
    );
  }, [conversation]);

  if (loading && !conversation) {
    return <SafeAreaView style={styles.safeArea}><View style={styles.centered}><ActivityIndicator color={ACCENT} /></View></SafeAreaView>;
  }

  if (!conversation) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.notFound}>
          <Text style={styles.notFoundTitle}>{loadError ? 'Unable to load conversation' : 'Conversation not found'}</Text>
          {loadError ? <Text style={styles.notFoundBody}>{loadError}</Text> : null}
          {loadError ? <Pressable onPress={() => void loadConversation()}><Text style={styles.backLink}>Try again</Text></Pressable> : null}
          <Pressable onPress={() => router.replace('/')}><Text style={styles.backLink}>Return to messages</Text></Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboardView}>
        <View style={[styles.page, width > 760 && styles.pageWide]}>
          <View style={styles.header}>
            <Pressable accessibilityLabel="Back to messages" hitSlop={10} onPress={() => router.back()} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={22} tintColor={INK} />
            </Pressable>

            <View style={styles.person}>
              <Avatar name={conversation.title} imageUrl={conversation.avatarUrl} size={42} />
              <View style={styles.personCopy}>
                <Text numberOfLines={1} style={styles.title}>{conversation.title}</Text>
                <View style={styles.subtitleRow}>
                  <View style={[styles.providerDot, { backgroundColor: providerColors[conversation.provider] }]} />
                  <Text numberOfLines={1} style={styles.subtitle}>{subtitle}{muted ? ' · Muted' : ''}</Text>
                </View>
              </View>
            </View>

            <View style={styles.headerActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={muted ? 'Unmute conversation' : 'Mute conversation'}
                accessibilityState={{ disabled: updatingMute, selected: muted }}
                disabled={updatingMute}
                hitSlop={6}
                onPress={() => void toggleMuted()}
                style={({ pressed }) => [styles.iconButton, muted && styles.muteButtonActive, pressed && styles.pressed]}>
                {updatingMute
                  ? <ActivityIndicator color={ACCENT} size="small" />
                  : <SymbolView
                      name={{ ios: muted ? 'bell.slash.fill' : 'bell', android: muted ? 'notifications_off' : 'notifications', web: muted ? 'notifications_off' : 'notifications' }}
                      size={20}
                      tintColor={muted ? ACCENT : INK}
                    />}
              </Pressable>
              <Pressable accessibilityLabel="Refresh messages" hitSlop={6} onPress={() => void refreshThread(true)} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                <SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} size={20} tintColor={INK} />
              </Pressable>
            </View>
          </View>

          {loadError ? (
            <Pressable onPress={() => void refreshThread(true)} style={styles.errorBanner}>
              <Text numberOfLines={2} style={styles.errorText}>{loadError}</Text>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}

          <FlatList
            contentContainerStyle={styles.thread}
            data={thread}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refreshThread(true)} tintColor={ACCENT} />}
            renderItem={({ item }) => (
              <MessageItem
                deleting={deletingMessageIds.has(item.id)}
                message={item}
                onDelete={confirmDelete}
                onReact={handleReaction}
                showProvider={conversation.provider === 'merged'}
              />
            )}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={thread.length ? <View style={styles.dayMarker}><View style={styles.dayRule} /><Text style={styles.dayText}>Recent</Text><View style={styles.dayRule} /></View> : null}
            ListEmptyComponent={<View style={styles.emptyThread}><Text style={styles.emptyThreadTitle}>Start the conversation</Text><Text style={styles.emptyThreadBody}>Messages sent here will go through {sendRouteLabel}.</Text></View>}
          />

          <View style={styles.composerShell}>
            {showRouteSettings && conversation.sources?.length ? (
              <View style={styles.routeSettings}>
                <View style={styles.routeSettingsHeader}>
                  <Text style={styles.routeSettingsTitle}>Send new messages through</Text>
                  {updatingRoute ? <ActivityIndicator color={ACCENT} size="small" /> : null}
                </View>
                <Pressable
                  disabled={updatingRoute}
                  onPress={() => void updateSendRoute(null)}
                  style={[styles.routeOption, !conversation.sendConversationId && styles.routeOptionSelected]}>
                  <Text style={styles.routeOptionTitle}>Automatic</Text>
                  <Text style={styles.routeOptionDetail}>Most frequented source</Text>
                </Pressable>
                {conversation.sources.map((source) => (
                  <Pressable
                    disabled={updatingRoute}
                    key={source.conversationId}
                    onPress={() => void updateSendRoute(source.conversationId)}
                    style={[styles.routeOption, conversation.sendConversationId === source.conversationId && styles.routeOptionSelected]}>
                    <View style={[styles.routeProviderDot, { backgroundColor: providerColors[source.provider] }]} />
                    <Text style={styles.routeOptionTitle}>{providerLabels[source.provider]}</Text>
                    <Text numberOfLines={1} style={styles.routeOptionDetail}>{source.title}</Text>
                  </Pressable>
                ))}
                <Pressable onPress={confirmUnmerge} style={styles.unmergeButton}>
                  <Text style={styles.unmergeText}>Unmerge profile</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.composer}>
              <TextInput
                accessibilityLabel="Message"
                editable={!sending}
                multiline
                onChangeText={setDraft}
                onSubmitEditing={() => void handleSend()}
                placeholder={`Message ${conversation.title}`}
                placeholderTextColor="#99948B"
                style={styles.input}
                value={draft}
              />
              <Pressable
                accessibilityLabel="Send message"
                disabled={!draft.trim() || sending}
                onPress={() => void handleSend()}
                style={({ pressed }) => [styles.sendButton, (!draft.trim() || sending) && styles.sendDisabled, pressed && draft.trim() && !sending ? styles.pressed : null]}>
                {sending
                  ? <ActivityIndicator color="#FFF9F2" size="small" />
                  : <SymbolView name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }} size={20} tintColor="#FFF9F2" />}
              </Pressable>
            </View>
            {conversation.provider === 'merged' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Change sending provider"
                onPress={() => setShowRouteSettings((current) => !current)}>
                <Text style={styles.providerNote}>Sending via {sendRouteLabel} · Change</Text>
              </Pressable>
            ) : <Text style={styles.providerNote}>Sending via {sendRouteLabel}</Text>}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PAPER },
  keyboardView: { flex: 1 },
  page: { flex: 1, width: '100%', alignSelf: 'center' },
  pageWide: { maxWidth: 680, borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#E3DED5' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { height: 72, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#DED9CF' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  muteButtonActive: { backgroundColor: '#EAD8D0' },
  pressed: { opacity: 0.58, transform: [{ scale: 0.96 }] },
  person: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', marginLeft: 4 },
  personCopy: { flex: 1, minWidth: 0, marginLeft: 11 },
  title: { color: INK, fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  providerDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  subtitle: { flex: 1, color: MUTED, fontSize: 12 },
  errorBanner: { marginHorizontal: 14, marginTop: 10, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 10, backgroundColor: '#F3DDD5', flexDirection: 'row', alignItems: 'center', gap: 10 },
  errorText: { flex: 1, color: '#733520', fontSize: 12, lineHeight: 17 },
  retryText: { color: '#733520', fontSize: 12, fontWeight: '800' },
  thread: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 22, flexGrow: 1 },
  dayMarker: { flexDirection: 'row', alignItems: 'center', marginVertical: 14 },
  dayRule: { flex: 1, height: 1, backgroundColor: '#E1DCD3' },
  dayText: { color: '#918C83', fontSize: 11, fontWeight: '700', marginHorizontal: 12, textTransform: 'uppercase', letterSpacing: 1 },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 20, paddingRight: 54 },
  messageRowMine: { justifyContent: 'flex-end', paddingRight: 0, paddingLeft: 54 },
  messageColumn: { alignItems: 'flex-start', marginLeft: 9, maxWidth: '100%' },
  messageColumnMine: { alignItems: 'flex-end', marginLeft: 0 },
  author: { color: MUTED, fontSize: 12, fontWeight: '700', marginLeft: 3, marginBottom: 5 },
  messageProvider: { color: '#9A6658', fontSize: 9, fontWeight: '800', letterSpacing: 0.7, marginLeft: 3, marginBottom: 4, textTransform: 'uppercase' },
  messageProviderMine: { marginRight: 3 },
  bubble: { maxWidth: '100%', paddingHorizontal: 14, paddingTop: 11, paddingBottom: 8, borderRadius: 17 },
  bubbleOther: { backgroundColor: '#E9E4DB', borderBottomLeftRadius: 5 },
  bubbleMine: { backgroundColor: '#A64730', borderBottomRightRadius: 5 },
  messageText: { color: INK, fontSize: 15, lineHeight: 21 },
  messageTextMine: { color: '#FFF9F2' },
  bubbleFooter: { minHeight: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'flex-end', gap: 7, marginTop: 5 },
  messageTime: { color: '#817C74', fontSize: 10 },
  messageTimeMine: { color: '#E8C5BB' },
  deleteButton: { width: 22, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  deleteButtonPressed: { backgroundColor: 'rgba(255,255,255,0.14)' },
  attachment: { minWidth: 220, flexDirection: 'row', alignItems: 'center', marginTop: 11, padding: 10, borderRadius: 11, backgroundColor: '#F6F1E8' },
  attachmentMine: { backgroundColor: 'rgba(255,255,255,0.12)' },
  attachmentText: { flex: 1, minWidth: 0, marginLeft: 9 },
  attachmentName: { color: INK, fontSize: 13, fontWeight: '700' },
  attachmentType: { color: MUTED, fontSize: 10, marginTop: 2 },
  attachmentTypeMine: { color: '#E8C5BB' },
  reactions: { flexDirection: 'row', gap: 5, marginTop: 5, marginLeft: 4 },
  reactionsMine: { justifyContent: 'flex-end', marginRight: 4 },
  reaction: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: '#D8D2C8', backgroundColor: '#FCF9F3' },
  reactionPressed: { backgroundColor: '#EAD8D0', borderColor: '#CDAE9F' },
  reactionText: { color: '#55514B', fontSize: 12, fontWeight: '600' },
  composerShell: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 9, borderTopWidth: 1, borderTopColor: '#DED9CF', backgroundColor: PAPER },
  routeSettings: { marginBottom: 10, padding: 10, borderWidth: 1, borderColor: '#D9D4CA', borderRadius: 15, backgroundColor: '#FFFCF7', gap: 5 },
  routeSettingsHeader: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  routeSettingsTitle: { color: INK, fontSize: 13, fontWeight: '800' },
  routeOption: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, borderRadius: 10 },
  routeOptionSelected: { backgroundColor: '#EAD8D0' },
  routeProviderDot: { width: 8, height: 8, borderRadius: 4 },
  routeOptionTitle: { color: INK, fontSize: 13, fontWeight: '700' },
  routeOptionDetail: { flex: 1, color: MUTED, fontSize: 11, textAlign: 'right' },
  unmergeButton: { minHeight: 36, alignItems: 'center', justifyContent: 'center', marginTop: 4, borderTopWidth: 1, borderTopColor: '#E5DFD5' },
  unmergeText: { color: ACCENT, fontSize: 12, fontWeight: '700' },
  composer: { minHeight: 50, flexDirection: 'row', alignItems: 'flex-end', padding: 5, borderRadius: 18, borderWidth: 1, borderColor: '#D9D4CA', backgroundColor: '#FFFCF7' },
  input: { flex: 1, maxHeight: 110, minHeight: 38, paddingHorizontal: 10, paddingTop: Platform.OS === 'ios' ? 9 : 7, color: INK, fontSize: 15, lineHeight: 20 },
  sendButton: { width: 38, height: 38, borderRadius: 13, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { backgroundColor: '#C8C2B9' },
  providerNote: { color: '#928D84', fontSize: 10, textAlign: 'center', marginTop: 6 },
  emptyThread: { flex: 1, minHeight: 260, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyThreadTitle: { color: INK, fontSize: 18, fontWeight: '700', marginBottom: 7 },
  emptyThreadBody: { color: MUTED, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  notFoundTitle: { color: INK, fontSize: 20, fontWeight: '700' },
  notFoundBody: { color: MUTED, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  backLink: { color: ACCENT, fontSize: 15, fontWeight: '700' },
});
