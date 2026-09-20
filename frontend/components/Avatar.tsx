import { Image, StyleSheet, Text, View } from 'react-native';

interface AvatarProps {
  name: string;
  uri?: string;
  size?: number;
}

export function Avatar({ name, uri, size = 46 }: AvatarProps) {
  if (uri) {
    return <Image source={{ uri }} style={[styles.avatar, { width: size, height: size }]} />;
  }

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

  return (
    <View style={[styles.avatar, styles.fallback, { width: size, height: size }]}>
      <Text style={[styles.initials, { fontSize: size * 0.34 }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { borderRadius: 999 },
  fallback: { alignItems: 'center', backgroundColor: '#5865f2', justifyContent: 'center' },
  initials: { color: '#ffffff', fontWeight: '700' },
});
