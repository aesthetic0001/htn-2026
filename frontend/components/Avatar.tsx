import { Image, StyleSheet, Text, View } from 'react-native';

type AvatarProps = {
  name: string;
  imageUrl?: string;
  size?: number;
  muted?: boolean;
};

const avatarPalette = ['#D5E3CC', '#ECD0C0', '#C7DDE8', '#DED2E8', '#E9DDAE'];

function colorForName(name: string) {
  const value = [...name].reduce((total, character) => total + character.charCodeAt(0), 0);
  return avatarPalette[value % avatarPalette.length];
}

export function Avatar({ name, imageUrl, size = 48, muted = false }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: muted ? '#E7E2D8' : colorForName(name),
        },
      ]}>
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={styles.image} />
      ) : (
        <Text style={[styles.initials, { fontSize: size * 0.31 }]}>{initials}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  initials: {
    color: '#2C2A27',
    fontWeight: '700',
    letterSpacing: -0.5,
  },
});
