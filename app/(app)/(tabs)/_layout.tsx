import { Tabs } from 'expo-router';
import { Text } from 'react-native';

import { theme } from '../../../src/theme';

/**
 * Tab bar. Phase 1 added Activity; Phase 2 adds Lift (screens-phase-2.md §B:
 * "Tabs become: Home · Activity · Lift · Profile — four text labels, no new
 * icon set" — the discipline carries forward again. "Lift" is kept as the
 * brand's own word rather than renaming "Activity" for symmetry, per that
 * doc's §Decisions item 2.
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
        name="lift"
        options={{
          title: 'Lift',
          tabBarLabel: ({ color }) => <Text style={{ color, ...theme.type.label }}>Lift</Text>,
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
