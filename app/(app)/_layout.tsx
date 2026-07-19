import { Tabs } from 'expo-router';
import { Text } from 'react-native';

import { theme } from '../../src/theme';

/**
 * App shell tab bar. Phase 0 scope is just Home (placeholder — Activity/
 * Nutrition/Strength are Phase 1-3) and Profile. No icon set is defined in
 * docs/design/ yet, so tabs use text labels only rather than mobile-builder
 * inventing icon glyphs outside the design system.
 */
export default function AppLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.accent.primary,
        tabBarInactiveTintColor: theme.color.text.tertiary,
        tabBarStyle: {
          backgroundColor: theme.color.bg.surface,
          borderTopColor: theme.color.border.subtle,
        },
        tabBarLabelStyle: { ...theme.type.label },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Home</Text>,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Profile</Text>,
        }}
      />
    </Tabs>
  );
}
