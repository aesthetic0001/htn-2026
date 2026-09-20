import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useClientOnlyValue } from '@/components/useClientOnlyValue';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme].tint,
        // Disable the static render of the header on web
        // to prevent a hydration error in React Navigation v6.
        headerShown: useClientOnlyValue(false, true),
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Messages',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{
                ios: 'bubble.left.and.bubble.right.fill',
                android: 'chat',
                web: 'chat',
              }}
              tintColor={color}
              size={28}
            />
          ),
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="two"
        options={{
          title: 'Connections',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{
                ios: 'link',
                android: 'link',
                web: 'link',
              }}
              tintColor={color}
              size={28}
            />
          ),
          headerShown: false,
        }}
      />
    </Tabs>
  );
}
