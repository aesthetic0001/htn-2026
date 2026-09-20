import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { API_URL, api, errorMessage, type ProviderStatus } from '@/lib/api';

export default function ConnectionsScreen() {
  const [provider, setProvider] = useState<ProviderStatus>();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const providers = await api.listProviders();
      setProvider(providers.find((item) => item.name === 'discord'));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  useEffect(() => {
    if (provider?.state !== 'connecting') return;
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [load, provider?.state]);

  const connect = async () => {
    setConnecting(true);
    setError(undefined);
    try {
      setProvider(await api.connectDiscord());
    } catch (connectError) {
      setError(errorMessage(connectError));
      await load();
    } finally {
      setConnecting(false);
    }
  };

  const state = provider?.state || 'disconnected';
  const online = state === 'connected';

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text style={styles.eyebrow}>PROVIDENCE</Text>
      <Text style={styles.title}>Connections</Text>
      <Text style={styles.subtitle}>Services that deliver messages to your unified inbox.</Text>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.discordLogo}><Text style={styles.discordLogoText}>D</Text></View>
          <View style={styles.providerInfo}>
            <Text style={styles.providerName}>Discord</Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, online && styles.online, state === 'error' && styles.failed]} />
              <Text style={styles.statusText}>{formatState(state)}</Text>
            </View>
          </View>
          {loading && <ActivityIndicator color="#5865f2" />}
        </View>

        {provider?.detail && <Text style={styles.detail}>{provider.detail}</Text>}
        {error && <Text style={styles.error}>{error}</Text>}

        {!online && (
          <Pressable
            accessibilityRole="button"
            disabled={connecting || state === 'connecting'}
            onPress={() => void connect()}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            {(connecting || state === 'connecting') && <ActivityIndicator color="#fff" size="small" />}
            <Text style={styles.buttonText}>
              {connecting || state === 'connecting' ? 'Connecting…' : state === 'error' ? 'Try again' : 'Connect'}
            </Text>
          </Pressable>
        )}
      </View>

      <View style={styles.apiCard}>
        <Text style={styles.apiLabel}>BACKEND ADDRESS</Text>
        <Text selectable style={styles.apiUrl}>{API_URL}</Text>
        <Text style={styles.apiHelp}>
          Set EXPO_PUBLIC_API_URL before starting Expo when using a physical device or remote backend.
        </Text>
      </View>
    </ScrollView>
  );
}

function formatState(state: ProviderStatus['state']): string {
  if (state === 'connected') return 'Connected';
  if (state === 'connecting') return 'Connecting';
  if (state === 'error') return 'Needs attention';
  return 'Not connected';
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#f7f8fc' },
  content: { flexGrow: 1, padding: 20, paddingTop: 24 },
  eyebrow: { color: '#5865f2', fontSize: 11, fontWeight: '800', letterSpacing: 1.8 },
  title: { color: '#182033', fontSize: 30, fontWeight: '800', letterSpacing: -0.8, marginTop: 2 },
  subtitle: { color: '#6f7789', fontSize: 15, lineHeight: 22, marginBottom: 24, marginTop: 6 },
  card: { backgroundColor: '#fff', borderRadius: 18, padding: 18 },
  cardHeader: { alignItems: 'center', flexDirection: 'row' },
  discordLogo: { alignItems: 'center', backgroundColor: '#5865f2', borderRadius: 14, height: 50, justifyContent: 'center', width: 50 },
  discordLogoText: { color: '#fff', fontSize: 22, fontWeight: '900' },
  providerInfo: { flex: 1, marginLeft: 14 },
  providerName: { color: '#20283a', fontSize: 18, fontWeight: '800' },
  statusRow: { alignItems: 'center', flexDirection: 'row', marginTop: 5 },
  statusDot: { backgroundColor: '#afb5c1', borderRadius: 5, height: 9, marginRight: 7, width: 9 },
  online: { backgroundColor: '#35b56a' },
  failed: { backgroundColor: '#d85565' },
  statusText: { color: '#6f7789', fontSize: 13, fontWeight: '600' },
  detail: { backgroundColor: '#f4f5fa', borderRadius: 10, color: '#5d6575', fontSize: 13, lineHeight: 19, marginTop: 16, padding: 12 },
  error: { color: '#a83342', fontSize: 13, lineHeight: 19, marginTop: 14 },
  button: { alignItems: 'center', backgroundColor: '#5865f2', borderRadius: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 18, paddingVertical: 13 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.75 },
  apiCard: { backgroundColor: '#eef0f7', borderRadius: 14, marginTop: 18, padding: 16 },
  apiLabel: { color: '#7b8291', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  apiUrl: { color: '#343c50', fontFamily: 'SpaceMono', fontSize: 12, marginTop: 8 },
  apiHelp: { color: '#747c8e', fontSize: 12, lineHeight: 18, marginTop: 10 },
});
