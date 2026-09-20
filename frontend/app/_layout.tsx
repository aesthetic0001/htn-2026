import { useFonts } from 'expo-font';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: 'index',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

function RootLayoutNav() {
  return (
    <ThemeProvider
      value={{
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
          background: '#F6F3EC',
          card: '#F6F3EC',
          border: '#DED9CF',
          primary: '#B44D32',
          text: '#242320',
        },
      }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#F6F3EC' } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="conversation/[id]" />
      </Stack>
    </ThemeProvider>
  );
}
