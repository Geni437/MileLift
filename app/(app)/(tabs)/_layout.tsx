import { Tabs } from 'expo-router';
import { Text } from 'react-native';

import { theme } from '../../../src/theme';

/**
 * Tab bar. Phase 1 adds the Activity tab (design doc §B: "Tabs become: Home
 * · Activity · Profile — three text labels, no new icon set" — Phase 0's
 * deliberate no-invented-icon-set discipline carries forward).
 */
export default function TabsLayout() {
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
        name="activity"
        options={{
          title: 'Activity',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Activity</Text>,
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
