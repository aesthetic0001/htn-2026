import { useCallback, useEffect, useRef, useState } from 'react';
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
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';

import { Avatar } from '@/components/Avatar';
import { api, errorMessage, type Message } from '@/lib/api';

const QUICK_REACTIONS = ['👍', '❤️', '😂'];

export default function ConversationScreen() {
  const params = useLocalSearchParams<{ conversationId: string; title?: string }>();
  const conversationId = firstParam(params.conversationId);
  const title = firstParam(params.title) || 'Conversation';
  const listRef = useRef<FlatList<Message>>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [reactingTo, setReactingTo] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async (refresh = false, quiet = false) => {
    if (!conversationId) return;
    if (refresh) setRefreshing(true);
    if (!quiet) setError(undefined);
    try {
      setMessages(await api.listMessages(conversationId));
    } catch (loadError) {
      if (!quiet) setError(errorMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [conversationId]);

  useEffect(() => {
    const initialLoad = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(false, true), 5_000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(timer);
    };
  }, [load]);

  const send = async () => {
    const content = draft.trim();
    if (!conversationId || !content || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const message = await api.sendMessage(conversationId, content);
      setMessages((current) => mergeMessage(current, message));
      setDraft('');
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setSending(false);
    }
  };

  const react = async (messageId: string, emoji: string) => {
    if (!conversationId || reactingTo) return;
    setReactingTo(messageId);
    setError(undefined);
    try {
      await api.addReaction(conversationId, messageId, emoji);
      await load(false, true);
    } catch (reactionError) {
      setError(errorMessage(reactionError));
    } finally {
      setReactingTo(undefined);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={88}
      style={styles.screen}
    >
      <Stack.Screen options={{ title }} />

      {error && (
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.retryText}>Tap to retry</Text>
        </Pressable>
      )}

      {loading && messages.length === 0 ? (
        <View style={styles.loader}><ActivityIndicator color="#5865f2" size="large" /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(message) => message.id}
          contentContainerStyle={[styles.messages, messages.length === 0 && styles.emptyMessages]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor="#5865f2" />}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={(
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No messages yet</Text>
              <Text style={styles.emptyText}>Start the conversation below.</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <View style={styles.message}>
              <Avatar name={item.author.displayName} uri={item.author.avatarUrl} size={36} />
              <View style={styles.messageBody}>
                <View style={styles.messageHeader}>
                  <Text style={styles.author}>{item.author.displayName}</Text>
                  <Text style={styles.time}>{formatTime(item.sentAt)}{item.edited ? ' · edited' : ''}</Text>
                </View>
                {!!item.content && <Text style={styles.messageText}>{item.content}</Text>}

                {item.attachments.map((attachment) => (
                  <Pressable
                    accessibilityRole="link"
                    key={attachment.url}
                    onPress={() => void Linking.openURL(attachment.url)}
                    style={({ pressed }) => [styles.attachment, pressed && styles.pressed]}
                  >
                    <Text numberOfLines={1} style={styles.attachmentText}>↗ {attachment.name}</Text>
                  </Pressable>
                ))}

                <View style={styles.reactionRow}>
                  {item.reactions.map((reaction, index) => (
                    <Pressable
                      accessibilityLabel={`React with ${reaction.emoji}`}
                      accessibilityRole="button"
                      key={`${reaction.emoji}-${index}`}
                      onPress={() => void react(item.id, reaction.emoji)}
                      style={styles.reaction}
                    >
                      <Text style={styles.reactionText}>{reaction.emoji}{reaction.count ? ` ${reaction.count}` : ''}</Text>
                    </Pressable>
                  ))}
                  {QUICK_REACTIONS.map((emoji) => (
                    <Pressable
                      accessibilityLabel={`React with ${emoji}`}
                      accessibilityRole="button"
                      disabled={!!reactingTo}
                      key={emoji}
                      onPress={() => void react(item.id, emoji)}
                      style={({ pressed }) => [styles.quickReaction, pressed && styles.pressed]}
                    >
                      {reactingTo === item.id
                        ? <ActivityIndicator color="#747c8e" size="small" />
                        : <Text style={styles.quickReactionText}>{emoji}</Text>}
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          )}
        />
      )}

      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Message"
          maxLength={2000}
          multiline
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor="#9299a8"
          style={styles.input}
          value={draft}
        />
        <Pressable
          accessibilityLabel="Send message"
          accessibilityRole="button"
          disabled={!draft.trim() || sending}
          onPress={() => void send()}
          style={({ pressed }) => [
            styles.sendButton,
            (!draft.trim() || sending) && styles.sendDisabled,
            pressed && styles.pressed,
          ]}
        >
          {sending ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.sendText}>↑</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function mergeMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((current) => current.id === message.id);
  if (index === -1) return [...messages, message];
  return messages.map((current) => current.id === message.id ? message : current);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#f7f8fc', flex: 1 },
  loader: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  messages: { paddingHorizontal: 16, paddingVertical: 18 },
  emptyMessages: { flexGrow: 1 },
  empty: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  emptyTitle: { color: '#283044', fontSize: 18, fontWeight: '800' },
  emptyText: { color: '#747c8e', fontSize: 14, marginTop: 6 },
  message: { alignItems: 'flex-start', flexDirection: 'row', marginBottom: 20 },
  messageBody: { flex: 1, marginLeft: 10 },
  messageHeader: { alignItems: 'baseline', flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  author: { color: '#252d40', fontSize: 14, fontWeight: '800' },
  time: { color: '#8b92a0', fontSize: 11 },
  messageText: { color: '#30384b', fontSize: 15, lineHeight: 21, marginTop: 3 },
  attachment: { alignSelf: 'flex-start', backgroundColor: '#e9ebf4', borderRadius: 8, marginTop: 7, maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 7 },
  attachmentText: { color: '#4b56c0', fontSize: 13, fontWeight: '600' },
  reactionRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 7 },
  reaction: { backgroundColor: '#e5e8ff', borderColor: '#cbd0ff', borderRadius: 10, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3 },
  reactionText: { color: '#424b94', fontSize: 12 },
  quickReaction: { alignItems: 'center', backgroundColor: '#edeef3', borderRadius: 10, height: 26, justifyContent: 'center', width: 30 },
  quickReactionText: { fontSize: 13 },
  composer: { alignItems: 'flex-end', backgroundColor: '#fff', borderTopColor: '#e5e7ed', borderTopWidth: 1, flexDirection: 'row', gap: 9, paddingHorizontal: 12, paddingVertical: 10 },
  input: { backgroundColor: '#f0f1f5', borderRadius: 18, color: '#242c3f', flex: 1, fontSize: 15, maxHeight: 120, minHeight: 42, paddingHorizontal: 15, paddingVertical: 10 },
  sendButton: { alignItems: 'center', backgroundColor: '#5865f2', borderRadius: 21, height: 42, justifyContent: 'center', width: 42 },
  sendDisabled: { backgroundColor: '#b9becc' },
  sendText: { color: '#fff', fontSize: 24, fontWeight: '800', lineHeight: 26 },
  pressed: { opacity: 0.7 },
  errorBanner: { backgroundColor: '#fff0f1', borderBottomColor: '#f5ced3', borderBottomWidth: 1, paddingHorizontal: 14, paddingVertical: 10 },
  errorText: { color: '#a83342', fontSize: 12, lineHeight: 17 },
  retryText: { color: '#8b2533', fontSize: 11, fontWeight: '800', marginTop: 2 },
});
