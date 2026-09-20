import { SymbolView } from 'expo-symbols';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
  errorMessage,
  getConversations,
  getMessages,
  sendMessage,
} from '@/services/api';
import type { Conversation, Message, SendMessageInput } from '@/types/messaging';

const INK = '#242320';
const MUTED = '#7B776F';
const PAPER = '#F6F3EC';
const ACCENT = '#B44D32';
const POLL_INTERVAL_MS = 5_000;

function messageTime(value: string) {
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function MessageItem({
  message,
  onReact,
}: {
  message: Message;
  onReact: (messageId: string, emoji: string) => void;
}) {
  const mine = message.author.id === currentUser.id || message.author.displayName === currentUser.displayName;

  return (
    <View style={[styles.messageRow, mine && styles.messageRowMine]}>
      {!mine ? <Avatar name={message.author.displayName} imageUrl={message.author.avatarUrl} size={34} /> : null}
      <View style={[styles.messageColumn, mine && styles.messageColumnMine]}>
        {!mine ? <Text style={styles.author}>{message.author.displayName}</Text> : null}
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

          <Text style={[styles.messageTime, mine && styles.messageTimeMine]}>
            {messageTime(message.sentAt)}{message.edited ? ' · edited' : ''}
          </Text>
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
  const [loadError, setLoadError] = useState<string>();
  const requestInFlight = useRef(false);
  const mounted = useRef(true);
  const { width } = useWindowDimensions();

  const refreshThread = useCallback(async (showRefresh = false) => {
    if (!conversationId || requestInFlight.current) return;
    requestInFlight.current = true;
    if (showRefresh) setRefreshing(true);
    try {
      const messages = await getMessages(conversationId);
      if (!mounted.current) return;
      setThread(messages);
      setLoadError(undefined);
    } catch (error) {
      if (mounted.current) setLoadError(errorMessage(error));
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
    setLoading(true);
    try {
      const [conversations, messages] = await Promise.all([getConversations(), getMessages(conversationId)]);
      if (!mounted.current) return;
      setConversation(conversations.find((item) => item.id === conversationId));
      setThread(messages);
      setLoadError(undefined);
    } catch (error) {
      if (mounted.current) setLoadError(errorMessage(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [conversationId]);

  useFocusEffect(useCallback(() => {
    mounted.current = true;
    const initialLoad = setTimeout(() => void loadConversation(), 0);
    const poller = setInterval(() => void refreshThread(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearTimeout(initialLoad);
      clearInterval(poller);
    };
  }, [loadConversation, refreshThread]));

  const subtitle = useMemo(() => conversation ? providerLabels[conversation.provider] : '', [conversation]);

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
      await addReaction(conversationId, messageId, emoji);
    } catch (error) {
      setLoadError(errorMessage(error));
      await refreshThread();
    }
  }, [conversationId, refreshThread]);

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
                  <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text>
                </View>
              </View>
            </View>

            <Pressable accessibilityLabel="Refresh messages" hitSlop={10} onPress={() => void refreshThread(true)} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} size={20} tintColor={INK} />
            </Pressable>
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
            renderItem={({ item }) => <MessageItem message={item} onReact={handleReaction} />}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={thread.length ? <View style={styles.dayMarker}><View style={styles.dayRule} /><Text style={styles.dayText}>Recent</Text><View style={styles.dayRule} /></View> : null}
            ListEmptyComponent={<View style={styles.emptyThread}><Text style={styles.emptyThreadTitle}>Start the conversation</Text><Text style={styles.emptyThreadBody}>Messages sent here will go through {providerLabels[conversation.provider]}.</Text></View>}
          />

          <View style={styles.composerShell}>
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
            <Text style={styles.providerNote}>Sending via {providerLabels[conversation.provider]}</Text>
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
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
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
  bubble: { maxWidth: '100%', paddingHorizontal: 14, paddingTop: 11, paddingBottom: 8, borderRadius: 17 },
  bubbleOther: { backgroundColor: '#E9E4DB', borderBottomLeftRadius: 5 },
  bubbleMine: { backgroundColor: '#A64730', borderBottomRightRadius: 5 },
  messageText: { color: INK, fontSize: 15, lineHeight: 21 },
  messageTextMine: { color: '#FFF9F2' },
  messageTime: { alignSelf: 'flex-end', color: '#817C74', fontSize: 10, marginTop: 6 },
  messageTimeMine: { color: '#E8C5BB' },
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
