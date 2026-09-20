import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { Avatar } from '@/components/Avatar';
import { api, type Conversation, errorMessage, type ProviderStatus } from '@/lib/api';

export default function ConversationsScreen() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [provider, setProvider] = useState<ProviderStatus>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (refresh = false, quiet = false) => {
    if (refresh) setRefreshing(true);
    if (!refresh && !quiet) setLoading(true);
    if (!quiet) setError(undefined);
    try {
      const providers = await api.listProviders();
      const discord = providers.find((item) => item.name === 'discord');
      setProvider(discord);
      if (discord?.state === 'connected') {
        setConversations(await api.listConversations());
      } else {
        setConversations([]);
      }
    } catch (loadError) {
      if (!quiet) setError(errorMessage(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  useEffect(() => {
    const timer = setInterval(() => void load(false, true), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const connect = async () => {
    setConnecting(true);
    setError(undefined);
    try {
      setProvider(await api.connectDiscord());
      await load();
    } catch (connectError) {
      setError(errorMessage(connectError));
    } finally {
      setConnecting(false);
    }
  };

  const empty = !loading ? (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}><Text style={styles.emptyIconText}>P</Text></View>
      <Text style={styles.emptyTitle}>
        {provider?.state === 'connected' ? 'No conversations found' : 'Connect your messages'}
      </Text>
      <Text style={styles.emptyText}>
        {provider?.state === 'connected'
          ? 'Pull down to ask Discord for your direct messages again.'
          : provider?.detail || 'Connect Discord to bring your conversations into one inbox.'}
      </Text>
      {provider?.state !== 'connected' && (
        <Pressable
          accessibilityRole="button"
          disabled={connecting || provider?.state === 'connecting'}
          onPress={() => void connect()}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          {(connecting || provider?.state === 'connecting') && <ActivityIndicator color="#fff" size="small" />}
          <Text style={styles.primaryButtonText}>
            {connecting || provider?.state === 'connecting' ? 'Connecting…' : 'Connect Discord'}
          </Text>
        </Pressable>
      )}
    </View>
  ) : null;

  return (
    <View style={styles.screen}>
      <View style={styles.heading}>
        <View>
          <Text style={styles.eyebrow}>PROVIDENCE</Text>
          <Text style={styles.title}>Messages</Text>
        </View>
        <View style={[styles.statusDot, provider?.state === 'connected' && styles.statusOnline]} />
      </View>

      {error && (
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.retryText}>Tap to retry</Text>
        </Pressable>
      )}

      {loading && conversations.length === 0 ? (
        <View style={styles.loader}><ActivityIndicator color="#5865f2" size="large" /></View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, conversations.length === 0 && styles.emptyList]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor="#5865f2" />}
          ListEmptyComponent={empty}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({
                pathname: '/conversation/[conversationId]',
                params: { conversationId: item.id, title: item.title },
              })}
              style={({ pressed }) => [styles.conversation, pressed && styles.conversationPressed]}
            >
              <Avatar name={item.title} uri={item.avatarUrl} />
              <View style={styles.conversationText}>
                <Text numberOfLines={1} style={[styles.conversationTitle, item.unread && styles.unreadTitle]}>
                  {item.title}
                </Text>
                <Text style={styles.conversationMeta}>
                  Discord · {item.kind === 'group' ? 'Group' : 'Direct message'}
                </Text>
              </View>
              {item.unread && <View style={styles.unreadDot} />}
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f8fc' },
  heading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 14, paddingTop: 12 },
  eyebrow: { color: '#5865f2', fontSize: 11, fontWeight: '800', letterSpacing: 1.8 },
  title: { color: '#182033', fontSize: 30, fontWeight: '800', letterSpacing: -0.8, marginTop: 2 },
  statusDot: { backgroundColor: '#b7bdc9', borderRadius: 7, height: 14, width: 14 },
  statusOnline: { backgroundColor: '#35b56a' },
  list: { paddingHorizontal: 14, paddingBottom: 24 },
  emptyList: { flexGrow: 1 },
  conversation: { alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 16, flexDirection: 'row', marginBottom: 9, padding: 13 },
  conversationPressed: { opacity: 0.65 },
  conversationText: { flex: 1, marginLeft: 13 },
  conversationTitle: { color: '#222a3d', fontSize: 16, fontWeight: '600' },
  unreadTitle: { fontWeight: '800' },
  conversationMeta: { color: '#747c8e', fontSize: 13, marginTop: 4 },
  unreadDot: { backgroundColor: '#5865f2', borderRadius: 5, height: 9, marginRight: 8, width: 9 },
  chevron: { color: '#a3a9b6', fontSize: 28, lineHeight: 30 },
  loader: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 30 },
  emptyIcon: { alignItems: 'center', backgroundColor: '#e7e9ff', borderRadius: 28, height: 56, justifyContent: 'center', marginBottom: 18, width: 56 },
  emptyIconText: { color: '#5865f2', fontSize: 25, fontWeight: '900' },
  emptyTitle: { color: '#20283a', fontSize: 20, fontWeight: '800', textAlign: 'center' },
  emptyText: { color: '#6f7789', fontSize: 14, lineHeight: 21, marginTop: 8, maxWidth: 330, textAlign: 'center' },
  primaryButton: { alignItems: 'center', backgroundColor: '#5865f2', borderRadius: 12, flexDirection: 'row', gap: 8, marginTop: 20, paddingHorizontal: 20, paddingVertical: 13 },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.75 },
  errorBanner: { backgroundColor: '#fff0f1', marginHorizontal: 14, marginBottom: 10, borderRadius: 12, padding: 12 },
  errorText: { color: '#a83342', fontSize: 13, lineHeight: 18 },
  retryText: { color: '#8b2533', fontSize: 12, fontWeight: '800', marginTop: 4 },
});
